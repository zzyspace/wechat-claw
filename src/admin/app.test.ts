import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, test } from "node:test";

import { getAdminReimbursementReportDetail, saveReimbursementReceiptDelivery, saveReimbursementReport } from "../scenarios/reimbursement/repository.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";
import { createApp } from "./app.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-admin-"));
const managedEnvKeys = [
  "WECHATY_ADMIN_HOST",
  "WECHATY_ADMIN_PASSWORD",
  "WECHATY_ADMIN_PORT",
  "WECHATY_ADMIN_USERNAME",
  "WECHATY_PUPPET",
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

async function startServer() {
  const app = createApp();
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
    reporter: "小周",
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

test("createApp serves reimbursement admin page, list, detail, and attachment routes", async () => {
  applyEnv({
    WECHATY_ADMIN_USERNAME: "admin",
    WECHATY_ADMIN_PASSWORD: "secret-pass",
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
    assert.match(await pageResponse.text(), /报账查看后台/);

    const listResponse = await fetch(
      `${server.baseUrl}/reimbursement/api/reports?search=%E6%B5%8B%E8%AF%95%E8%8F%9C%E5%9C%BA&needsReview=false&limit=20`,
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
  } finally {
    await server.close();
  }
});
