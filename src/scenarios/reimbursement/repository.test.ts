import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getZonedDateParts } from "../../core/runtime/timezone.js";
import { saveRawMessage } from "../../core/storage/raw-message-repository.js";
import {
  attachRemarkToReimbursementReport,
  mergePrimaryImageIntoTextOnlyReimbursementReport,
  saveReimbursementReport,
} from "./repository.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-repository-"));

function formatLocalTimestamp(value: string, timeZone: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

test("saveReimbursementReport backdates createdAt when note contains x月账", () => {
  const primaryMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-created-at-primary",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "7",
    textContent: "4月账",
    eventReceivedAt: "2026-05-22T10:00:00.000Z",
    dedupeKey: "reimbursement-repository-created-at-primary",
    attachments: [],
  });

  const report = saveReimbursementReport({
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    reporter: "小陈",
    amount: 20,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-05-22",
    voucherDateSource: "message",
    note: "4月账",
    evidenceType: "text",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.72,
    needsReview: false,
    primaryRawMessageId: primaryMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-05-22T10:00:00.000Z",
  });

  assert.equal(formatLocalTimestamp(report.createdAt, "Asia/Shanghai"), "2026-04-30 00:00:00");
});

test("attachRemarkToReimbursementReport backdates createdAt when merged note contains x月账", () => {
  const primaryMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-remark-primary",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-06-22T10:00:00.000Z",
    dedupeKey: "reimbursement-repository-remark-primary",
    attachments: [],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    reporter: "小陈",
    amount: null,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-06-22",
    voucherDateSource: "message",
    note: "平",
    evidenceType: "image",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.45,
    needsReview: true,
    primaryRawMessageId: primaryMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-06-22T10:00:00.000Z",
  });
  const remarkMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-remark-secondary",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "7",
    textContent: "5月账",
    eventReceivedAt: "2026-06-22T10:00:15.000Z",
    dedupeKey: "reimbursement-repository-remark-secondary",
    attachments: [],
  });

  const updated = attachRemarkToReimbursementReport({
    reimbursementReportId: report.id,
    rawMessageId: remarkMessage.rawMessageId,
    note: "5月账",
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-06-22T10:00:15.000Z",
  });

  assert.equal(updated.note, "平；5月账");
  assert.equal(formatLocalTimestamp(updated.createdAt, "Asia/Shanghai"), "2026-05-31 00:00:00");
});

test("mergePrimaryImageIntoTextOnlyReimbursementReport backdates createdAt when merged note contains x月账", () => {
  const textMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-merge-text",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "7",
    textContent: "平",
    eventReceivedAt: "2026-07-20T10:00:00.000Z",
    dedupeKey: "reimbursement-repository-merge-text",
    attachments: [],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    reporter: "小陈",
    amount: 10,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-07-20",
    voucherDateSource: "message",
    note: "平",
    evidenceType: "text",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.72,
    needsReview: false,
    primaryRawMessageId: textMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-20T10:00:00.000Z",
  });
  const imageMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-merge-image",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-20T10:00:10.000Z",
    dedupeKey: "reimbursement-repository-merge-image",
    attachments: [],
  });

  const updated = mergePrimaryImageIntoTextOnlyReimbursementReport({
    reimbursementReportId: report.id,
    imageRawMessageId: imageMessage.rawMessageId,
    amount: 30,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-07-20",
    voucherDateSource: "message",
    note: "6月账",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.9,
    needsReview: false,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-20T10:00:10.000Z",
  });

  assert.equal(updated.note, "平；6月账");
  assert.equal(formatLocalTimestamp(updated.createdAt, "Asia/Shanghai"), "2026-06-30 00:00:00");
});
