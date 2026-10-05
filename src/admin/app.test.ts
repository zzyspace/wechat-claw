import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { after, test } from "node:test";

import { listScenarioExtractionsByRawMessageId } from "../core/scenarios/scenario-extraction-repository.js";
import { deleteReimbursementReport, getAdminReimbursementReportDetail, saveReimbursementReceiptDelivery, saveReimbursementReport } from "../scenarios/reimbursement/repository.js";
import type { ReimbursementExtractor } from "../scenarios/reimbursement/batch-import.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";
import { createApp } from "./app.js";
import type { GatewayAuthConfig } from "./gateway-auth.js";
import { getDatabase } from "../core/storage/database.js";

test("reimbursement nginx keeps shortcut Bearer auth public and protects admin routes", () => {
  const nginx = fs.readFileSync(
    path.resolve(process.cwd(), "deploy/nginx/reimbursement-admin.locations.conf"),
    "utf8",
  );
  const shortcutIndex = nginx.indexOf("location = /expense/api/shortcut/reports");
  const protectedApiIndex = nginx.indexOf("location ^~ /expense/api/");
  assert.ok(shortcutIndex >= 0);
  assert.ok(protectedApiIndex > shortcutIndex);
  assert.match(
    nginx,
    /location \^~ \/expense\/api\/ \{[\s\S]*?admin-auth-reimbursement\.inc;/,
  );
  assert.match(
    nginx,
    /location = \/expense \{[\s\S]*?admin-auth-reimbursement\.inc;/,
  );
  assert.match(
    nginx,
    /location = \/expense\/submit \{[\s\S]*?admin-auth-reimbursement\.inc;/,
  );
  assert.doesNotMatch(nginx, /submit_(fuzzy|peanut|fuzzyqz)/);
});

test("wechat-claw deployment leaves the shared Nginx entry to server-infra", () => {
  const deployScript = fs.readFileSync(
    path.resolve(process.cwd(), "deploy/deploy-wechat-claw.sh"),
    "utf8",
  );
  assert.doesNotMatch(deployScript, /\/etc\/nginx\/sites-(available|enabled)/);
  assert.doesNotMatch(deployScript, /\/etc\/nginx\/snippets/);
  assert.doesNotMatch(deployScript, /\bnginx -t\b/);
  assert.doesNotMatch(deployScript, /systemctl reload nginx/);
});

test("reimbursement admin exposes a POST logout action", () => {
  const html = fs.readFileSync(
    path.resolve(process.cwd(), "src/admin/public/admin.html"),
    "utf8",
  );
  assert.match(html, /<form method="post" action="\/logout">/);
  assert.match(html, /name="returnTo" value="\/expense"/);
});

test("admin deletion controls preserve legacy access and honor each report capability", async () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "src/admin/public/admin.html"), "utf8");
  const loadSession = html.slice(html.indexOf("      async function loadSession()"), html.indexOf("      async function loadManualImportOptions()"));
  const canDeleteItem = html.slice(html.indexOf("      function canDeleteItem("), html.indexOf("      function renderTable()"));
  for (const [permissions, expected] of [
    [{ canWrite: true }, true],
    [{ canWrite: false }, false],
    [{ canWrite: true, canEdit: true, canDelete: false, canDeleteSelf: false }, false],
    [{ canWrite: true, canDelete: false, canDeleteSelf: true }, true],
    [{ canDelete: true, canDeleteSelf: false }, true],
  ] as const) {
    const state = { canDelete: false };
    const context = {
      state, BASE_PATH: "/expense", buildAuthFetchUrl: (url: string) => url,
      fetch: async () => ({ ok: true, json: async () => ({ success: true, permissions, account: { role: "admin" } }) }),
      document: { getElementById: () => ({ hidden: false }) },
      configureReportFiltersForAccount: () => {}, loadAuthorizedCenters: async () => {},
      elements: {
        centerSwitcherTrigger: { disabled: true }, centerSwitcherChevron: { toggleAttribute: () => {} },
        operationColumnHeader: {}, accessPill: {}, manualImportOpen: {}, batchImportOpen: {},
      },
    };
    await runInNewContext(`${loadSession}\nloadSession()`, context);
    assert.equal(state.canDelete, expected);
    for (const capability of [true, false, undefined]) {
      assert.equal(runInNewContext(`${canDeleteItem}\ncanDeleteItem(item)`, {
        state, item: capability === undefined ? {} : { permissions: { canDelete: capability } },
      }), expected && capability === true);
    }
  }
});

test("mobile report actions honor capabilities and preserve escaped data, currency, and local time", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "src/admin/public/admin.html"), "utf8");
  const source = [
    html.slice(html.indexOf("      function escapeHtml("), html.indexOf("      const REPORTER_TAG_CLASS_NAMES")),
    html.slice(html.indexOf("      function renderStoreCell("), html.indexOf("      function renderBillAttachment(")),
    html.slice(html.indexOf("      const MOBILE_REPORT_ICONS"), html.indexOf("      function renderTable()")),
  ].join("\n");
  const item = {
    id: 72, reporter: '<img src=x onerror="alert(1)">', channelName: "Fuzzy <test>",
    amount: 1234.5, currency: "USD", expenseCategory: "food", expenseCategoryLabel: "食材",
    note: "农 <script>alert(1)</script>", createdAt: "2026-09-25 16:30:00", needsReview: true,
    billAttachment: { id: 9, exists: true }, permissions: { canDelete: false },
  };
  const render = (permissions: { canEdit: boolean; canDelete: boolean; canAttachment: boolean }, record: object) => runInNewContext(`${source}\nrenderMobileReport(item)`, {
    state: { ...permissions, selectedReportId: null, deletingIds: new Set(), timeZone: "Asia/Shanghai" },
    item: record, DEFAULT_TIME_ZONE: "Asia/Shanghai", STORE_LABELS_BY_CHANNEL_CODE: new Map(),
  }) as string;

  for (const [canEdit, canDelete, canAttachment, recordCanDelete] of [
    [false, false, false, true],
    [true, true, true, false],
    [true, true, true, true],
    [false, true, true, true],
    [false, true, true, undefined],
  ] as const) {
    const result = render({ canEdit, canDelete, canAttachment }, { ...item, permissions: { canDelete: recordCanDelete } });
    assert.equal(result.includes('data-edit-id="72"'), canEdit);
    assert.equal(result.includes('data-delete-id="72"'), canDelete && recordCanDelete === true);
    assert.equal(result.includes('data-attachment-preview-report-id="72"'), canAttachment);
    assert.doesNotMatch(result, /<img\b|<script\b/);
    assert.match(result, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(result, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(result, /09\/26 00:30/);
    assert.match(result, /1,234\.50/);
    assert.match(result, /<small>USD<\/small>/);
    assert.doesNotMatch(result, /¥|#72/);
  }

  const permissions = { canEdit: false, canDelete: false, canAttachment: true };
  assert.doesNotMatch(render(permissions, { ...item, billAttachment: { id: 9, exists: false } }), /data-attachment-preview-report-id/);
  assert.match(render(permissions, { ...item, billAttachment: undefined }), /无附件/);
  assert.match(render(permissions, { ...item, amount: null }), /is-missing">待复核/);
  assert.match(render(permissions, { ...item, amount: 0, currency: "CNY" }), /<small>¥<\/small><span class="mobile-report-amount-value">0\.00/);
});

test("detail presentation preserves fields and honors attachment and edit permissions", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "src/admin/public/admin.html"), "utf8");
  const source = [
    html.slice(html.indexOf("      function escapeHtml("), html.indexOf("      const REPORTER_TAG_CLASS_NAMES")),
    html.slice(html.indexOf("      function renderStoreCell("), html.indexOf("      function renderBillAttachment(")),
    html.slice(html.indexOf("      function renderAmountCell("), html.indexOf("      function setStatus(")),
    html.slice(html.indexOf("      function desktopReportIcon("), html.indexOf("      function canDeleteItem(")),
    html.slice(html.indexOf("      function renderDetail("), html.indexOf("      async function loadDetail(")),
  ].join("\n");
  const report = {
    id: 72, permissions: { canDelete: false }, reporter: '<img src=x onerror="alert(1)">', channelName: "Fuzzy", channelCode: "reimbursement_fuzzy",
    amount: 1234.5, currency: "USD", expenseCategory: "food", expenseCategoryLabel: "食材",
    note: "农 <script>note</script>", ocrText: "OCR <script>ocr</script>", needsReview: true,
    merchant: "测试商户", documentNo: "document-72", voucherType: "receipt", confidence: 0.98,
    voucherDate: "2026-09-26", voucherDateSource: "explicit", evidenceType: "receipt_image",
    createdAt: "2026-09-25 16:30:00", updatedAt: "2026-09-25 17:30:00",
    sources: [{ role: "original", rawMessageId: 3, messageExternalId: "message-72", senderName: "示例报账人", textContent: "来源消息 <script>source</script>", eventReceivedAt: "2026-09-25 16:30:00", attachments: [
      { id: 9, mimeType: "image/png", exists: true }, { id: 10, mimeType: "application/pdf", exists: true }, { id: 11, mimeType: "image/jpeg", exists: false },
    ] }],
    receiptDeliveries: [{ id: 6, rawMessageId: 3, targetType: "room", targetValue: "示例接收群", receiptText: "回执 <script>receipt</script>", sentAt: "2026-09-25 17:30:00" }],
  };
  for (const canAttachment of [false, true]) {
    for (const canEdit of [false, true]) {
      for (const [canDelete, recordDelete] of [[false,true],[true,false],[true,true]] as const) {
      report.permissions.canDelete = recordDelete;
      const elements = { detailEmpty: { hidden: false }, detailContent: { hidden: true, innerHTML: "" }, detailModalTitle: { textContent: "" } };
      runInNewContext(`${source}\nrenderDetail(report)`, {
        report, elements, state: { canAttachment, canEdit, canDelete, timeZone: "Asia/Shanghai" },
        BASE_PATH: "/expense", DEFAULT_TIME_ZONE: "Asia/Shanghai", STORE_LABELS_BY_CHANNEL_CODE: new Map(),
      });
      const markup = elements.detailContent.innerHTML;
      const sharedSource = fs.readFileSync(path.resolve(process.cwd(), "dist/admin/public/monthly/report-detail.js"), "utf8");
      const sharedMarkup = runInNewContext(`${sharedSource}\nwindow.ExpenseReportDetail.render(report, options)`, {
        window: {}, report, options: { canAttachment, canEdit, canDelete, timeZone: "Asia/Shanghai" },
      });
      assert.equal(sharedMarkup, markup, "Monthly source details must match the canonical admin template");
      assert.equal(markup.includes("data-detail-edit"), canEdit);
      assert.equal(markup.includes("data-detail-delete"), canDelete && recordDelete);
      assert.equal(markup.includes("/expense/api/attachments/9/content"), canAttachment);
      assert.equal(markup.includes("/expense/api/attachments/10/content"), canAttachment);
      assert.doesNotMatch(markup, /\/attachments\/11\/content|<script\b|<img src=x/);
      if (canAttachment) assert.match(markup, /查看附件 \(2\)/);
      else assert.doesNotMatch(markup, /<img\b|class="attachment-link/);
      for (const value of ["USD", "document-72", "explicit", "receipt_image", "0.98", "message-72", "示例接收群", "&lt;script&gt;note&lt;/script&gt;", "&lt;script&gt;ocr&lt;/script&gt;", "&lt;script&gt;source&lt;/script&gt;", "&lt;script&gt;receipt&lt;/script&gt;"]) {
        assert.ok(markup.includes(value), `Missing detail value: ${value}`);
      }
      assert.equal(elements.detailModalTitle.textContent, "报账 #72");
      }
    }
  }
});

test("date range calendar rejects invalid dates and uses the business timezone", () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), "src/admin/public/admin.html"), "utf8");
  const source = html.slice(html.indexOf("      function normalizedRangeDate("), html.indexOf("      function dateRangeCaption("));
  const calendar = runInNewContext(`${source}\n({ normalizedRangeDate, rangeCalendarDay, rangeBusinessToday, defaultCreatedDateRange })`, {
    state: { timeZone: "Asia/Shanghai" }, DEFAULT_TIME_ZONE: "Asia/Shanghai",
  });
  assert.equal(calendar.normalizedRangeDate("2024-02-29"), "2024-02-29");
  assert.equal(calendar.normalizedRangeDate("0001-01-01"), "0001-01-01");
  for (const value of ["2026-02-29", "2100-02-29", "2026-04-31", "0000-01-01", "2026-9-1", '<script>']) {
    assert.equal(calendar.normalizedRangeDate(value), "");
  }
  assert.equal(calendar.rangeCalendarDay(2024, 2, 0).toISOString().slice(0, 10), "2024-02-29");
  assert.equal(calendar.rangeCalendarDay(2026, 0, 0).toISOString().slice(0, 10), "2025-12-31");
  assert.equal(calendar.rangeBusinessToday(new Date("2026-09-26T16:30:00Z")), "2026-09-27");
  const monthToDate = calendar.defaultCreatedDateRange(new Date("2026-09-26T16:30:00Z"));
  assert.equal(monthToDate.from, "2026-09-01");
  assert.equal(monthToDate.to, "2026-09-27");
  const nextMonth = calendar.defaultCreatedDateRange(new Date("2026-09-30T16:30:00Z"));
  assert.equal(nextMonth.from, "2026-10-01");
  assert.equal(nextMonth.to, "2026-10-01");
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-admin-"));
const managedEnvKeys = [
  "WECHATY_ADMIN_HOST",
  "WECHATY_ADMIN_PASSWORD",
  "WECHATY_ADMIN_PORT",
  "WECHATY_ADMIN_USERNAME",
  "WECHATY_REIMBURSEMENT_ACCOUNTS_JSON",
  "WECHATY_ADMIN_GUEST_PASSWORD",
  "WECHATY_ADMIN_GUEST_USERNAME",
  "WECHATY_CHANNELS_JSON",
  "WECHATY_PUPPET",
  "WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY",
  "WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER",
  "WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN",
  "WECHATY_STATE_DIR",
  "WECHATY_TIMEZONE",
];

function applyEnv(values: Record<string, string | undefined>) {
  for (const key of managedEnvKeys) {
    delete process.env[key];
  }

  process.env.WECHATY_PUPPET = "wechaty-puppet-wechat";
  process.env.WECHATY_STATE_DIR = stateDir;
  process.env.WECHATY_TIMEZONE = "Asia/Shanghai";
  process.env.WECHATY_ADMIN_HOST = "127.0.0.1";
  process.env.WECHATY_ADMIN_PORT = "8788";
  process.env.WECHATY_CHANNELS_JSON = JSON.stringify([
    {
      code: "reimbursement_admin_test",
      enabled: true,
      scenario: "reimbursement",
      match: { type: "room_topic", value: "报账后台测试群" },
      deliveryTargets: [],
      summarySchedule: "",
    },
    ...[
      ["reimbursement_fuzzy", "Fuzzy报账群"],
      ["reimbursement_peanut", "Peanut报账群"],
      ["reimbursement_fuzzyqz", "Fuzzy泉州报账群"],
      ["reimbursement_fuzzy_manager", "Fuzzy店长报账群"],
      ["reimbursement_peanut_manager", "Peanut店长报账群"],
      ["reimbursement_fuzzy_qz_manager", "Fuzzy泉州店长报账群"],
    ].map(([code, value]) => ({
      code,
      enabled: true,
      scenario: "reimbursement",
      match: { type: "room_topic", value },
      deliveryTargets: [],
      summarySchedule: "",
    })),
    {
      code: "loss_admin_test",
      enabled: true,
      scenario: "loss-report",
      match: { type: "room_topic", value: "报损后台测试群" },
      deliveryTargets: [],
      summarySchedule: "",
    },
  ]);

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createAdminAuthHeaders(username = "admin", password = "secret-pass") {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

async function startServer(reimbursementExtractor?: ReimbursementExtractor, gatewayAuth?: GatewayAuthConfig) {
  const app = createApp({ reimbursementExtractor, gatewayAuth });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve reimbursement admin test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

function createShortcutForm(input?: {
  channelCode?: string;
  image?: string;
  note?: string;
  reporter?: string;
}) {
  const form = new FormData();
  form.set("channelCode", input?.channelCode ?? "reimbursement_admin_test");
  form.set("reporter", input?.reporter ?? "张三");
  form.set("note", input?.note ?? "午餐采购");
  form.set(
    "image",
    new Blob([input?.image ?? "shortcut-image"], { type: "image/png" }),
    "screenshot.png",
  );
  return form;
}

function createShortcutTestExtractor(onCall: () => void): ReimbursementExtractor {
  return async (input) => {
    onCall();
    return {
      scenarioCode: "reimbursement",
      extractorCode: "shortcut-api-test-v1",
      status: "extracted",
      confidence: 0.93,
      needsReview: false,
      resultJson: {
        eventType: "reimbursement_report",
        rawMessageId: input.rawMessageId,
        channelName: input.channelName,
        reporter: input.reporter,
        reportedAt: input.sentAt,
        amount: 36.5,
        currency: "CNY",
        expenseCategory: "food",
        voucherDate: "2026-08-19",
        voucherDateSource: "model",
        note: input.textContent,
        evidenceType: "image+text",
        merchant: "测试菜场",
        documentNo: null,
        voucherType: "付款截图",
        ocrText: "合计 36.50",
      },
    };
  };
}

async function waitForBatchImportTask(baseUrl: string, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/expense/api/batch-reports/${taskId}`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    if (payload.task?.status === "completed") {
      return payload.task;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for batch import task ${taskId}`);
}

function seedReports() {
  const existingAttachmentPath = path.join(stateDir, "existing-attachment.jpg");
  const missingAttachmentPath = path.join(stateDir, "missing-attachment.jpg");

  if (!fs.existsSync(existingAttachmentPath)) {
    fs.writeFileSync(existingAttachmentPath, "existing-image", "utf8");
  }

  if (!fs.existsSync(missingAttachmentPath)) {
    fs.writeFileSync(missingAttachmentPath, "missing-image", "utf8");
  }

  const primaryExistingMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-existing-primary",
    channelCode: "reimbursement_admin_test",
    channelName: "报账后台测试群",
    senderName: "小周",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-01T01:00:00.000Z",
    dedupeKey: "reimbursement-admin-existing-primary",
    attachments: [
      {
        type: "image",
        localPath: existingAttachmentPath,
        sha256: "existing-sha256",
        mimeType: "image/jpeg",
      },
    ],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_admin_test",
    channelName: "报账后台测试群",
    reporter: "Ryan",
    amount: 128.5,
    currency: "CNY",
    expenseCategory: "food",
    voucherDate: "2026-07-01",
    voucherDateSource: "model",
    note: "晚餐食材采购",
    evidenceType: "image+text",
    merchant: "测试菜场",
    documentNo: "A-001",
    voucherType: "小票",
    ocrText: "测试菜场 合计128.50",
    confidence: 0.91,
    needsReview: false,
    primaryRawMessageId: primaryExistingMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-01T01:00:00.000Z",
  });
  saveReimbursementReceiptDelivery({
    reimbursementReportId: report.id,
    channelCode: "reimbursement_admin_test",
    targetType: "room_topic",
    targetValue: "报账后台测试群",
    receiptText: "报账128.5元已录入(分类: 食材)",
    sentAt: "2026-07-01T01:01:00.000Z",
  });

  const primaryMissingMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-missing-primary",
    channelCode: "reimbursement_admin_test",
    channelName: "报账后台测试群",
    senderName: "小李",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-01T02:00:00.000Z",
    dedupeKey: "reimbursement-admin-missing-primary",
    attachments: [
      {
        type: "image",
        localPath: missingAttachmentPath,
        sha256: "missing-sha256",
        mimeType: "image/jpeg",
      },
    ],
  });
  const missingReport = saveReimbursementReport({
    channelCode: "reimbursement_admin_test",
    channelName: "报账后台测试群",
    reporter: "小李",
    amount: null,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-07-02",
    voucherDateSource: "message",
    note: "待补票",
    evidenceType: "image",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.45,
    needsReview: true,
    primaryRawMessageId: primaryMissingMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-01T02:00:00.000Z",
  });

  fs.unlinkSync(missingAttachmentPath);

  const existingDetail = getAdminReimbursementReportDetail(report.id);
  const missingDetail = getAdminReimbursementReportDetail(missingReport.id);

  if (!existingDetail || !missingDetail) {
    throw new Error("Failed to seed reimbursement admin test data");
  }

  return {
    reportId: report.id,
    missingReportId: missingReport.id,
    existingAttachmentId: existingDetail.sources[0]?.attachments[0]?.id,
    missingAttachmentId: missingDetail.sources[0]?.attachments[0]?.id,
  };
}

after(() => {
  for (const key of managedEnvKeys) {
    delete process.env[key];
  }
});

test("createApp returns 503 on admin routes when credentials are not configured", async () => {
  applyEnv({
    WECHATY_ADMIN_USERNAME: undefined,
    WECHATY_ADMIN_PASSWORD: undefined,
  });

  const server = await startServer();

  try {
    const healthResponse = await fetch(`${server.baseUrl}/expense/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true });

    const legacyHealthResponse = await fetch(`${server.baseUrl}/reimbursement/healthz`);
    assert.equal(legacyHealthResponse.status, 200);
    assert.deepEqual(await legacyHealthResponse.json(), { ok: true });

    const pageResponse = await fetch(`${server.baseUrl}/expense`);
    assert.equal(pageResponse.status, 503);
    assert.match(await pageResponse.text(), /尚未配置账号密码/);

    const apiResponse = await fetch(`${server.baseUrl}/expense/api/reports`);
    assert.equal(apiResponse.status, 503);
    assert.equal((await apiResponse.json()).success, false);
  } finally {
    await server.close();
  }
});

test("filtered admin URLs survive direct navigation and refresh through the legacy proxy path", async () => {
  applyEnv({ WECHATY_ADMIN_USERNAME: "admin", WECHATY_ADMIN_PASSWORD: "secret-pass" });
  const server = await startServer();
  const query = new URLSearchParams({
    createdDateFrom: "2026-09-01", createdDateTo: "2026-09-27",
    reporter: "张||李", note: "采购&!平", limit: "50", offset: "50",
  });
  try {
    for (const pathname of ["/expense", "/expense/", "/reimbursement", "/reimbursement/"]) {
      const url = `${server.baseUrl}${pathname}?${query}`;
      const unauthorized = await fetch(url);
      assert.equal(unauthorized.status, 401, `${pathname} still requires authentication`);
      await unauthorized.arrayBuffer();
      for (const navigation of ["direct", "refresh"]) {
        const response = await fetch(url, { headers: createAdminAuthHeaders() });
        assert.equal(response.status, 200, `${pathname}: ${navigation}`);
        assert.equal(new URL(response.url).search, `?${query}`);
        assert.match(await response.text(), /id="filters"/);
      }
    }
    const api = await fetch(`${server.baseUrl}/reimbursement/api/reports?limit=7&offset=0`, { headers: createAdminAuthHeaders() });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).limit, 7);
    for (const pathname of ["/reimbursement-other", "/reimbursements"]) {
      const response = await fetch(`${server.baseUrl}${pathname}?${query}`, { headers: createAdminAuthHeaders() });
      assert.equal(response.status, 404, "only the exact legacy path or its children are rewritten");
      await response.arrayBuffer();
    }
  } finally {
    await server.close();
  }
});

test("shortcut reimbursement API requires its dedicated bearer token", async () => {
  applyEnv({
    WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: undefined,
  });
  const unconfiguredServer = await startServer();

  try {
    const response = await fetch(
      `${unconfiguredServer.baseUrl}/expense/api/shortcut/reports`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer any-token",
          "Idempotency-Key": "10000000-0000-4000-8000-000000000001",
        },
        body: createShortcutForm(),
      },
    );
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /尚未配置/);
  } finally {
    await unconfiguredServer.close();
  }

  applyEnv({
    WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: "shortcut-secret",
  });
  const configuredServer = await startServer();

  try {
    const response = await fetch(
      `${configuredServer.baseUrl}/expense/api/shortcut/reports`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Idempotency-Key": "10000000-0000-4000-8000-000000000002",
        },
        body: createShortcutForm(),
      },
    );
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /身份验证失败/);
  } finally {
    await configuredServer.close();
  }
});

test("shortcut reimbursement API recognizes, persists, receipts, and deduplicates one image", async () => {
  applyEnv({
    WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: "shortcut-secret",
  });
  let extractorCalls = 0;
  const server = await startServer(
    createShortcutTestExtractor(() => {
      extractorCalls += 1;
    }),
  );
  const requestId = "2026-08-19T22:30:00+08:00";
  const headers = {
    Authorization: "Bearer shortcut-secret",
    "Idempotency-Key": requestId,
  };

  try {
    const firstResponse = await fetch(
      `${server.baseUrl}/expense/api/shortcut/reports`,
      {
        method: "POST",
        headers,
        body: createShortcutForm(),
      },
    );
    assert.equal(firstResponse.status, 201);
    const firstPayload = await firstResponse.json();
    assert.equal(firstPayload.success, true);
    assert.equal(firstPayload.duplicate, false);
    assert.equal(firstPayload.requestId, requestId);
    assert.equal(firstPayload.receipt, "报账36.5元已录入(分类: 食材)");
    assert.equal(firstPayload.report.amount, 36.5);
    assert.equal(firstPayload.report.expenseCategory, "food");
    assert.equal(firstPayload.report.expenseCategoryLabel, "食材");
    assert.equal(firstPayload.report.note, "午餐采购");
    assert.equal(extractorCalls, 1);

    const reportDetail = getAdminReimbursementReportDetail(firstPayload.report.id);
    assert(reportDetail);
    assert.equal(reportDetail.reporter, "张三");
    assert.equal(reportDetail.channelCode, "reimbursement_admin_test");
    assert.equal(reportDetail.sources[0]?.attachments[0]?.mimeType, "image/png");
    const extraction = listScenarioExtractionsByRawMessageId(
      reportDetail.sources[0]!.rawMessageId,
    )[0];
    assert.equal((extraction?.resultJson as { source?: string }).source, "shortcut_api");

    const duplicateResponse = await fetch(
      `${server.baseUrl}/expense/api/shortcut/reports`,
      {
        method: "POST",
        headers,
        body: createShortcutForm(),
      },
    );
    assert.equal(duplicateResponse.status, 200);
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicatePayload.duplicate, true);
    assert.equal(duplicatePayload.report.id, firstPayload.report.id);
    assert.equal(duplicatePayload.receipt, firstPayload.receipt);
    assert.equal(extractorCalls, 1);

    const conflictResponse = await fetch(
      `${server.baseUrl}/expense/api/shortcut/reports`,
      {
        method: "POST",
        headers,
        body: createShortcutForm({ reporter: "李四" }),
      },
    );
    assert.equal(conflictResponse.status, 409);
    assert.match((await conflictResponse.json()).error.message, /另一份报账内容/);
    assert.equal(extractorCalls, 1);
  } finally {
    await server.close();
  }
});

test("legacy Shortcut attribution uses explicit real names for manager visibility", async () => {
  applyEnv({
    WECHATY_ADMIN_USERNAME: "admin",
    WECHATY_ADMIN_PASSWORD: "secret-pass",
    WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
      {
        accountId: "shortcut-manager-001",
        username: "shortcut-manager",
        displayName: "快捷店长",
        password: "manager-secret-pass",
        role: "manager",
        managerStores: ["fuzzy"],
      },
    ]),
    WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: "shortcut-secret",
  });
  const server = await startServer(createShortcutTestExtractor(() => {}));

  try {
    const response = await fetch(`${server.baseUrl}/expense/api/shortcut/reports`, {
      method: "POST",
      headers: {
        Authorization: "Bearer shortcut-secret",
        "Idempotency-Key": "shortcut-manager-visible-0001",
      },
      body: createShortcutForm({
        channelCode: "reimbursement_fuzzy_manager",
        image: "manager-shortcut-image",
        reporter: "快捷店长",
      }),
    });
    assert.equal(response.status, 201);
    const reportId = (await response.json()).report.id;

    const detailResponse = await fetch(`${server.baseUrl}/expense/api/reports/${reportId}`, {
      headers: createAdminAuthHeaders("shortcut-manager", "manager-secret-pass"),
    });
    assert.equal(detailResponse.status, 200);
    const report = (await detailResponse.json()).report;
    assert.equal(report.reporter, "快捷店长");
    assert.equal(report.submittedByAccountId, "shortcut-manager-001");
    assert.equal(report.submittedByUsername, "shortcut-manager");
    assert.equal(report.submittedByDisplayName, "快捷店长");
    assert.equal(report.submittedByRole, "manager");

    const listResponse = await fetch(`${server.baseUrl}/expense/api/reports?limit=1000`, {
      headers: createAdminAuthHeaders("shortcut-manager", "manager-secret-pass"),
    });
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      (await listResponse.json()).items.map((item: { id: number }) => item.id),
      [reportId],
    );

    const otherStoreResponse = await fetch(`${server.baseUrl}/expense/api/shortcut/reports`, {
      method: "POST",
      headers: {
        Authorization: "Bearer shortcut-secret",
        "Idempotency-Key": "shortcut-manager-hidden-other-store-0001",
      },
      body: createShortcutForm({
        channelCode: "reimbursement_peanut_manager",
        image: "other-store-shortcut-image",
        reporter: "快捷店长",
      }),
    });
    assert.equal(otherStoreResponse.status, 201);
    const otherStoreReportId = (await otherStoreResponse.json()).report.id;
    const otherStoreReport = getAdminReimbursementReportDetail(otherStoreReportId);
    assert(otherStoreReport);
    assert.equal(otherStoreReport.submittedByAccountId, undefined);

    const otherStoreDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${otherStoreReportId}`,
      { headers: createAdminAuthHeaders("shortcut-manager", "manager-secret-pass") },
    );
    assert.equal(otherStoreDetailResponse.status, 404);

    const loginNameUpload = await fetch(`${server.baseUrl}/expense/api/shortcut/reports`, {
      method: "POST",
      headers: { Authorization: "Bearer shortcut-secret", "Idempotency-Key": "legacy-shortcut-login-name-0001" },
      body: createShortcutForm({ channelCode: "reimbursement_fuzzy_manager", reporter: "shortcut-manager" }),
    });
    assert.equal(loginNameUpload.status, 201);
    assert.equal(getAdminReimbursementReportDetail((await loginNameUpload.json()).report.id)!.submittedByAccountId, undefined);
  } finally {
    await server.close();
  }
});

test("unified Shortcut attribution matches real names, enforces submission scopes and preserves idempotency", async (t) => {
  applyEnv({ WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: "real-name-shortcut-token",
    // This stale legacy account must never win in unified mode.
    WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([{ accountId: "wrong-legacy-id", username: "张志延", displayName: "张志延", password: "fixture", role: "manager", managerStores: ["fuzzy"] }]),
  });
  let gatewayStatus = 200;
  let responseOverride: unknown;
  let lookups = 0;
  let extracted = 0;
  const authorization = (accountId = "reimbursement-admin", displayName = "张志延", role = "admin") => ({ success: true,
    account: { accountId, username: "ryanzzy", displayName, enabled: true, version: 1 },
    access: { accountId, app: "expense", role, enabled: true, version: 1, permissions: ["report:view", "report:submit"],
      config: { viewScope: { ownership: "any", stores: "all" as string | string[], channels: "all" as string | string[] },
        submitScope: { stores: "all" as string | string[], channels: "all" as string | string[] } },
    },
  });
  let candidates = [authorization()];
  const gateway = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    assert.equal(url.pathname, "/internal/shortcut-accounts/expense");
    assert.equal(request.headers.authorization, "Bearer fixture-real-name-internal-token");
    assert.equal(request.headers.cookie, undefined);
    lookups += 1;
    response.writeHead(gatewayStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseOverride ?? { success: true, matches: candidates.filter((entry) => entry.account.displayName === url.searchParams.get("displayName")) }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())));
  const address = gateway.address();
  assert(address && typeof address !== "string");
  const server = await startServer(createShortcutTestExtractor(() => { extracted += 1; }), {
    mode: "unified", url: `http://127.0.0.1:${address.port}`, token: "fixture-real-name-internal-token",
  });
  t.after(() => server.close());
  const upload = (key: string, reporter = "张志延", channelCode = "reimbursement_fuzzy") => fetch(`${server.baseUrl}/expense/api/shortcut/reports`, {
    method: "POST", headers: { Authorization: "Bearer real-name-shortcut-token", "Idempotency-Key": `real-name-${key}` },
    body: createShortcutForm({ reporter, channelCode, image: `image-${key}` }),
  });
  const success = await upload("administrator");
  assert.equal(success.status, 201);
  const reportId = (await success.json()).report.id;
  const report = getAdminReimbursementReportDetail(reportId)!;
  assert.equal(report.reporter, "张志延");
  assert.equal(report.submittedByAccountId, "reimbursement-admin");
  assert.equal(report.submittedByUsername, "ryanzzy");
  assert.equal(report.submittedByDisplayName, "张志延");
  assert.equal(report.submittedByRole, "admin");
  assert.equal(extracted, 1);

  gatewayStatus = 503;
  const duplicate = await upload("administrator");
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).report.id, reportId);
  assert.equal(lookups, 1, "completed retries do not need a new identity lookup");
  assert.equal(extracted, 1);
  assert.equal((await upload("administrator", "另一人")).status, 409);

  const db = getDatabase();
  const beforeRawCount = db.prepare("SELECT count(*) AS count FROM raw_messages").get();
  const failed = await upload("service-failure");
  assert.equal(failed.status, 503);
  assert.equal(extracted, 1);
  assert.deepEqual(db.prepare("SELECT count(*) AS count FROM raw_messages").get(), beforeRawCount);
  gatewayStatus = 200;
  assert.equal((await upload("service-failure")).status, 201, "same key can retry after lookup failure");

  const malformedCandidate = authorization();
  malformedCandidate.account.username = "张志延";
  const { displayName: _ignored, ...accountWithoutRealName } = malformedCandidate.account;
  const beforeMalformedCount = db.prepare("SELECT count(*) AS count FROM raw_messages").get();
  for (const [index, malformed] of [
    { success: true },
    { success: true, matches: [{ ...malformedCandidate, account: accountWithoutRealName }] },
    { success: true, matches: [{ ...malformedCandidate, account: { ...malformedCandidate.account, enabled: false } }] },
  ].entries()) {
    responseOverride = malformed;
    assert.equal((await upload(`invalid-gateway-${index}`)).status, 503);
    assert.deepEqual(db.prepare("SELECT count(*) AS count FROM raw_messages").get(), beforeMalformedCount);
  }
  responseOverride = undefined;

  const unowned = async (key: string, reporter = "张志延", channelCode = "reimbursement_fuzzy") => {
    const reply = await upload(key, reporter, channelCode);
    assert.equal(reply.status, 201);
    const saved = getAdminReimbursementReportDetail((await reply.json()).report.id)!;
    assert.equal(saved.reporter, reporter.trim());
    assert.equal(saved.submittedByAccountId, undefined);
    assert.equal(saved.submittedByUsername, undefined);
  };
  await unowned("login-name", "ryanzzy");
  await unowned("old-name", "Ryan。");
  await unowned("punctuation", "张志延。");
  candidates = [authorization(), authorization("same-real-name")];
  await unowned("ambiguous-name");
  candidates = [authorization()];
  candidates[0].access.permissions = ["report:view"];
  await unowned("no-submit-permission");
  candidates = [authorization("real-name-manager-001", "张志延", "manager")];
  candidates[0].access.config.submitScope = { stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] };
  await unowned("outside-store", "张志延", "reimbursement_peanut_manager");
  const manager = await upload("manager-name", " 张志延 ", "reimbursement_fuzzy_manager");
  assert.equal(manager.status, 201);
  assert.equal(getAdminReimbursementReportDetail((await manager.json()).report.id)!.submittedByAccountId, "real-name-manager-001");
  candidates = [authorization("real-name-partner-001", "新姓名", "partner")];
  await unowned("name-after-edit");
  const renamed = await upload("new-real-name", "新姓名");
  assert.equal(renamed.status, 201);
  assert.equal(getAdminReimbursementReportDetail((await renamed.json()).report.id)!.submittedByAccountId, "real-name-partner-001");
  assert.equal(getAdminReimbursementReportDetail(reportId)!.submittedByDisplayName, "张志延", "later name changes do not rewrite history");
});

test("createApp serves reimbursement admin page, list, detail, and attachment routes", async () => {
  applyEnv({
    WECHATY_ADMIN_USERNAME: "admin",
    WECHATY_ADMIN_PASSWORD: "secret-pass",
    WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
      {
        accountId: "partner-001",
        username: "partner",
        password: "partner-secret-pass",
        role: "partner",
      },
      {
        accountId: "manager-001",
        username: "manager",
        password: "manager-secret-pass",
        role: "manager",
        managerStores: ["fuzzy", "fuzzyqz"],
      },
      {
        accountId: "manager-002",
        username: "manager-two",
        password: "manager-two-secret-pass",
        role: "manager",
        managerStores: ["fuzzy"],
      },
    ]),
  });
  const seeded = seedReports();
  const server = await startServer();

  try {
    const unauthorizedPage = await fetch(`${server.baseUrl}/expense`);
    assert.equal(unauthorizedPage.status, 401);
    assert.equal(
      unauthorizedPage.headers.get("www-authenticate"),
      'Basic realm="Wechat Claw Reimbursement Admin", charset="UTF-8"',
    );

    const pageResponse = await fetch(`${server.baseUrl}/expense`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /src="\/expense\/api\/list-loading\.js"/);
    for (const prefix of ["/expense/api", "/reimbursement/api"]) {
      const asset = await fetch(`${server.baseUrl}${prefix}/list-loading.js`, { headers: createAdminAuthHeaders() });
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /createThumbnailLoader/);
      assert.equal((await fetch(`${server.baseUrl}${prefix}/list-loading.js`)).status, 401);
    }
    assert.match(pageHtml, /报账查看后台/);
    assert.match(pageHtml, /<form method="get" action="\/expense\/submit"[^>]*hidden>/);
    assert.match(pageHtml, /<button class="button-primary submit-button" type="submit">/);
    assert.match(pageHtml, /<span>新建报账<\/span>/);
    assert.match(pageHtml, /<h2 id="manualImportModalTitle">手工补录<\/h2>/);
    assert.match(pageHtml, /id="manualImportOpen"[^>]*hidden>手工补录<\/button>/);
    assert.match(pageHtml, /id="manualImportModal" hidden/);
    assert.match(pageHtml, /id="manualImportForm"/);
    assert.match(pageHtml, /id="manualSentAt" name="sentAt" type="datetime-local"/);
    assert.match(pageHtml, /id="manualImage" name="image" type="file"/);
    assert.match(pageHtml, /报账图仅作附件保存，不参与模型识别/);
    assert.match(pageHtml, /class="manual-upload" id="manualImagePicker"/);
    assert.match(pageHtml, /点击选择或拖拽报账图到这里/);
    assert.match(pageHtml, /\.manual-upload\.is-dragover/);
    assert.match(pageHtml, /id="manualImagePreview" hidden/);
    assert.match(pageHtml, /id="manualImageRemove" type="button">移除/);
    assert.match(pageHtml, /id="manualImportCancel" type="button">取消/);
    assert.match(pageHtml, /\.manual-import-grid \{[^}]*grid-template-columns: repeat\(2,/s);
    assert.match(pageHtml, /\.manual-import-dialog \{[^}]*width: min\(760px,/s);
    assert.match(pageHtml, /function renderManualImage\(file\)/);
    assert.match(pageHtml, /function acceptManualImage\(file\)/);
    assert.match(pageHtml, /manualImagePicker\.addEventListener\("dragover"/);
    assert.match(pageHtml, /manualImagePicker\.addEventListener\("drop"/);
    assert.match(pageHtml, /每次只能拖入一张报账图/);
    assert.match(pageHtml, /formData\.set\("image", image, image\.name\)/);
    assert.match(pageHtml, /fetch\(buildAuthFetchUrl\(`\$\{BASE_PATH\}\/api\/manual-import-options`\)/);
    assert.match(pageHtml, /method: "POST"/);
    assert.match(pageHtml, /body: formData/);
    assert.match(pageHtml, /elements\.manualImportOpen\.hidden = !state\.canImport/);
    assert.match(pageHtml, /id="batchImportOpen"[^>]*hidden>批量补录<\/button>/);
    assert.match(pageHtml, /<h2 id="batchImportModalTitle">批量补录<\/h2>/);
    assert.match(pageHtml, /每张报账图将分别调用原有模型识别，并各自生成一条报账记录/);
    assert.match(pageHtml, /id="batchImportForm"/);
    assert.match(pageHtml, /id="batchImages" name="images" type="file"[^>]*multiple/);
    assert.match(pageHtml, /点击选择或拖拽多张报账图到这里/);
    assert.match(pageHtml, /function acceptBatchImages\(files\)/);
    assert.match(pageHtml, /batchImagePicker\.addEventListener\("drop"/);
    assert.match(pageHtml, /formData\.append\("images", item\.file, item\.file\.name\)/);
    assert.match(pageHtml, /api\/batch-reports/);
    assert.doesNotMatch(pageHtml, /id="batchAmount"/);
    assert.doesNotMatch(pageHtml, /id="batchExpenseCategory"/);
    assert.doesNotMatch(pageHtml, /id="batchNote"/);
    assert.match(pageHtml, /这张报账图的备注（选填）/);
    assert.match(pageHtml, /note\.dataset\.batchImageNoteIndex/);
    assert.match(pageHtml, /formData\.set\("notesJson"/);
    assert.match(pageHtml, /最多 20 张/);
    assert.match(pageHtml, /id="batchTaskProgress" hidden/);
    assert.match(pageHtml, /正在识别：已完成 \$\{task\.completedCount\}\/\$\{task\.totalCount\}/);
    assert.match(pageHtml, /BATCH_TASK_STORAGE_KEY/);
    assert.match(pageHtml, /pollBatchImportTask\(task\.id\)/);
    assert.match(pageHtml, /elements\.batchImportOpen\.hidden = !state\.canImport/);
    assert.match(pageHtml, /<label for="channelCode">门店<\/label>/);
    assert.match(pageHtml, /<option value="200" selected>200<\/option>/);
    assert.match(pageHtml, /const DEFAULT_PAGE_LIMIT = 200;/);
    assert.match(pageHtml, /limit: DEFAULT_PAGE_LIMIT/);
    assert.match(pageHtml, /<option value="">全部<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_fuzzy">Fuzzy<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_fuzzy_manager">Fuzzy店长报账群<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_peanut">Peanut<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_peanut_manager">Peanut店长报账群<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_fuzzyqz">Fuzzy泉州店<\/option>/);
    assert.match(pageHtml, /<option value="reimbursement_fuzzy_qz_manager">Fuzzy泉州店长报账群<\/option>/);
    assert.match(pageHtml, /<th>门店<\/th>/);
    assert.doesNotMatch(pageHtml, /item\.channelCode \? `<div class="mono muted">/);
    assert.match(pageHtml, /已加载 \$\{state\.items\.length\} 条记录，总计金额 \$\{sumLoadedAmounts\(state\.items\)\.toFixed\(2\)\} 元/);
    assert.match(pageHtml, /<th class="column-bill">附件<\/th>/);
    assert.match(pageHtml, /id="attachmentPreviewModal"/);
    assert.match(pageHtml, /id="attachmentPreviewPrevious"[^>]+aria-label="上一个报账的附件"/);
    assert.match(pageHtml, /id="attachmentPreviewNext"[^>]+aria-label="下一个报账的附件"/);
    assert.match(pageHtml, /function navigateAttachmentPreview\(direction\)/);
    assert.match(pageHtml, /Number\(item\.amount\)\.toFixed\(2\)\} 元/);
    assert.match(pageHtml, /const previewCategory = item\.expenseCategoryLabel \|\| item\.expenseCategory \|\| "其他"/);
    assert.match(pageHtml, /报账 #\$\{item\.id\} 附件预览 \(\$\{previewAmount\} \| \$\{previewCategory\}\)/);
    assert.match(pageHtml, /<th>金额<\/th>\s*<th>类别<\/th>\s*<th>备注<\/th>/);
    assert.match(pageHtml, /<meta name="color-scheme" content="light dark"/);
    assert.match(pageHtml, /<nav class="topbar" aria-label="报账中心导航">/);
    assert.match(pageHtml, /\.topbar \{[^}]*min-height: 52px;[^}]*padding: 7px 12px;[^}]*border-radius: 13px;/s);
    assert.match(pageHtml, /\.hero \{[^}]*margin: 0 -14px 0;/s);
    assert.match(pageHtml, /<span>报账中心<\/span>/);
    assert.match(pageHtml, /<div class="center-switcher" id="centerSwitcher">/);
    assert.match(pageHtml, /id="centerSwitcherTrigger"[^>]*disabled/);
    assert.match(pageHtml, /id="centerSwitcherChevron"[^>]*hidden/);
    assert.match(pageHtml, /\.center-switcher-chevron\[hidden\] \{ display: none; \}/);
    assert.match(pageHtml, /\.center-switcher-trigger:disabled \{ color: var\(--ink\); opacity: 1;/);
    assert.match(pageHtml, /href="\/expense" aria-current="page"/);
    assert.match(pageHtml, /href="\/invoice"/);
    assert.match(pageHtml, /href="\/staff"/);
    assert.match(pageHtml, /\.center-switcher-option\[aria-current="page"\] \{ background: var\(--brand-soft\); \}/);
    assert.match(pageHtml, /\.center-switcher-option\[data-management\] svg \{ color: #a78bfa; \}/);
    assert.match(pageHtml, /M8 7V5\.5A2\.5 2\.5 0 0 1 10\.5 3H22/);
    assert.match(pageHtml, /link\.innerHTML = '[^']+<span>账号管理<\/span><span><\/span>'/);
    assert.match(pageHtml, /allowed\.includes\(link\.dataset\.center\)/);
    assert.match(pageHtml, /elements\.centerSwitcherBackdrop\.addEventListener\("click"/);
    assert.match(pageHtml, /id="themeIcon" aria-hidden="true">🌙<\/span>/);
    assert.match(pageHtml, /elements\.themeIcon\.textContent = normalizedTheme === "dark" \? "☀️" : "🌙"/);
    assert.match(pageHtml, /class="button-primary submit-button" type="submit"/);
    assert.doesNotMatch(pageHtml, /class="hero-art"/);
    assert.match(pageHtml, /:root\[data-theme="dark"\]/);
    assert.match(pageHtml, /window\.localStorage\.setItem\(THEME_STORAGE_KEY, normalizedTheme\)/);
    assert.match(pageHtml, /systemThemePreference\.addEventListener\("change"/);
    assert.match(pageHtml, /placeholder="支持 !排除、&与、\|\|或，如 张\|\|李"/);
    assert.match(pageHtml, /placeholder="支持 !、&、\|\|，如 食材\|\|房租"/);
    assert.match(pageHtml, /<label for="note">备注<\/label>/);
    assert.match(pageHtml, /placeholder="支持 !排除、&与、\|\|或，如 采购&!平"/);
    assert.match(pageHtml, /\.field \{[^}]*min-width: 0;/s);
    assert.match(pageHtml, /\.field input,\s*\.field select,\s*\.field textarea \{[^}]*min-width: 0;/s);
    assert.match(pageHtml, /\.controls-grid \.field select \{[^}]*height: 46px;[^}]*-webkit-appearance: none;/s);
    assert.match(pageHtml, /background-position:\s*calc\(100% - 18px\) 50%,\s*calc\(100% - 13px\) 50%;/);
    assert.match(pageHtml, /renderRemarkContent\(item\.note, "-"\)/);
    assert.match(pageHtml, /tag note-pill/);
    assert.match(pageHtml, /\/\[平农\]\/gu/);
    assert.match(pageHtml, /character === "农" \? " note-pill-farm" : ""/);
    assert.match(pageHtml, /\.tag\.note-pill-farm \{[^}]*color: #15803d;[^}]*background: rgba\(34, 197, 94, 0\.14\);/s);
    assert.match(pageHtml, /:root\[data-theme="dark"\] \.tag\.note-pill-farm \{[^}]*color: #69dc8d;/s);
    assert.match(pageHtml, /function hasSelectedTextWithin\(element\)/);
    assert.match(pageHtml, /selection\.getRangeAt\(index\)\.intersectsNode\(element\)/);
    assert.match(pageHtml, /if \(event\.detail > 1 \|\| hasSelectedTextWithin\(trigger\)\) \{\s*return;\s*\}/);
    assert.match(pageHtml, /function scheduleDetail\(reportId\)/);
    assert.match(pageHtml, /elements\.tableBody\.addEventListener\("dblclick", \(\) => \{\s*cancelPendingDetail\(\);\s*\}\)/);
    assert.match(pageHtml, /id="operationColumnHeader" hidden>操作<\/th>/);
    assert.match(pageHtml, /const operationCell = state\.canWrite/);
    assert.match(pageHtml, /id="editReportModal" hidden/);
    assert.match(pageHtml, /<h2 id="editReportModalTitle">编辑报账<\/h2>/);
    assert.match(pageHtml, /id="editReportAmount" name="amount" type="number"/);
    assert.match(pageHtml, /id="editReportExpenseCategory" name="expenseCategory"/);
    assert.match(pageHtml, /id="editReportCurrentNote">暂无备注<\/div>/);
    assert.match(pageHtml, /id="editReportNoteToAppend" name="noteToAppend"/);
    assert.match(pageHtml, /data-edit-id="\$\{item\.id\}"/);
    assert.match(pageHtml, /method: "PATCH"/);
    assert.match(pageHtml, /body: JSON\.stringify\(payload\)/);
    assert.match(pageHtml, /elements\.operationColumnHeader\.hidden = !state\.canWrite/);
    assert.match(pageHtml, /const MANAGER_CHANNEL_CODE_BY_STORE = new Map/);
    assert.match(pageHtml, /new Option\("全部（权限内）", ""\)/);
    assert.match(pageHtml, /elements\.filterReporter\.readOnly = true/);
    assert.match(pageHtml, /elements\.reporterFilterLabel\.textContent = "报账人（当前账号）"/);
    assert.match(pageHtml, /state\.accountRole === "manager"\s*\? ""\s*:/);
    assert.match(pageHtml, /restoreRoleScopedFilterValues\(\)/);
    assert.match(pageHtml, /fetch\(buildAuthFetchUrl\(`\$\{BASE_PATH\}\/api\/session`\)/);
    assert.doesNotMatch(pageHtml, /<label for="needsReview">需复核<\/label>/);

    const submissionPageResponse = await fetch(`${server.baseUrl}/expense/submit`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(submissionPageResponse.status, 200);
    const submissionPageHtml = await submissionPageResponse.text();
    assert.match(submissionPageHtml, /<nav class="topbar" aria-label="报账中心导航">/);
    assert.match(submissionPageHtml, /\.topbar \{[^}]*min-height: 52px;[^}]*padding: 7px 12px;[^}]*border-radius: 13px;/s);
    assert.match(submissionPageHtml, /\.hero \{[^}]*margin: 0 -14px 0;/s);
    assert.match(submissionPageHtml, /<h1>新建报账<\/h1>/);
    assert.match(submissionPageHtml, /class="link-button button-primary records-button" href="\/expense">/);
    assert.match(submissionPageHtml, /<span>查看报账记录<\/span>/);
    assert.match(submissionPageHtml, /id="themeIcon" aria-hidden="true">🌙<\/span>/);
    assert.match(submissionPageHtml, /elements\.themeIcon\.textContent = normalized === "dark" \? "☀️" : "🌙"/);
    assert.match(submissionPageHtml, /<svg class="hero-art"/);
    assert.match(submissionPageHtml, /\.field input\[type="datetime-local"\] \{\s*padding-inline: 0;/);
    assert.match(submissionPageHtml, /input\[type="datetime-local"\]::-webkit-date-and-time-value \{\s*padding-inline-start: 14px;\s*text-align: left;/);
    assert.match(submissionPageHtml, /id="reporter" type="text" readonly aria-readonly="true"/);
    assert.match(submissionPageHtml, /id="submitButton" type="submit">确认提交/);
    assert.match(submissionPageHtml, /function uploadSubmission/);
    assert.match(submissionPageHtml, /request.upload.addEventListener\("progress"/);
    assert.match(submissionPageHtml, /正在上传报账图/);
    assert.match(submissionPageHtml, /setUploadProgress\(100, "提交成功"\)/);
    assert.match(submissionPageHtml, /function enterSubmissionCompleteState\(\)/);
    assert.match(submissionPageHtml, /elements\.submitButton\.disabled = true/);
    assert.match(submissionPageHtml, /elements\.resetButton\.textContent = "继续报账"/);
    assert.match(submissionPageHtml, /elements\.form\.classList\.add\("is-submitted"\)/);
    assert.match(submissionPageHtml, /setControlsDisabled\(true\)/);
    assert.match(submissionPageHtml, /elements\.resetButton\.disabled = false/);
    assert.match(submissionPageHtml, /elements\.form\.classList\.remove\("is-submitted"\)/);
    assert.match(submissionPageHtml, /#submissionForm\.is-submitted \.image-list/);
    assert.match(submissionPageHtml, /state\.submissionComplete = false/);
    assert.match(submissionPageHtml, /window\.localStorage\.removeItem\(TASK_STORAGE_KEY\)/);
    assert.match(submissionPageHtml, /state\.submissionComplete\) return/);
    assert.match(submissionPageHtml, /识别将在后台继续执行/);
    assert.doesNotMatch(submissionPageHtml, /setStatus\(`后台处理中，已完成/);
    assert.doesNotMatch(submissionPageHtml, /name="reporter"/);
    assert.match(submissionPageHtml, /const reporter = elements\.reporter\.value;[\s\S]*?elements\.form\.reset\(\);[\s\S]*?elements\.reporter\.value = reporter;/);
    assert.match(submissionPageHtml, /点击选择或拖拽多张报账图到这里/);
    assert.match(submissionPageHtml, /这张报账图的备注（选填）/);
    assert.match(submissionPageHtml, /api\/submissions\/\$\{encodeURIComponent\(SUBMISSION_PAGE\)\}\/batch-reports/);
    assert.match(submissionPageHtml, /api\/batch-reports\/\$\{encodeURIComponent\(taskId\)\}/);

    for (const route of ["submit_fuzzy", "submit_peanut", "submit_fuzzyqz"]) {
      const response = await fetch(`${server.baseUrl}/expense/${route}`, {
        redirect: "manual",
        headers: createAdminAuthHeaders(),
      });
      assert.equal(response.status, 404);

      const legacyResponse = await fetch(`${server.baseUrl}/reimbursement/${route}`, {
        redirect: "manual",
        headers: createAdminAuthHeaders(),
      });
      assert.equal(legacyResponse.status, 404);
    }

    const unauthorizedSubmissionPage = await fetch(`${server.baseUrl}/expense/submit`);
    assert.equal(unauthorizedSubmissionPage.status, 401);

    const adminSessionResponse = await fetch(`${server.baseUrl}/expense/api/session`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(adminSessionResponse.status, 200);
    assert.deepEqual(await adminSessionResponse.json(), {
      success: true,
      account: {
        accountId: "reimbursement-admin",
        managerStores: [],
        username: "admin",
        role: "admin",
      },
      permissions: {
        canMonthlyReport: true,
        canOperatingSummary: true,
        canWrite: true,
        canSubmit: true,
        canViewAllReports: true,
      },
    });

    const partnerSessionResponse = await fetch(`${server.baseUrl}/expense/api/session`, {
      headers: createAdminAuthHeaders("partner", "partner-secret-pass"),
    });
    assert.equal(partnerSessionResponse.status, 200);
    assert.deepEqual(await partnerSessionResponse.json(), {
      success: true,
      account: {
        accountId: "partner-001",
        managerStores: [],
        username: "partner",
        role: "partner",
      },
      permissions: {
        canMonthlyReport: false,
        canOperatingSummary: false,
        canWrite: false,
        canSubmit: true,
        canViewAllReports: true,
      },
    });

    const adminSubmissionOptionsResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/options`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(adminSubmissionOptionsResponse.status, 200);
    const adminSubmissionOptions = await adminSubmissionOptionsResponse.json();
    assert.equal(adminSubmissionOptions.account.username, "admin");
    assert.equal(adminSubmissionOptions.permissions.canSubmit, true);
    assert.deepEqual(adminSubmissionOptions.channels, [
      { code: "reimbursement_fuzzy", name: "Fuzzy" },
      { code: "reimbursement_peanut", name: "Peanut" },
      { code: "reimbursement_fuzzyqz", name: "Fuzzy泉州店" },
      { code: "reimbursement_fuzzy_manager", name: "Fuzzy店长报账" },
      { code: "reimbursement_peanut_manager", name: "Peanut店长报账" },
      { code: "reimbursement_fuzzy_qz_manager", name: "Fuzzy泉州店长报账" },
    ]);
    const legacySubmissionOptionsResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit_fuzzy/options`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(legacySubmissionOptionsResponse.status, 404);

    const manualImportOptionsResponse = await fetch(
      `${server.baseUrl}/expense/api/manual-import-options`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(manualImportOptionsResponse.status, 200);
    const manualImportOptions = await manualImportOptionsResponse.json();
    assert.deepEqual(manualImportOptions.channels, [
      { code: "reimbursement_admin_test", name: "报账后台测试群" },
      { code: "reimbursement_fuzzy", name: "Fuzzy报账群" },
      { code: "reimbursement_peanut", name: "Peanut报账群" },
      { code: "reimbursement_fuzzyqz", name: "Fuzzy泉州报账群" },
      { code: "reimbursement_fuzzy_manager", name: "Fuzzy店长报账群" },
      { code: "reimbursement_peanut_manager", name: "Peanut店长报账群" },
      { code: "reimbursement_fuzzy_qz_manager", name: "Fuzzy泉州店长报账群" },
    ]);
    assert.equal(manualImportOptions.categories.some((item: { code: string }) => item.code === "flower"), true);

    const manualImportForm = new FormData();
    manualImportForm.set("channelCode", "reimbursement_admin_test");
    manualImportForm.set("reporter", "手工补录测试人");
    manualImportForm.set("amount", "36.50");
    manualImportForm.set("expenseCategory", "food");
    manualImportForm.set("note", "后台页面补录");
    manualImportForm.set("sentAt", "2026-08-14T10:30");
    manualImportForm.set("image", new Blob(["manual-receipt-image"], { type: "image/png" }), "receipt.png");
    const manualImportResponse = await fetch(`${server.baseUrl}/expense/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
      body: manualImportForm,
    });
    assert.equal(manualImportResponse.status, 201);
    const manualImportPayload = await manualImportResponse.json();
    assert.equal(manualImportPayload.success, true);
    assert.equal(manualImportPayload.report.channelCode, "reimbursement_admin_test");
    assert.equal(manualImportPayload.report.reporter, "手工补录测试人");
    assert.equal(manualImportPayload.report.amount, 36.5);
    assert.equal(manualImportPayload.report.voucherDate, "2026-08-14");
    assert.equal(manualImportPayload.report.evidenceType, "image+text");

    const manualImportDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${manualImportPayload.report.id}`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(manualImportDetailResponse.status, 200);
    const manualImportDetail = (await manualImportDetailResponse.json()).report;
    assert.equal(manualImportDetail.sources[0]?.attachments.length, 1);
    assert.equal(manualImportDetail.sources[0]?.attachments[0]?.mimeType, "image/png");
    const manualAttachmentResponse = await fetch(
      `${server.baseUrl}/expense/api/attachments/${manualImportDetail.sources[0]?.attachments[0]?.id}/content`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(manualAttachmentResponse.status, 200);
    assert.equal(await manualAttachmentResponse.text(), "manual-receipt-image");

    const batchImportForm = new FormData();
    batchImportForm.set("channelCode", "reimbursement_admin_test");
    batchImportForm.set("reporter", "批量补录测试人");
    batchImportForm.set("notesJson", JSON.stringify(["第一张备注", "第二张备注"]));
    batchImportForm.set("sentAt", "2026-08-17T10:30");
    batchImportForm.append("images", new Blob(["batch-image-one"], { type: "image/png" }), "one.png");
    batchImportForm.append("images", new Blob(["batch-image-two"], { type: "image/jpeg" }), "two.jpg");
    const batchImportResponse = await fetch(`${server.baseUrl}/expense/api/batch-reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
      body: batchImportForm,
    });
    assert.equal(batchImportResponse.status, 202);
    const batchImportPayload = await batchImportResponse.json();
    assert.equal(batchImportPayload.success, true);
    assert.match(batchImportPayload.task.status, /^(queued|processing)$/);
    assert.equal(batchImportPayload.task.totalCount, 2);
    const completedBatchTask = await waitForBatchImportTask(server.baseUrl, batchImportPayload.task.id);
    assert.equal(completedBatchTask.status, "completed");
    assert.equal(completedBatchTask.completedCount, 2);
    assert.equal(completedBatchTask.successCount, 2);
    assert.equal(completedBatchTask.failedCount, 0);
    assert.equal(completedBatchTask.items.length, 2);
    assert.deepEqual(completedBatchTask.items.map((item: { status: string }) => item.status), ["succeeded", "succeeded"]);
    const batchReports = await Promise.all(
      completedBatchTask.items.map(async (item: { reportId: number }) => {
        const response = await fetch(`${server.baseUrl}/expense/api/reports/${item.reportId}`, {
          headers: createAdminAuthHeaders(),
        });
        return (await response.json()).report;
      }),
    );
    assert.equal(
      batchReports.every((report: { expenseCategory?: string }) => Boolean(report.expenseCategory)),
      true,
    );
    assert.deepEqual(
      batchReports.map((report: { reporter: string }) => report.reporter),
      ["批量补录测试人", "批量补录测试人"],
    );
    assert.deepEqual(
      batchReports.map((report: { note: string }) => report.note),
      ["第一张备注", "第二张备注"],
    );
    for (const report of batchReports) {
      const detailResponse = await fetch(`${server.baseUrl}/expense/api/reports/${report.id}`, {
        headers: createAdminAuthHeaders(),
      });
      const detail = (await detailResponse.json()).report;
      assert.equal(detail.sources.length, 1);
      assert.equal(detail.sources[0]?.attachments.length, 1);
    }

    const submissionForm = new FormData();
    submissionForm.set("channelCode", "reimbursement_fuzzy_manager");
    submissionForm.set("reporter", "不能覆盖登录用户名");
    submissionForm.set("sentAt", "2026-08-22T10:30");
    submissionForm.set("notesJson", JSON.stringify(["店长页面报账"]));
    submissionForm.append("images", new Blob(["manager-image"], { type: "image/png" }), "manager.png");
    const submissionResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders(),
        body: submissionForm,
      },
    );
    assert.equal(submissionResponse.status, 202);
    const submissionTask = await waitForBatchImportTask(
      server.baseUrl,
      (await submissionResponse.json()).task.id,
    );
    const submissionReportResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${submissionTask.items[0].reportId}`,
      { headers: createAdminAuthHeaders() },
    );
    const submissionReport = (await submissionReportResponse.json()).report;
    assert.equal(submissionReport.reporter, "admin");
    assert.equal(submissionReport.channelCode, "reimbursement_fuzzy_manager");
    assert.equal(submissionReport.submittedByAccountId, "reimbursement-admin");

    const wrongStoreSubmissionForm = new FormData();
    wrongStoreSubmissionForm.set("channelCode", "reimbursement_peanut_manager");
    wrongStoreSubmissionForm.set("sentAt", "2026-08-22T10:30");
    wrongStoreSubmissionForm.set("notesJson", JSON.stringify([""]));
    wrongStoreSubmissionForm.append("images", new Blob(["wrong-store"], { type: "image/png" }), "wrong.png");
    const wrongStoreSubmissionResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders("manager", "manager-secret-pass"),
        body: wrongStoreSubmissionForm,
      },
    );
    assert.equal(wrongStoreSubmissionResponse.status, 400);
    assert.equal((await wrongStoreSubmissionResponse.json()).error.field, "channelCode");

    const managerOptionsResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/options`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerOptionsResponse.status, 200);
    assert.deepEqual((await managerOptionsResponse.json()).channels, [
      { code: "reimbursement_fuzzy_manager", name: "Fuzzy店长报账" },
      { code: "reimbursement_fuzzy_qz_manager", name: "Fuzzy泉州店长报账" },
    ]);

    const partnerOptionsResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/options`,
      { headers: createAdminAuthHeaders("partner", "partner-secret-pass") },
    );
    assert.equal(partnerOptionsResponse.status, 200);
    assert.deepEqual((await partnerOptionsResponse.json()).channels, [
      { code: "reimbursement_fuzzy", name: "Fuzzy" },
      { code: "reimbursement_peanut", name: "Peanut" },
      { code: "reimbursement_fuzzyqz", name: "Fuzzy泉州店" },
    ]);

    const managerSubmissionForm = new FormData();
    managerSubmissionForm.set("channelCode", "reimbursement_fuzzy_manager");
    managerSubmissionForm.set("sentAt", "2026-08-22T11:30");
    managerSubmissionForm.set("notesJson", JSON.stringify(["店长本人报账"]));
    managerSubmissionForm.append("images", new Blob(["manager-own-image"], { type: "image/png" }), "own.png");
    const managerSubmissionResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders("manager", "manager-secret-pass"),
        body: managerSubmissionForm,
      },
    );
    assert.equal(managerSubmissionResponse.status, 202);
    const managerTask = await waitForBatchImportTask(
      server.baseUrl,
      (await managerSubmissionResponse.json()).task.id,
    );
    const managerTaskResponse = await fetch(
      `${server.baseUrl}/expense/api/batch-reports/${managerTask.id}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerTaskResponse.status, 200);
    const otherManagerTaskResponse = await fetch(
      `${server.baseUrl}/expense/api/batch-reports/${managerTask.id}`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerTaskResponse.status, 404);
    const managerReportId = managerTask.items[0].reportId;
    const managerOwnDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${managerReportId}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerOwnDetailResponse.status, 200);
    const managerOwnReport = (await managerOwnDetailResponse.json()).report;
    assert.equal(managerOwnReport.reporter, "manager");
    assert.equal(managerOwnReport.submittedByAccountId, "manager-001");
    assert.equal(managerOwnReport.submittedByRole, "manager");
    const managerHistoricalDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${seeded.reportId}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerHistoricalDetailResponse.status, 404);
    const otherManagerDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${managerReportId}`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerDetailResponse.status, 404);
    const managerListResponse = await fetch(`${server.baseUrl}/expense/api/reports?limit=1000`, {
      headers: createAdminAuthHeaders("manager", "manager-secret-pass"),
    });
    const managerList = await managerListResponse.json();
    assert.equal(managerList.total, 1);
    assert.deepEqual(managerList.items.map((item: { id: number }) => item.id), [managerReportId]);
    const otherManagerListResponse = await fetch(`${server.baseUrl}/expense/api/reports?limit=1000`, {
      headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass"),
    });
    assert.equal((await otherManagerListResponse.json()).total, 0);
    const managerAttachmentId = managerOwnReport.sources[0]?.attachments[0]?.id;
    assert.ok(managerAttachmentId);
    const managerAttachmentResponse = await fetch(
      `${server.baseUrl}/expense/api/attachments/${managerAttachmentId}/content`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerAttachmentResponse.status, 200);
    const otherManagerAttachmentResponse = await fetch(
      `${server.baseUrl}/expense/api/attachments/${managerAttachmentId}/content`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerAttachmentResponse.status, 404);

    const partnerForbiddenForm = new FormData();
    partnerForbiddenForm.set("channelCode", "reimbursement_fuzzy_manager");
    partnerForbiddenForm.set("sentAt", "2026-08-22T12:00");
    partnerForbiddenForm.set("notesJson", JSON.stringify([""]));
    partnerForbiddenForm.append("images", new Blob(["partner-forbidden"], { type: "image/png" }), "forbidden.png");
    const partnerForbiddenResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders("partner", "partner-secret-pass"),
        body: partnerForbiddenForm,
      },
    );
    assert.equal(partnerForbiddenResponse.status, 400);
    assert.equal((await partnerForbiddenResponse.json()).error.field, "channelCode");

    const partnerSubmissionForm = new FormData();
    partnerSubmissionForm.set("channelCode", "reimbursement_peanut");
    partnerSubmissionForm.set("sentAt", "2026-08-22T12:10");
    partnerSubmissionForm.set("notesJson", JSON.stringify(["合伙人报账"]));
    partnerSubmissionForm.append("images", new Blob(["partner-image"], { type: "image/png" }), "partner.png");
    const partnerSubmissionResponse = await fetch(
      `${server.baseUrl}/expense/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders("partner", "partner-secret-pass"),
        body: partnerSubmissionForm,
      },
    );
    assert.equal(partnerSubmissionResponse.status, 202);
    const partnerTask = await waitForBatchImportTask(
      server.baseUrl,
      (await partnerSubmissionResponse.json()).task.id,
    );
    const partnerReportResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${partnerTask.items[0].reportId}`,
      { headers: createAdminAuthHeaders("partner", "partner-secret-pass") },
    );
    const partnerReport = (await partnerReportResponse.json()).report;
    assert.equal(partnerReport.reporter, "partner");
    assert.equal(partnerReport.submittedByAccountId, "partner-001");
    assert.equal(partnerReport.channelCode, "reimbursement_peanut");

    const emptyBatchImportForm = new FormData();
    emptyBatchImportForm.set("channelCode", "reimbursement_admin_test");
    emptyBatchImportForm.set("reporter", "无图片测试人");
    emptyBatchImportForm.set("sentAt", "2026-08-17T10:30");
    const emptyBatchImportResponse = await fetch(`${server.baseUrl}/expense/api/batch-reports`, {
      method: "POST",
      headers: createAdminAuthHeaders(),
      body: emptyBatchImportForm,
    });
    assert.equal(emptyBatchImportResponse.status, 400);
    assert.equal((await emptyBatchImportResponse.json()).error.field, "images");

    const oversizedBatchCountForm = new FormData();
    oversizedBatchCountForm.set("channelCode", "reimbursement_admin_test");
    oversizedBatchCountForm.set("reporter", "超量图片测试人");
    oversizedBatchCountForm.set("sentAt", "2026-08-17T10:30");
    oversizedBatchCountForm.set("notesJson", JSON.stringify(Array.from({ length: 21 }, () => "")));
    for (let index = 0; index < 21; index += 1) {
      oversizedBatchCountForm.append(
        "images",
        new Blob([`batch-image-${index}`], { type: "image/png" }),
        `${index}.png`,
      );
    }
    const oversizedBatchCountResponse = await fetch(`${server.baseUrl}/expense/api/batch-reports`, {
      method: "POST",
      headers: createAdminAuthHeaders(),
      body: oversizedBatchCountForm,
    });
    assert.equal(oversizedBatchCountResponse.status, 400);
    assert.match((await oversizedBatchCountResponse.json()).error.message, /最多添加 20 张/);

    const invalidManualImportResponse = await fetch(`${server.baseUrl}/expense/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelCode: "loss_admin_test",
        reporter: "错误频道测试人",
        amount: 10,
        expenseCategory: "food",
        sentAt: "2026-08-14T10:30",
      }),
    });
    assert.equal(invalidManualImportResponse.status, 400);
    assert.equal((await invalidManualImportResponse.json()).error.field, "channelCode");

    const invalidImageForm = new FormData();
    invalidImageForm.set("channelCode", "reimbursement_admin_test");
    invalidImageForm.set("reporter", "错误图片测试人");
    invalidImageForm.set("amount", "10");
    invalidImageForm.set("expenseCategory", "food");
    invalidImageForm.set("sentAt", "2026-08-14T10:30");
    invalidImageForm.set("image", new Blob(["not-an-image"], { type: "text/plain" }), "receipt.txt");
    const invalidImageResponse = await fetch(`${server.baseUrl}/expense/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
      body: invalidImageForm,
    });
    assert.equal(invalidImageResponse.status, 400);
    assert.equal((await invalidImageResponse.json()).error.field, "image");

    const guestPageResponse = await fetch(`${server.baseUrl}/expense`, {
      headers: createAdminAuthHeaders("partner", "partner-secret-pass"),
    });
    assert.equal(guestPageResponse.status, 200);

    const listResponse = await fetch(
      `${server.baseUrl}/expense/api/reports?search=%E6%B5%8B%E8%AF%95%E8%8F%9C%E5%9C%BA&reporter=Ry&note=%E6%99%9A%E9%A4%90&limit=20`,
      {
        headers: {
          ...createAdminAuthHeaders(),
          Accept: "application/json",
        },
      },
    );
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.success, true);
    assert.equal(listPayload.total, 1);
    assert.equal(listPayload.timeZone, "Asia/Shanghai");
    assert.equal(listPayload.items[0]?.id, seeded.reportId);
    assert.equal(listPayload.items[0]?.billAttachment?.id, seeded.existingAttachmentId);
    assert.equal(listPayload.items[0]?.billAttachment?.mimeType, "image/jpeg");
    assert.equal(listPayload.items[0]?.billAttachment?.exists, true);

    for (const invalidFilter of [
      { field: "note", value: "采购|待补", message: /备注筛选格式无效/ },
      { field: "note", value: "采购&", message: /备注筛选格式无效/ },
      { field: "note", value: "||采购", message: /备注筛选格式无效/ },
      { field: "note", value: "(采购||待补)", message: /备注筛选格式无效/ },
      { field: "reporter", value: "张|李", message: /报账人筛选格式无效/ },
      { field: "expenseCategory", value: "食材&", message: /类别筛选格式无效/ },
      { field: "expenseCategory", value: "不存在", message: /类别筛选值无效/ },
    ]) {
      const invalidFilterResponse = await fetch(
        `${server.baseUrl}/expense/api/reports?${invalidFilter.field}=${encodeURIComponent(invalidFilter.value)}`,
        {
          headers: {
            ...createAdminAuthHeaders(),
            Accept: "application/json",
          },
        },
      );
      assert.equal(invalidFilterResponse.status, 400);
      const invalidFilterPayload = await invalidFilterResponse.json();
      assert.equal(invalidFilterPayload.error.field, invalidFilter.field);
      assert.match(invalidFilterPayload.error.message, invalidFilter.message);
    }

    const guestListResponse = await fetch(`${server.baseUrl}/expense/api/reports?limit=20`, {
      headers: {
        ...createAdminAuthHeaders("partner", "partner-secret-pass"),
        Accept: "application/json",
      },
    });
    assert.equal(guestListResponse.status, 200);
    assert.equal((await guestListResponse.json()).success, true);

    const detailResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.reportId}`, {
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
    });
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.success, true);
    assert.equal(detailPayload.report.receiptDeliveries.length, 1);
    assert.equal(detailPayload.report.sources[0]?.attachments.length, 1);
    assert.equal(detailPayload.report.sources[0]?.attachments[0]?.exists, true);

    const guestEditResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.reportId}`, {
      method: "PATCH",
      headers: {
        ...createAdminAuthHeaders("partner", "partner-secret-pass"),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: 99,
        updatedAt: detailPayload.report.updatedAt,
      }),
    });
    assert.equal(guestEditResponse.status, 403);

    const editResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.reportId}`, {
      method: "PATCH",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: -12.5,
        expenseCategory: "flower",
        noteToAppend: "后台调整",
        updatedAt: detailPayload.report.updatedAt,
      }),
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    assert.equal(editPayload.success, true);
    assert.equal(editPayload.report.amount, -12.5);
    assert.equal(editPayload.report.expenseCategory, "flower");
    assert.equal(editPayload.report.note, "晚餐食材采购；后台调整");
    assert.equal(editPayload.report.needsReview, false);
    assert.equal(editPayload.report.createdAt, detailPayload.report.createdAt);
    assert.notEqual(editPayload.report.updatedAt, detailPayload.report.updatedAt);

    const staleEditResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.reportId}`, {
      method: "PATCH",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: 66,
        updatedAt: detailPayload.report.updatedAt,
      }),
    });
    assert.equal(staleEditResponse.status, 409);
    assert.match((await staleEditResponse.json()).error.message, /重新加载/);

    const emptyEditResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.reportId}`, {
      method: "PATCH",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ updatedAt: editPayload.report.updatedAt }),
    });
    assert.equal(emptyEditResponse.status, 400);
    assert.equal((await emptyEditResponse.json()).error.field, "report");

    assert.ok(seeded.existingAttachmentId);
    const attachmentResponse = await fetch(
      `${server.baseUrl}/expense/api/attachments/${seeded.existingAttachmentId}/content`,
      {
        headers: createAdminAuthHeaders(),
      },
    );
    assert.equal(attachmentResponse.status, 200);
    assert.equal(attachmentResponse.headers.get("content-type"), "image/jpeg");
    assert.equal(await attachmentResponse.text(), "existing-image");

    assert.ok(seeded.missingAttachmentId);
    const missingAttachmentResponse = await fetch(
      `${server.baseUrl}/expense/api/attachments/${seeded.missingAttachmentId}/content`,
      {
        headers: {
          ...createAdminAuthHeaders(),
          Accept: "application/json",
        },
      },
    );
    assert.equal(missingAttachmentResponse.status, 404);
    assert.equal((await missingAttachmentResponse.json()).success, false);

    const guestDeleteResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${seeded.missingReportId}`,
      {
        method: "DELETE",
        headers: {
          ...createAdminAuthHeaders("partner", "partner-secret-pass"),
          Accept: "application/json",
        },
      },
    );
    assert.equal(guestDeleteResponse.status, 403);
    assert.deepEqual(await guestDeleteResponse.json(), {
      success: false,
      error: {
        message: "当前账号无权使用管理员专属功能。",
      },
    });

    const guestWriteResponse = await fetch(`${server.baseUrl}/expense/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders("partner", "partner-secret-pass"),
        Accept: "application/json",
      },
    });
    assert.equal(guestWriteResponse.status, 403);

    const reportAfterGuestDeleteAttempt = await fetch(
      `${server.baseUrl}/expense/api/reports/${seeded.missingReportId}`,
      {
        headers: {
          ...createAdminAuthHeaders("partner", "partner-secret-pass"),
          Accept: "application/json",
        },
      },
    );
    assert.equal(reportAfterGuestDeleteAttempt.status, 200);

    const deleteResponse = await fetch(`${server.baseUrl}/expense/api/reports/${seeded.missingReportId}`, {
      method: "DELETE",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.success, true);
    assert.equal(deletePayload.id, seeded.missingReportId);

    const deletedDetailResponse = await fetch(
      `${server.baseUrl}/expense/api/reports/${seeded.missingReportId}`,
      {
        headers: {
          ...createAdminAuthHeaders(),
          Accept: "application/json",
        },
      },
    );
    assert.equal(deletedDetailResponse.status, 404);

    const missingDeleteResponse = await fetch(`${server.baseUrl}/expense/api/reports/999999`, {
      method: "DELETE",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
    });
    assert.equal(missingDeleteResponse.status, 404);
  } finally {
    await server.close();
  }
});

test("unified self deletion includes attributed shortcut uploads and rejects other or unowned reports", async (t) => {
  const ownerId = "self-delete-shortcut-owner";
  const username = "self-delete-shortcut-user";
  applyEnv({
    WECHATY_ADMIN_USERNAME: "admin",
    WECHATY_ADMIN_PASSWORD: "secret-pass",
    WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN: "self-delete-shortcut-token",
    WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
      { accountId: ownerId, username, password: "unused-password", role: "manager", managerStores: ["fuzzy"] },
    ]),
  });
  let selfDeleteEnabled = true;
  const gateway = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-self-delete-gateway-token");
    if (request.url?.startsWith("/internal/shortcut-accounts/expense?")) {
      assert.equal(new URL(request.url, "http://localhost").searchParams.get("displayName"), "归属店长");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, matches: [{ success: true,
        account: { accountId: ownerId, username, displayName: "归属店长", enabled: true, version: 1 },
        access: { accountId: ownerId, app: "expense", role: "manager", enabled: true, version: 1, permissions: ["report:submit"],
          config: { viewScope: { ownership: "self", stores: [], channels: [] }, submitScope: { stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] } },
        },
      }] }));
      return;
    }
    assert.equal(request.url, "/internal/authorization/expense");
    const identity = request.headers.cookie?.replace("fixture=", "");
    if (!["owner", "other", "reader", "full"].includes(identity ?? "")) {
      response.writeHead(401).end();
      return;
    }
    const accountId = identity === "owner" || identity === "reader" ? ownerId : `self-delete-${identity}`;
    const permissions = ["report:view", "attachment:view"];
    if (identity === "full") permissions.push("report:delete");
    else if (identity !== "reader" && selfDeleteEnabled) permissions.push("report:delete:self");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      account: { accountId, username, enabled: true, version: 1 },
      access: { accountId, app: "expense", role: "manager", enabled: true, version: 1, permissions,
        config: {
          viewScope: { ownership: "any", stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
          submitScope: { stores: [], channels: [] },
        },
      },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())));
  const address = gateway.address();
  assert(address && typeof address !== "string");
  const server = await startServer(createShortcutTestExtractor(() => {}), {
    mode: "unified", url: `http://127.0.0.1:${address.port}`, token: "fixture-self-delete-gateway-token",
  });
  t.after(() => server.close());
  const requestAs = (identity: string, route: string, method = "GET") => fetch(`${server.baseUrl}/expense/api${route}`, {
    method, headers: { Cookie: `fixture=${identity}` },
  });
  const upload = await fetch(`${server.baseUrl}/expense/api/shortcut/reports`, {
    method: "POST",
    headers: { Authorization: "Bearer self-delete-shortcut-token", "Idempotency-Key": "self-delete-shortcut-upload-0001" },
    body: createShortcutForm({ channelCode: "reimbursement_fuzzy_manager", reporter: "归属店长" }),
  });
  assert.equal(upload.status, 201);
  const ownedId = (await upload.json()).report.id;
  const owned = getAdminReimbursementReportDetail(ownedId);
  assert(owned);
  assert.equal(owned.submittedByAccountId, ownerId);
  const attachment = owned.sources[0]?.attachments[0];
  assert(attachment && fs.existsSync(attachment.localPath));
  const seed = (key: string, submittedByAccountId?: string, channelCode = "reimbursement_fuzzy_manager") => {
    const raw = saveRawMessage({
      messageExternalId: `self-delete-${key}`, dedupeKey: `self-delete-${key}`, channelCode,
      channelName: "删除权限测试", senderName: username, messageType: "manual_import",
      textContent: "权限测试", eventReceivedAt: "2026-09-20T01:00:00.000Z", attachments: [],
    });
    return saveReimbursementReport({
      channelCode, channelName: "删除权限测试", reporter: username, amount: 12.5, currency: "CNY",
      expenseCategory: "food", voucherDate: "2026-09-20", voucherDateSource: "message", note: key,
      evidenceType: "text", merchant: null, documentNo: null, voucherType: null, ocrText: null,
      confidence: 1, needsReview: false, primaryRawMessageId: raw.rawMessageId,
      submittedByAccountId, timeZone: "Asia/Shanghai", referenceDateTime: "2026-09-20T01:00:00.000Z",
    }).id;
  };
  const otherId = seed("other", "self-delete-other");
  const unownedId = seed("unowned");
  const outsideId = seed("outside", ownerId, "reimbursement_peanut_manager");
  const manualId = seed("manual", ownerId);

  const session = await (await requestAs("owner", "/session")).json();
  assert.equal(session.permissions.canDelete, false);
  assert.equal(session.permissions.canDeleteSelf, true);
  assert.equal(session.permissions.canEdit, false);
  assert.equal(session.permissions.canImport, false);
  const listing = await requestAs("owner", "/reports?limit=1000&submittedByAccountId=self-delete-other");
  assert.equal(listing.status, 200);
  const items = (await listing.json()).items as Array<{ id: number; permissions: { canDelete: boolean } }>;
  for (const [id, canDelete] of [[ownedId, true], [manualId, true], [otherId, false], [unownedId, false]] as const) {
    assert.equal(items.find((item) => item.id === id)?.permissions.canDelete, canDelete);
    const detail = await requestAs("owner", `/reports/${id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).report.permissions.canDelete, canDelete);
  }
  assert.equal(items.some((item) => item.id === outsideId), false);
  for (const [identity, id, expected] of [
    ["owner", otherId, 403], ["owner", unownedId, 403], ["owner", outsideId, 404],
    ["other", ownedId, 403], ["reader", ownedId, 403], ["unknown", ownedId, 401],
  ] as const) {
    assert.equal((await requestAs(identity, `/reports/${id}`, "DELETE")).status, expected);
    assert(getAdminReimbursementReportDetail(id), "denied deletion must leave the record intact");
  }
  assert.equal((await requestAs("owner", `/reports/${ownedId}`, "PATCH")).status, 403);
  assert.equal((await requestAs("owner", "/reports", "POST")).status, 403);
  selfDeleteEnabled = false;
  assert.equal((await requestAs("owner", `/reports/${ownedId}`, "DELETE")).status, 403);
  assert.equal((await (await requestAs("owner", `/reports/${ownedId}`)).json()).report.permissions.canDelete, false);
  selfDeleteEnabled = true;

  assert.equal((await requestAs("full", `/reports/${outsideId}`, "DELETE")).status, 404);
  assert.equal((await requestAs("full", `/reports/${unownedId}`, "DELETE")).status, 200);
  assert.equal((await requestAs("owner", `/reports/${ownedId}`, "DELETE")).status, 200);
  assert.equal((await requestAs("owner", `/reports/${ownedId}`, "DELETE")).status, 404);
  assert.equal((await requestAs("owner", `/reports/${ownedId}`)).status, 404);
  assert.equal((await requestAs("owner", `/attachments/${attachment.id}/content`)).status, 404);
  assert(fs.existsSync(attachment.localPath), "existing deletion behavior retains the original attachment file");
  assert.equal((await requestAs("owner", `/reports/${manualId}`, "DELETE")).status, 200);
  assert(getAdminReimbursementReportDetail(otherId));
  assert(getAdminReimbursementReportDetail(outsideId));
});

test("edit category options require edit permission, independent of import permission", async (t) => {
  applyEnv({ WECHATY_ADMIN_USERNAME: "admin", WECHATY_ADMIN_PASSWORD: "fixture-password" });
  const gateway=createServer((request,response)=>{
    const role=request.headers.cookie?.replace("fixture=","");
    const permissions=["report:view",...(role==="editor"?["report:edit"]:role==="importer"?["report:import"]:[])];
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify({success:true,account:{accountId:"edit-options-fixture",username:"fixture",enabled:true,version:1},access:{accountId:"edit-options-fixture",app:"expense",role:"partner",enabled:true,version:1,permissions,config:{viewScope:{ownership:"any",stores:"all",channels:"all"},submitScope:{stores:[],channels:[]},importScope:{stores:"all",channels:"all"}}}}));
  });
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");t.after(()=>new Promise<void>(resolve=>gateway.close(()=>resolve())));
  const address=gateway.address();assert(address&&typeof address!=="string");
  const server=await startServer(undefined,{mode:"unified",url:`http://127.0.0.1:${address.port}`,token:"edit-category-options-fixture-token-001"});t.after(()=>server.close());
  const request=(who:string,route:string)=>fetch(server.baseUrl+"/expense/api/"+route,{headers:{Cookie:`fixture=${who}`}});
  const options=await request("editor","edit-report-options");assert.equal(options.status,200);
  const payload=await options.json();assert.deepEqual(payload.categories.map((c:{code:string})=>c.code),["food","flower","salary","rent","utilities","manager_reimbursement","planned_expense","other"]);
  assert.equal(payload.channels,undefined);assert.equal((await request("editor","manual-import-options")).status,403);
  assert.equal((await request("reader","edit-report-options")).status,403);assert.equal((await request("importer","edit-report-options")).status,403);
});

test("report detail deep links accept only safe positive record ids", () => {
  const html=fs.readFileSync(path.resolve(process.cwd(),"src/admin/public/admin.html"),"utf8");
  const code=html.slice(html.indexOf("      function linkedReportId("),html.indexOf("      function writeFiltersFromUrl("));
  for (const [hash,expected] of [["#report=123",123],["#report=0",null],["#report=-1",null],["#report=1x",null],["#report=9007199254740992",null],["#report=1&other=2",null],["",null]] as const) assert.equal(runInNewContext(code+"\nlinkedReportId(hash)",{hash}),expected);
});

test("thumbnail endpoint checks permissions and source existence even with a warm cache", async (t) => {
  const sharp = (await import("sharp")).default;
  applyEnv({ WECHATY_ADMIN_USERNAME: "admin", WECHATY_ADMIN_PASSWORD: "secret-pass" });
  const source = path.join(stateDir, "thumbnail-source.png");
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#2468ac" } }).png().toFile(source);
  const original = fs.readFileSync(source);
  const raw = saveRawMessage({
    messageExternalId: "thumbnail-source", channelCode: "reimbursement_fuzzy", channelName: "Fuzzy报账群",
    senderName: "缩略图测试", messageType: "6", textContent: "", dedupeKey: "thumbnail-source",
    eventReceivedAt: "2026-09-25T01:00:00.000Z",
    attachments: [{ type: "image", localPath: source, sha256: "thumbnail-source-hash", mimeType: "image/png" }],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_fuzzy", channelName: "Fuzzy报账群", reporter: "缩略图测试", amount: 12,
    currency: "CNY", expenseCategory: "food", evidenceType: "image+text", confidence: 1, needsReview: false,
    voucherDate: "2026-09-25", voucherDateSource: "model", note: "", merchant: "", documentNo: "", voucherType: "receipt", ocrText: "",
    primaryRawMessageId: raw.rawMessageId, timeZone: "Asia/Shanghai", referenceDateTime: "2026-09-25T01:00:00.000Z",
  });
  const attachmentId = getAdminReimbursementReportDetail(report.id)!.sources[0].attachments[0].id;
  let gatewayStatus = 200;
  let stores: string | string[] = ["fuzzy"];
  let permissions = ["report:view", "attachment:view"];
  const gateway = createServer((_request, response) => {
    response.writeHead(gatewayStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true,
      account: { accountId: "thumbnail-test", username: "thumbnail-test", enabled: true, version: 1 },
      access: { accountId: "thumbnail-test", app: "expense", role: "partner", enabled: true, version: 1, permissions,
        config: { viewScope: { ownership: "any", stores, channels: "all" }, submitScope: { stores: [], channels: [] } },
      },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));
  const address = gateway.address();
  assert(address && typeof address !== "string");
  const server = await startServer(undefined, {
    mode: "unified", url: `http://127.0.0.1:${address.port}`, token: "thumbnail-test-internal-token-0001",
  });
  t.after(() => server.close());
  const url = `${server.baseUrl}/expense/api/attachments/${attachmentId}/thumbnail`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.match(first.headers.get("server-timing")!, /auth;dur=.*attachment;dur=.*thumbnail;dur=/);
  assert.ok(first.headers.get("x-request-id"));
  const thumbnail = Buffer.from(await first.arrayBuffer());
  assert.equal((await sharp(thumbnail).metadata()).width, 240);
  assert.deepEqual(fs.readFileSync(source), original);
  const second = await fetch(url);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), thumbnail);
  permissions = ["report:view"];
  assert.equal((await fetch(url)).status, 403);
  permissions = ["report:view", "attachment:view"];
  stores = ["peanut"];
  assert.equal((await fetch(url)).status, 404);
  stores = ["fuzzy"];
  gatewayStatus = 401;
  assert.equal((await fetch(url)).status, 401);
  gatewayStatus = 200;
  const list = await fetch(`${server.baseUrl}/expense/api/reports?createdDateFrom=2026-09-25&createdDateTo=2026-09-25`);
  assert.equal(list.status, 200);
  assert.match(list.headers.get("server-timing")!, /auth;dur=.*query;dur=.*attachments;dur=/);
  fs.writeFileSync(source, "invalid replacement");
  assert.equal((await fetch(url)).status, 422);
  fs.writeFileSync(source, original);
  assert.equal((await fetch(url)).status, 200);
  fs.unlinkSync(source);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url.replace("/thumbnail", "/content"))).status, 404);
  assert.equal((await fetch(url.replace(`/attachments/${attachmentId}/`, "/attachments/99999999/"))).status, 404);
  fs.writeFileSync(source, original);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(deleteReimbursementReport(report.id), true);
  assert.equal((await fetch(url)).status, 404);
});


test("reporter edits validate names, preserve ownership and reject unauthorized or stale writes", async (t) => {
  applyEnv({ WECHATY_ADMIN_USERNAME: "admin", WECHATY_ADMIN_PASSWORD: "secret-pass" });
  const gateway = createServer((request, response) => {
    const identity = request.headers.cookie?.replace("fixture=", "") || "reader";
    const accountId = identity === "owner" ? "reporter-owner" : `reporter-${identity}`;
    const canEdit = identity === "editor" || identity === "outside-editor";
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      success: true,
      account: { accountId, username: identity, displayName: "新报账人", enabled: true, version: 1 },
      access: { accountId, app: "expense", role: "partner", enabled: true, version: 1,
        permissions: ["report:view", "report:delete:self", ...(canEdit ? ["report:edit"] : [])],
        config: {
          viewScope: { ownership: identity === "editor" || identity === "reader" ? "any" : "self", stores: ["fuzzy"], channels: "all" },
          submitScope: { stores: [], channels: [] },
        },
      },
    }));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => new Promise<void>(resolve => gateway.close(() => resolve())));
  const address = gateway.address();
  assert(address && typeof address !== "string");
  const server = await startServer(undefined, {
    mode: "unified", url: `http://127.0.0.1:${address.port}`, token: "reporter-edit-fixture-internal-token",
  });
  t.after(() => server.close());
  const raw = saveRawMessage({
    messageExternalId: "reporter-edit-fixture", dedupeKey: "reporter-edit-fixture",
    channelCode: "reimbursement_fuzzy", channelName: "Fuzzy报账群", senderName: "原报账人",
    messageType: "manual_import", textContent: "原始凭证", eventReceivedAt: "2026-09-20T01:00:00.000Z", attachments: [],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_fuzzy", channelName: "Fuzzy报账群", reporter: "原报账人",
    amount: 12.5, currency: "CNY", expenseCategory: "food", voucherDate: "2026-09-20", voucherDateSource: "message",
    note: "原备注", evidenceType: "text", merchant: null, documentNo: null, voucherType: null, ocrText: null,
    confidence: 1, needsReview: true, primaryRawMessageId: raw.rawMessageId,
    submittedByAccountId: "reporter-owner", submittedByUsername: "owner-login", submittedByDisplayName: "原提交人", submittedByRole: "manager",
    timeZone: "Asia/Shanghai", referenceDateTime: "2026-09-20T01:00:00.000Z",
  });
  const before = getAdminReimbursementReportDetail(report.id)!;
  const request = (identity: string, route: string, patch?: Record<string, unknown>) => fetch(`${server.baseUrl}/expense/api${route}`, {
    method: patch ? "PATCH" : "GET",
    headers: { Cookie: `fixture=${identity}`, "Content-Type": "application/json" },
    ...(patch ? { body: JSON.stringify(patch) } : {}),
  });
  const route = `/reports/${report.id}`;
  for (const [identity, status] of [["reader", 403], ["owner", 403], ["outside-editor", 404]] as const) {
    assert.equal((await request(identity, route, { reporter: "越权修改", updatedAt: report.updatedAt })).status, status);
  }
  for (const reporter of ["", "   ", null, 123, { name: "姓名" }]) {
    const response = await request("editor", route, { reporter, updatedAt: report.updatedAt });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.field, "reporter");
  }
  assert.deepEqual(getAdminReimbursementReportDetail(report.id), before);
  const response = await request("editor", route, { reporter: "  新报账人  ", updatedAt: report.updatedAt });
  assert.equal(response.status, 200);
  const renamed = (await response.json()).report;
  assert.equal(renamed.reporter, "新报账人");
  assert.notEqual(renamed.updatedAt, report.updatedAt);
  assert.deepEqual(getAdminReimbursementReportDetail(report.id), { ...before, reporter: "新报账人", updatedAt: renamed.updatedAt });
  const listing = await request("editor", `/reports?reporter=${encodeURIComponent("新报账人")}`);
  assert.equal((await listing.json()).items.some((item: { id: number }) => item.id === report.id), true);
  const owner = await request("owner", route);
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).report.permissions.canDelete, true);
  assert.equal((await request("other", route)).status, 404, "matching display names must not grant access");
  assert.equal((await request("editor", route, { reporter: "过期修改", updatedAt: report.updatedAt })).status, 409);
  assert.equal(getAdminReimbursementReportDetail(report.id)?.reporter, "新报账人");
  const amountOnly = await request("editor", route, { amount: 20, updatedAt: renamed.updatedAt });
  assert.equal(amountOnly.status, 200);
  assert.equal((await amountOnly.json()).report.reporter, "新报账人", "omitting reporter preserves its current value");
});
