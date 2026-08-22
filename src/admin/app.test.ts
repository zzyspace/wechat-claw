import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, test } from "node:test";

import { listScenarioExtractionsByRawMessageId } from "../core/scenarios/scenario-extraction-repository.js";
import { getAdminReimbursementReportDetail, saveReimbursementReceiptDelivery, saveReimbursementReport } from "../scenarios/reimbursement/repository.js";
import type { ReimbursementExtractor } from "../scenarios/reimbursement/batch-import.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";
import { createApp } from "./app.js";

test("reimbursement nginx keeps shortcut Bearer auth public and protects admin routes", () => {
  const nginx = fs.readFileSync(
    path.resolve(process.cwd(), "deploy/nginx/reimbursement-admin.locations.conf"),
    "utf8",
  );
  const shortcutIndex = nginx.indexOf("location = /reimbursement/api/shortcut/reports");
  const protectedApiIndex = nginx.indexOf("location ^~ /reimbursement/api/");
  assert.ok(shortcutIndex >= 0);
  assert.ok(protectedApiIndex > shortcutIndex);
  assert.match(
    nginx,
    /location \^~ \/reimbursement\/api\/ \{[\s\S]*?admin-auth-reimbursement\.inc;/,
  );
  assert.match(
    nginx,
    /location = \/reimbursement \{[\s\S]*?admin-auth-reimbursement\.inc;/,
  );
  for (const route of ["submit", "submit_fuzzy", "submit_peanut", "submit_fuzzyqz"]) {
    assert.match(
      nginx,
      new RegExp(`location = \\/reimbursement\\/${route} \\{[\\s\\S]*?admin-auth-reimbursement\\.inc;`),
    );
  }
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
  assert.match(html, /<form method="post" action="\/admin-logout">/);
  assert.match(html, /name="returnTo" value="\/reimbursement"/);
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

async function startServer(reimbursementExtractor?: ReimbursementExtractor) {
  const app = createApp({ reimbursementExtractor });
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
  image?: string;
  note?: string;
  reporter?: string;
}) {
  const form = new FormData();
  form.set("channelCode", "reimbursement_admin_test");
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
    const response = await fetch(`${baseUrl}/reimbursement/api/batch-reports/${taskId}`, {
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
    const healthResponse = await fetch(`${server.baseUrl}/reimbursement/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true });

    const pageResponse = await fetch(`${server.baseUrl}/reimbursement`);
    assert.equal(pageResponse.status, 503);
    assert.match(await pageResponse.text(), /尚未配置账号密码/);

    const apiResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports`);
    assert.equal(apiResponse.status, 503);
    assert.equal((await apiResponse.json()).success, false);
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
      `${unconfiguredServer.baseUrl}/reimbursement/api/shortcut/reports`,
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
      `${configuredServer.baseUrl}/reimbursement/api/shortcut/reports`,
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
      `${server.baseUrl}/reimbursement/api/shortcut/reports`,
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
      `${server.baseUrl}/reimbursement/api/shortcut/reports`,
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
      `${server.baseUrl}/reimbursement/api/shortcut/reports`,
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
    const unauthorizedPage = await fetch(`${server.baseUrl}/reimbursement`);
    assert.equal(unauthorizedPage.status, 401);
    assert.equal(
      unauthorizedPage.headers.get("www-authenticate"),
      'Basic realm="Wechat Claw Reimbursement Admin", charset="UTF-8"',
    );

    const pageResponse = await fetch(`${server.baseUrl}/reimbursement`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /报账查看后台/);
    assert.match(pageHtml, /<form method="get" action="\/reimbursement\/submit">/);
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
    assert.match(pageHtml, /elements\.manualImportOpen\.hidden = !state\.canWrite/);
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
    assert.match(pageHtml, /elements\.batchImportOpen\.hidden = !state\.canWrite/);
    assert.match(pageHtml, /<label for="channelCode">门店<\/label>/);
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
    assert.match(pageHtml, /id="themeToggle"/);
    assert.match(pageHtml, /:root\[data-theme="dark"\]/);
    assert.match(pageHtml, /window\.localStorage\.setItem\(THEME_STORAGE_KEY, normalizedTheme\)/);
    assert.match(pageHtml, /systemThemePreference\.addEventListener\("change"/);
    assert.match(pageHtml, /placeholder="支持部分匹配，如 Ry \/ 张"/);
    assert.match(pageHtml, /<label for="note">备注<\/label>/);
    assert.match(pageHtml, /placeholder="支持部分匹配，如 补票 \/ 平账"/);
    assert.match(pageHtml, /\.field \{[^}]*min-width: 0;/s);
    assert.match(pageHtml, /\.field input,\s*\.field select,\s*\.field textarea \{[^}]*min-width: 0;/s);
    assert.match(pageHtml, /@supports \(-webkit-touch-callout: none\)/);
    assert.match(pageHtml, /\.field input\[type="date"\] \{\s*padding-inline: 0;/);
    assert.match(pageHtml, /::-webkit-date-and-time-value \{\s*padding-inline-start: 14px;/);
    assert.match(pageHtml, /renderRemarkContent\(item\.note, "-"\)/);
    assert.match(pageHtml, /tag note-pill/);
    assert.match(pageHtml, /function hasSelectedTextWithin\(element\)/);
    assert.match(pageHtml, /selection\.getRangeAt\(index\)\.intersectsNode\(element\)/);
    assert.match(pageHtml, /if \(event\.detail > 1 \|\| hasSelectedTextWithin\(trigger\)\) \{\s*return;\s*\}/);
    assert.match(pageHtml, /function scheduleDetail\(reportId\)/);
    assert.match(pageHtml, /elements\.tableBody\.addEventListener\("dblclick", \(\) => \{\s*cancelPendingDetail\(\);\s*\}\)/);
    assert.match(pageHtml, /id="accessPill" hidden/);
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

    const submissionPageResponse = await fetch(`${server.baseUrl}/reimbursement/submit`, {
      headers: createAdminAuthHeaders(),
    });
    assert.equal(submissionPageResponse.status, 200);
    const submissionPageHtml = await submissionPageResponse.text();
    assert.match(submissionPageHtml, /<h1>批量报账<\/h1>/);
    assert.match(submissionPageHtml, /id="reporter" type="text" readonly aria-readonly="true"/);
    assert.match(submissionPageHtml, /id="submitButton" type="submit">确认提交/);
    assert.match(submissionPageHtml, /function uploadSubmission/);
    assert.match(submissionPageHtml, /request.upload.addEventListener\("progress"/);
    assert.match(submissionPageHtml, /正在上传报账图/);
    assert.match(submissionPageHtml, /setUploadProgress\(100, "提交成功"\)/);
    assert.match(submissionPageHtml, /识别将在后台继续执行/);
    assert.doesNotMatch(submissionPageHtml, /setStatus\(`后台处理中，已完成/);
    assert.doesNotMatch(submissionPageHtml, /name="reporter"/);
    assert.match(submissionPageHtml, /const reporter = elements\.reporter\.value;[\s\S]*?elements\.form\.reset\(\);[\s\S]*?elements\.reporter\.value = reporter;/);
    assert.match(submissionPageHtml, /点击选择或拖拽多张报账图到这里/);
    assert.match(submissionPageHtml, /这张报账图的备注（选填）/);
    assert.match(submissionPageHtml, /api\/submissions\/\$\{encodeURIComponent\(SUBMISSION_PAGE\)\}\/batch-reports/);
    assert.match(submissionPageHtml, /api\/batch-reports\/\$\{encodeURIComponent\(taskId\)\}/);

    for (const route of ["submit_fuzzy", "submit_peanut", "submit_fuzzyqz"]) {
      const response = await fetch(`${server.baseUrl}/reimbursement/${route}`, {
        redirect: "manual",
        headers: createAdminAuthHeaders(),
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/reimbursement/submit");
    }

    const unauthorizedSubmissionPage = await fetch(`${server.baseUrl}/reimbursement/submit`);
    assert.equal(unauthorizedSubmissionPage.status, 401);

    const adminSessionResponse = await fetch(`${server.baseUrl}/reimbursement/api/session`, {
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
        canWrite: true,
        canSubmit: true,
        canViewAllReports: true,
      },
    });

    const partnerSessionResponse = await fetch(`${server.baseUrl}/reimbursement/api/session`, {
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
        canWrite: false,
        canSubmit: true,
        canViewAllReports: true,
      },
    });

    const adminSubmissionOptionsResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/submissions/submit/options`,
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
      `${server.baseUrl}/reimbursement/api/submissions/submit_fuzzy/options`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(legacySubmissionOptionsResponse.status, 404);

    const manualImportOptionsResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/manual-import-options`,
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
    const manualImportResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports`, {
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
      `${server.baseUrl}/reimbursement/api/reports/${manualImportPayload.report.id}`,
      { headers: createAdminAuthHeaders() },
    );
    assert.equal(manualImportDetailResponse.status, 200);
    const manualImportDetail = (await manualImportDetailResponse.json()).report;
    assert.equal(manualImportDetail.sources[0]?.attachments.length, 1);
    assert.equal(manualImportDetail.sources[0]?.attachments[0]?.mimeType, "image/png");
    const manualAttachmentResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/attachments/${manualImportDetail.sources[0]?.attachments[0]?.id}/content`,
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
    const batchImportResponse = await fetch(`${server.baseUrl}/reimbursement/api/batch-reports`, {
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
        const response = await fetch(`${server.baseUrl}/reimbursement/api/reports/${item.reportId}`, {
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
      const detailResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${report.id}`, {
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
      `${server.baseUrl}/reimbursement/api/submissions/submit/batch-reports`,
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
      `${server.baseUrl}/reimbursement/api/reports/${submissionTask.items[0].reportId}`,
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
      `${server.baseUrl}/reimbursement/api/submissions/submit/batch-reports`,
      {
        method: "POST",
        headers: createAdminAuthHeaders("manager", "manager-secret-pass"),
        body: wrongStoreSubmissionForm,
      },
    );
    assert.equal(wrongStoreSubmissionResponse.status, 400);
    assert.equal((await wrongStoreSubmissionResponse.json()).error.field, "channelCode");

    const managerOptionsResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/submissions/submit/options`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerOptionsResponse.status, 200);
    assert.deepEqual((await managerOptionsResponse.json()).channels, [
      { code: "reimbursement_fuzzy_manager", name: "Fuzzy店长报账" },
      { code: "reimbursement_fuzzy_qz_manager", name: "Fuzzy泉州店长报账" },
    ]);

    const partnerOptionsResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/submissions/submit/options`,
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
      `${server.baseUrl}/reimbursement/api/submissions/submit/batch-reports`,
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
      `${server.baseUrl}/reimbursement/api/batch-reports/${managerTask.id}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerTaskResponse.status, 200);
    const otherManagerTaskResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/batch-reports/${managerTask.id}`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerTaskResponse.status, 404);
    const managerReportId = managerTask.items[0].reportId;
    const managerOwnDetailResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/reports/${managerReportId}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerOwnDetailResponse.status, 200);
    const managerOwnReport = (await managerOwnDetailResponse.json()).report;
    assert.equal(managerOwnReport.reporter, "manager");
    assert.equal(managerOwnReport.submittedByAccountId, "manager-001");
    assert.equal(managerOwnReport.submittedByRole, "manager");
    const managerHistoricalDetailResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerHistoricalDetailResponse.status, 404);
    const otherManagerDetailResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/reports/${managerReportId}`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerDetailResponse.status, 404);
    const managerListResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports?limit=1000`, {
      headers: createAdminAuthHeaders("manager", "manager-secret-pass"),
    });
    const managerList = await managerListResponse.json();
    assert.equal(managerList.total, 1);
    assert.deepEqual(managerList.items.map((item: { id: number }) => item.id), [managerReportId]);
    const otherManagerListResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports?limit=1000`, {
      headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass"),
    });
    assert.equal((await otherManagerListResponse.json()).total, 0);
    const managerAttachmentId = managerOwnReport.sources[0]?.attachments[0]?.id;
    assert.ok(managerAttachmentId);
    const managerAttachmentResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/attachments/${managerAttachmentId}/content`,
      { headers: createAdminAuthHeaders("manager", "manager-secret-pass") },
    );
    assert.equal(managerAttachmentResponse.status, 200);
    const otherManagerAttachmentResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/attachments/${managerAttachmentId}/content`,
      { headers: createAdminAuthHeaders("manager-two", "manager-two-secret-pass") },
    );
    assert.equal(otherManagerAttachmentResponse.status, 404);

    const partnerForbiddenForm = new FormData();
    partnerForbiddenForm.set("channelCode", "reimbursement_fuzzy_manager");
    partnerForbiddenForm.set("sentAt", "2026-08-22T12:00");
    partnerForbiddenForm.set("notesJson", JSON.stringify([""]));
    partnerForbiddenForm.append("images", new Blob(["partner-forbidden"], { type: "image/png" }), "forbidden.png");
    const partnerForbiddenResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/submissions/submit/batch-reports`,
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
      `${server.baseUrl}/reimbursement/api/submissions/submit/batch-reports`,
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
      `${server.baseUrl}/reimbursement/api/reports/${partnerTask.items[0].reportId}`,
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
    const emptyBatchImportResponse = await fetch(`${server.baseUrl}/reimbursement/api/batch-reports`, {
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
    const oversizedBatchCountResponse = await fetch(`${server.baseUrl}/reimbursement/api/batch-reports`, {
      method: "POST",
      headers: createAdminAuthHeaders(),
      body: oversizedBatchCountForm,
    });
    assert.equal(oversizedBatchCountResponse.status, 400);
    assert.match((await oversizedBatchCountResponse.json()).error.message, /最多添加 20 张/);

    const invalidManualImportResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports`, {
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
    const invalidImageResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders(),
        Accept: "application/json",
      },
      body: invalidImageForm,
    });
    assert.equal(invalidImageResponse.status, 400);
    assert.equal((await invalidImageResponse.json()).error.field, "image");

    const guestPageResponse = await fetch(`${server.baseUrl}/reimbursement`, {
      headers: createAdminAuthHeaders("partner", "partner-secret-pass"),
    });
    assert.equal(guestPageResponse.status, 200);

    const listResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/reports?search=%E6%B5%8B%E8%AF%95%E8%8F%9C%E5%9C%BA&reporter=Ry&note=%E6%99%9A%E9%A4%90&limit=20`,
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

    const guestListResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports?limit=20`, {
      headers: {
        ...createAdminAuthHeaders("partner", "partner-secret-pass"),
        Accept: "application/json",
      },
    });
    assert.equal(guestListResponse.status, 200);
    assert.equal((await guestListResponse.json()).success, true);

    const detailResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`, {
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

    const guestEditResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`, {
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

    const editResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`, {
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

    const staleEditResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`, {
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

    const emptyEditResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.reportId}`, {
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
      `${server.baseUrl}/reimbursement/api/attachments/${seeded.existingAttachmentId}/content`,
      {
        headers: createAdminAuthHeaders(),
      },
    );
    assert.equal(attachmentResponse.status, 200);
    assert.equal(attachmentResponse.headers.get("content-type"), "image/jpeg");
    assert.equal(await attachmentResponse.text(), "existing-image");

    assert.ok(seeded.missingAttachmentId);
    const missingAttachmentResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/attachments/${seeded.missingAttachmentId}/content`,
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
      `${server.baseUrl}/reimbursement/api/reports/${seeded.missingReportId}`,
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

    const guestWriteResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports`, {
      method: "POST",
      headers: {
        ...createAdminAuthHeaders("partner", "partner-secret-pass"),
        Accept: "application/json",
      },
    });
    assert.equal(guestWriteResponse.status, 403);

    const reportAfterGuestDeleteAttempt = await fetch(
      `${server.baseUrl}/reimbursement/api/reports/${seeded.missingReportId}`,
      {
        headers: {
          ...createAdminAuthHeaders("partner", "partner-secret-pass"),
          Accept: "application/json",
        },
      },
    );
    assert.equal(reportAfterGuestDeleteAttempt.status, 200);

    const deleteResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/${seeded.missingReportId}`, {
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
      `${server.baseUrl}/reimbursement/api/reports/${seeded.missingReportId}`,
      {
        headers: {
          ...createAdminAuthHeaders(),
          Accept: "application/json",
        },
      },
    );
    assert.equal(deletedDetailResponse.status, 404);

    const missingDeleteResponse = await fetch(`${server.baseUrl}/reimbursement/api/reports/999999`, {
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
