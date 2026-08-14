import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listScenarioExtractionsByRawMessageId } from "../../core/scenarios/scenario-extraction-repository.js";
import { listRecentRawMessages } from "../../core/storage/raw-message-repository.js";
import { getAdminReimbursementReportDetail } from "./repository.js";
import { importManualReimbursementReport } from "./manual-import.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-manual-reimbursement-import-"));

test("importManualReimbursementReport creates a text reimbursement with synthetic raw message and extraction", () => {
  const result = importManualReimbursementReport({
    amount: 88.6,
    channelCode: "reimbursement_fuzzy",
    channelName: "模糊报账群",
    expenseCategory: "food",
    note: "午餐报账",
    reporter: "小王",
    sentAt: "2026-07-02T06:32:00.000Z",
    timeZone: "Asia/Shanghai",
  });

  assert.equal(result.report.channelCode, "reimbursement_fuzzy");
  assert.equal(result.report.channelName, "模糊报账群");
  assert.equal(result.report.reporter, "小王");
  assert.equal(result.report.amount, 88.6);
  assert.equal(result.report.expenseCategory, "food");
  assert.equal(result.report.voucherDate, "2026-07-02");
  assert.equal(result.report.voucherDateSource, "message");
  assert.equal(result.report.note, "午餐报账");
  assert.equal(result.report.evidenceType, "text");
  assert.equal(result.report.needsReview, false);

  const detail = getAdminReimbursementReportDetail(result.report.id);
  assert(detail);
  assert.equal(detail?.sources.length, 1);
  assert.equal(detail?.sources[0]?.role, "primary");
  assert.equal(detail?.sources[0]?.textContent, "午餐报账");

  const extractionRecords = listScenarioExtractionsByRawMessageId(result.rawMessageId);
  assert.equal(extractionRecords.length, 1);
  assert.equal(extractionRecords[0]?.extractorCode, "manual-import-v1");
  assert.equal(
    (extractionRecords[0]?.resultJson as { reimbursementReportId?: number } | undefined)?.reimbursementReportId,
    result.report.id,
  );

  const recentRawMessage = listRecentRawMessages(20).find((message) => message.id === result.rawMessageId);
  assert(recentRawMessage);
  assert.equal(recentRawMessage.channelCode, "reimbursement_fuzzy");
  assert.equal(recentRawMessage.senderName, "小王");
  assert.equal(recentRawMessage.messageType, "manual_import");
  assert.equal(recentRawMessage.textContent, "午餐报账");
});

test("importManualReimbursementReport uses fallback source text when note is empty", () => {
  const result = importManualReimbursementReport({
    amount: 12,
    channelCode: "reimbursement_fuzzy",
    channelName: "模糊报账群",
    expenseCategory: "other",
    reporter: "小李",
    sentAt: "2026-07-02T08:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });

  assert.equal(result.report.note, "");
  assert.equal(result.textContent, "(手工补录)");
});

test("importManualReimbursementReport stores an uploaded image without model extraction", () => {
  const imagePath = path.join(process.env.WECHATY_STATE_DIR ?? os.tmpdir(), "manual-upload.png");
  fs.writeFileSync(imagePath, "manual-upload-image", "utf8");
  const result = importManualReimbursementReport({
    amount: 29.9,
    channelCode: "reimbursement_fuzzy",
    channelName: "模糊报账群",
    expenseCategory: "flower",
    reporter: "小陈",
    sentAt: "2026-07-02T09:00:00.000Z",
    timeZone: "Asia/Shanghai",
    attachments: [
      {
        type: "image",
        localPath: imagePath,
        sha256: "manual-upload-sha256",
        mimeType: "image/png",
      },
    ],
  });

  assert.equal(result.report.evidenceType, "image+text");
  const detail = getAdminReimbursementReportDetail(result.report.id);
  assert.equal(detail?.sources[0]?.attachments.length, 1);
  assert.equal(detail?.sources[0]?.attachments[0]?.localPath, imagePath);
  const extractions = listScenarioExtractionsByRawMessageId(result.rawMessageId);
  assert.equal(extractions.length, 1);
  assert.equal(extractions[0]?.extractorCode, "manual-import-v1");
  assert.equal((extractions[0]?.resultJson as { source?: string }).source, "manual_import");
});
