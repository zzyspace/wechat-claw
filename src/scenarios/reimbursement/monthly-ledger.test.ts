import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { saveRawMessage } from "../../core/storage/raw-message-repository.js";
import { importManualReimbursementReport } from "./manual-import.js";
import { importBatchReimbursementReports } from "./batch-import.js";
import { parseMonthlyLedgerNote, resolveMonthlyLedgerCreatedAtOverride } from "./monthly-ledger.js";
import { readMonthlyRecords } from "./monthly-report.js";
import {
  attachRemarkToReimbursementReport,
  getAdminReimbursementReportDetail,
  mergePrimaryImageIntoTextOnlyReimbursementReport,
  moveRemarkToReimbursementReport,
  updateAdminReimbursementReport,
} from "./repository.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-monthly-ledger-"));
let messageSequence = 0;

function createReport(note: string, sentAt = "2026-09-30T10:00:00.000Z") {
  return importManualReimbursementReport({
    amount: 20,
    channelCode: "reimbursement_fuzzy",
    channelName: "月账测试群",
    expenseCategory: "food",
    note,
    reporter: "月账测试",
    sentAt,
    timeZone: "Asia/Shanghai",
  }).report;
}

function createMessage(textContent: string, eventReceivedAt: string, messageType = "7") {
  const messageId = `monthly-ledger-test-${++messageSequence}`;
  return saveRawMessage({
    messageExternalId: messageId,
    channelCode: "reimbursement_fuzzy",
    channelName: "月账测试群",
    senderName: "月账测试",
    messageType,
    textContent,
    eventReceivedAt,
    dedupeKey: messageId,
    attachments: [],
  }).rawMessageId;
}

test("bare monthly ledger notes use the latest reached month without a January cutoff", () => {
  for (const [note, referenceDateTime, expected] of [
    ["1月账", "2027-01-10T10:00:00Z", "2027-01-31 15:59:59"],
    ["12月账", "2027-01-10T10:00:00Z", "2026-12-31 15:59:59"],
    ["12月账", "2027-01-20T10:00:00Z", "2026-12-31 15:59:59"],
    ["2月账", "2027-01-20T10:00:00Z", "2026-02-28 15:59:59"],
    ["8月账", "2026-09-30T10:00:00Z", "2026-08-31 15:59:59"],
    ["9月帐", "2026-09-30T10:00:00Z", "2026-09-30 15:59:59"],
    ["12月账", "2026-09-30T10:00:00Z", "2025-12-31 15:59:59"],
    ["12月账", "2026-12-30T10:00:00Z", "2026-12-31 15:59:59"],
  ]) {
    assert.equal(resolveMonthlyLedgerCreatedAtOverride({ note, referenceDateTime }), expected, `${referenceDateTime}: ${note}`);
  }
});

test("explicit years support older and future accounts and leap-year month ends", () => {
  for (const [note, expected] of [
    ["2024年2月帐", "2024-02-29 15:59:59"],
    ["2025年2月账", "2025-02-28 15:59:59"],
    ["2100年2月账", "2100-02-28 15:59:59"],
    ["2026年12月账", "2026-12-31 15:59:59"],
  ]) {
    assert.equal(resolveMonthlyLedgerCreatedAtOverride({ note, referenceDateTime: "2026-09-30T10:00:00Z" }), expected);
  }
});

test("year and month inference uses the configured timezone at the New Year boundary", () => {
  const input = { note: "1月账", referenceDateTime: "2027-01-01T00:30:00Z" };
  assert.equal(resolveMonthlyLedgerCreatedAtOverride({ ...input, timeZone: "Asia/Shanghai" }), "2027-01-31 15:59:59");
  assert.equal(resolveMonthlyLedgerCreatedAtOverride({ ...input, timeZone: "America/Los_Angeles" }), "2026-02-01 07:59:59");
  assert.equal(resolveMonthlyLedgerCreatedAtOverride({ note: "1月账", referenceDateTime: "2026-12-31T16:30:00Z" }), "2027-01-31 15:59:59");
});

test("ledger parsing accepts both spellings, uses the last valid marker and rejects partial numeric matches", () => {
  assert.deepEqual(parseMonthlyLedgerNote("采购；8月账；2024年2月帐"), { text: "2024年2月帐", month: 2, year: 2024 });
  assert.equal(parseMonthlyLedgerNote("08月账")?.month, 8);
  for (const note of ["补充说明", "0月账", "13月账", "113月账", "2025年13月账", "20255年12月账", "0000年12月账"]) {
    assert.equal(parseMonthlyLedgerNote(note), null, note);
    assert.equal(resolveMonthlyLedgerCreatedAtOverride({ note, referenceDateTime: "2027-01-20T10:00:00Z" }), null, note);
  }
  assert.equal(resolveMonthlyLedgerCreatedAtOverride({ note: "8月账", referenceDateTime: "invalid" }), null);
});

test("admin edits preserve old ledger dates until a new marker explicitly changes monthly membership", () => {
  const report = createReport("8月账");
  const untouched = createReport("2025年12月账");
  const untouchedBefore = getAdminReimbursementReportDetail(untouched.id);
  let current = report;

  for (const noteToAppend of ["补充付款说明", "13月账"]) {
    const result = updateAdminReimbursementReport({
      reimbursementReportId: report.id,
      expectedUpdatedAt: current.updatedAt,
      noteToAppend,
      referenceDateTime: "2027-10-20T10:00:00Z",
    });
    assert.equal(result.status, "updated");
    if (result.status !== "updated") throw new Error("Expected an updated report");
    current = result.report;
    assert.equal(current.createdAt, report.createdAt);
  }

  const amountEdit = updateAdminReimbursementReport({
    reimbursementReportId: report.id,
    expectedUpdatedAt: current.updatedAt,
    amount: 40,
    referenceDateTime: "2027-10-20T10:00:00Z",
  });
  assert.equal(amountEdit.status, "updated");
  if (amountEdit.status !== "updated") throw new Error("Expected an updated report");
  assert.equal(amountEdit.report.createdAt, report.createdAt);

  const result = updateAdminReimbursementReport({
    reimbursementReportId: report.id,
    expectedUpdatedAt: amountEdit.report.updatedAt,
    noteToAppend: "9月帐",
    referenceDateTime: "2027-10-20T10:00:00Z",
  });
  assert.equal(result.status, "updated");
  if (result.status !== "updated") throw new Error("Expected an updated report");
  assert.equal(result.report.createdAt, "2027-09-30 15:59:59");
  assert.equal(result.report.note, "8月账；补充付款说明；13月账；9月帐");
  assert.equal(result.report.amount, 40);
  assert.equal(result.report.expenseCategory, report.expenseCategory);
  assert.equal(result.report.voucherDate, report.voucherDate);
  assert.deepEqual(getAdminReimbursementReportDetail(untouched.id), untouchedBefore);

  const readMonth = (month: string) => readMonthlyRecords({ month, store: "fuzzy", timeZone: "Asia/Shanghai", scope: {} })!.records;
  assert.equal(readMonth("2026-08").some(item => item.id === report.id), false);
  assert.equal(readMonth("2027-09").some(item => item.id === report.id), true);
  assert.equal(readMonth("2027-10").some(item => item.id === report.id), false);
});

test("new bot remarks preserve ordinary edits and override earlier ledger notes with an explicit year", () => {
  const report = createReport("8月账");
  for (const note of ["补充说明", "13月帐", "2024年2月帐"]) {
    const referenceDateTime = "2027-10-20T10:00:00Z";
    const rawMessageId = createMessage(note, referenceDateTime);
    const updated = attachRemarkToReimbursementReport({ reimbursementReportId: report.id, rawMessageId, note, referenceDateTime });
    assert.equal(updated.createdAt, note === "2024年2月帐" ? "2024-02-29 15:59:59" : report.createdAt);
    assert.equal(updated.amount, report.amount);
    assert.equal(updated.voucherDate, report.voucherDate);
    assert.equal(getAdminReimbursementReportDetail(report.id)!.sources.some(source => source.rawMessageId === rawMessageId && source.role === "remark"), true);
  }
});

test("merging a later image preserves the old ledger date unless its new note contains a marker", () => {
  for (const [note, expected] of [
    ["补图说明", "2026-08-31 15:59:59"],
    ["9月帐", "2027-09-30 15:59:59"],
    ["2024年2月账", "2024-02-29 15:59:59"],
  ]) {
    const report = createReport("8月账");
    const referenceDateTime = "2027-10-20T10:00:00Z";
    const updated = mergePrimaryImageIntoTextOnlyReimbursementReport({
      reimbursementReportId: report.id,
      imageRawMessageId: createMessage("(非文本消息)", referenceDateTime, "6"),
      amount: 30,
      currency: "CNY",
      expenseCategory: "food",
      voucherDate: "2027-10-20",
      voucherDateSource: "message",
      note,
      merchant: null,
      documentNo: null,
      voucherType: null,
      ocrText: null,
      confidence: 1,
      needsReview: false,
      referenceDateTime,
    });
    assert.equal(updated.createdAt, expected);
    assert.equal(updated.note, `8月账；${note}`);
  }
});

test("moving an ordinary remark does not recalculate either report's old monthly marker", () => {
  const source = createReport("8月账");
  const target = createReport("4月账", "2026-05-22T10:00:00Z");
  const rawMessageId = createMessage("补充说明", "2027-10-20T10:00:00Z");
  attachRemarkToReimbursementReport({ reimbursementReportId: source.id, rawMessageId, note: "补充说明", referenceDateTime: "2027-10-20T10:00:00Z" });
  const moved = moveRemarkToReimbursementReport({ targetReimbursementReportId: target.id, rawMessageId, referenceDateTime: "2027-10-20T10:00:10Z" });
  assert.equal(moved.sourceReport.createdAt, source.createdAt);
  assert.equal(moved.targetReport.createdAt, target.createdAt);
  assert.equal(moved.sourceReport.note, "8月账");
  assert.equal(moved.targetReport.note, "4月账；补充说明");
});

test("moving a monthly remark uses its original receive time and overrides only the target's old marker", () => {
  const source = createReport("2026年12月账");
  const target = createReport("4月账", "2026-05-22T10:00:00Z");
  const rawMessageId = createMessage("12月帐", "2027-01-20T10:00:00Z");
  const updated = attachRemarkToReimbursementReport({ reimbursementReportId: source.id, rawMessageId, note: "12月帐", referenceDateTime: "2027-01-20T10:00:00Z" });
  const moved = moveRemarkToReimbursementReport({ targetReimbursementReportId: target.id, rawMessageId, referenceDateTime: "2028-01-20T10:00:00Z" });
  assert.equal(moved.sourceReport.createdAt, updated.createdAt);
  assert.equal(moved.targetReport.createdAt, "2026-12-31 15:59:59");
  assert.equal(moved.targetReport.note, "4月账；12月帐");
});

test("batch imports apply monthly notes independently of model voucher dates", async () => {
  const localPath = path.join(process.env.WECHATY_STATE_DIR!, "batch-ledger.png");
  fs.writeFileSync(localPath, "test-image");
  const reports = await importBatchReimbursementReports({
    attachments: [0, 1].map(index => ({ type: "image", localPath, sha256: `ledger-${index}`, mimeType: "image/png" })),
    channelCode: "reimbursement_fuzzy",
    channelName: "月账测试群",
    reporter: "月账测试",
    notes: ["12月帐", "2024年2月账"],
    sentAt: "2027-01-20T10:00:00Z",
    modelConfig: { provider: "qwen", model: "test-model", apiKey: "test-key" },
    timeZone: "Asia/Shanghai",
  }, async input => ({
    scenarioCode: "reimbursement",
    extractorCode: "model-test-v1",
    status: "extracted",
    confidence: 1,
    needsReview: false,
    resultJson: {
      eventType: "reimbursement_report", rawMessageId: input.rawMessageId, channelName: input.channelName,
      reporter: input.reporter, reportedAt: input.sentAt, amount: 20, currency: "CNY", expenseCategory: "food",
      voucherDate: "2027-01-19", voucherDateSource: "model", note: "模型备注", evidenceType: "image+text",
      merchant: null, documentNo: null, voucherType: null, ocrText: null,
    },
  }));
  assert.deepEqual(reports.map(item => item.report.createdAt), ["2026-12-31 15:59:59", "2024-02-29 15:59:59"]);
  assert.deepEqual(reports.map(item => item.report.voucherDate), ["2027-01-19", "2027-01-19"]);
});
