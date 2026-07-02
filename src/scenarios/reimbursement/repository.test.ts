import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getZonedDateParts } from "../../core/runtime/timezone.js";
import { saveRawMessage } from "../../core/storage/raw-message-repository.js";
import {
  attachRemarkToReimbursementReport,
  findAdminReimbursementAttachment,
  getAdminReimbursementReportDetail,
  listAdminReimbursementReports,
  mergePrimaryImageIntoTextOnlyReimbursementReport,
  saveReimbursementReceiptDelivery,
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

test("mergePrimaryImageIntoTextOnlyReimbursementReport clears text-only needsReview when image has amount", () => {
  const textMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-merge-needs-review-text",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "7",
    textContent: "平",
    eventReceivedAt: "2026-07-21T10:00:00.000Z",
    dedupeKey: "reimbursement-repository-merge-needs-review-text",
    attachments: [],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    reporter: "小陈",
    amount: null,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-07-21",
    voucherDateSource: "message",
    note: "平",
    evidenceType: "text",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 0.45,
    needsReview: true,
    primaryRawMessageId: textMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-21T10:00:00.000Z",
  });
  const imageMessage = saveRawMessage({
    messageExternalId: "reimbursement-repository-merge-needs-review-image",
    channelCode: "reimbursement_repository_test",
    channelName: "报账仓储测试群",
    senderName: "小陈",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-21T10:00:10.000Z",
    dedupeKey: "reimbursement-repository-merge-needs-review-image",
    attachments: [],
  });

  const updated = mergePrimaryImageIntoTextOnlyReimbursementReport({
    reimbursementReportId: report.id,
    imageRawMessageId: imageMessage.rawMessageId,
    amount: 3968.25,
    currency: "CNY",
    expenseCategory: "food",
    voucherDate: "2026-07-21",
    voucherDateSource: "model",
    note: "",
    merchant: "广东澳美佳供应链",
    documentNo: "AMJ-00-20260520-149",
    voucherType: "销售单",
    ocrText: "合计总金额 3,968.25",
    confidence: 0.95,
    needsReview: false,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-21T10:00:10.000Z",
  });

  assert.equal(updated.amount, 3968.25);
  assert.equal(updated.needsReview, false);
});

test("listAdminReimbursementReports filters by search, category, review status, and voucher date range", () => {
  const searchMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-list-search-primary",
    channelCode: "reimbursement_admin_list_test",
    channelName: "报账后台列表测试群",
    senderName: "小周",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-22T01:00:00.000Z",
    dedupeKey: "reimbursement-admin-list-search-primary",
    attachments: [],
  });
  const searchReport = saveReimbursementReport({
    channelCode: "reimbursement_admin_list_test",
    channelName: "报账后台列表测试群",
    reporter: "小周",
    amount: 188.8,
    currency: "CNY",
    expenseCategory: "food",
    voucherDate: "2026-07-22",
    voucherDateSource: "model",
    note: "午餐采购",
    evidenceType: "image+text",
    merchant: "测试菜场",
    documentNo: "LIST-001",
    voucherType: "小票",
    ocrText: "测试菜场 合计188.80",
    confidence: 0.92,
    needsReview: false,
    primaryRawMessageId: searchMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-22T01:00:00.000Z",
  });
  const reviewMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-list-review-primary",
    channelCode: "reimbursement_admin_list_test",
    channelName: "报账后台列表测试群",
    senderName: "小李",
    messageType: "7",
    textContent: "待补票",
    eventReceivedAt: "2026-07-23T01:00:00.000Z",
    dedupeKey: "reimbursement-admin-list-review-primary",
    attachments: [],
  });
  const reviewReport = saveReimbursementReport({
    channelCode: "reimbursement_admin_list_test",
    channelName: "报账后台列表测试群",
    reporter: "小李",
    amount: null,
    currency: "CNY",
    expenseCategory: "other",
    voucherDate: "2026-07-23",
    voucherDateSource: "message",
    note: "待补票",
    evidenceType: "text",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: "店长报账待确认",
    confidence: 0.51,
    needsReview: true,
    primaryRawMessageId: reviewMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-23T01:00:00.000Z",
  });

  const filtered = listAdminReimbursementReports({
    search: "测试菜场",
    channelCode: "reimbursement_admin_list_test",
    reporter: "小周",
    expenseCategory: "food",
    needsReview: false,
    createdDateFrom: "2026-07-20",
    createdDateTo: "2026-07-22",
    timeZone: "Asia/Shanghai",
    limit: 20,
    offset: 0,
  });

  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.id, searchReport.id);
  assert.equal(filtered.items[0]?.expenseCategoryLabel, "食材");

  const numericSearch = listAdminReimbursementReports({
    search: String(reviewReport.id),
    limit: 20,
    offset: 0,
  });

  assert.equal(numericSearch.total, 1);
  assert.equal(numericSearch.items[0]?.id, reviewReport.id);
  assert.equal(numericSearch.items[0]?.needsReview, true);
});

test("getAdminReimbursementReportDetail includes source attachments and receipt deliveries", () => {
  const existingAttachmentPath = path.join(
    process.env.WECHATY_STATE_DIR || os.tmpdir(),
    "reimbursement-admin-detail-existing.jpg",
  );
  const missingAttachmentPath = path.join(
    process.env.WECHATY_STATE_DIR || os.tmpdir(),
    "reimbursement-admin-detail-missing.jpg",
  );
  fs.writeFileSync(existingAttachmentPath, "existing-detail-image", "utf8");
  fs.writeFileSync(missingAttachmentPath, "missing-detail-image", "utf8");

  const existingMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-detail-existing-primary",
    channelCode: "reimbursement_admin_detail_test",
    channelName: "报账后台详情测试群",
    senderName: "小王",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-07-24T01:00:00.000Z",
    dedupeKey: "reimbursement-admin-detail-existing-primary",
    attachments: [
      {
        type: "image",
        localPath: existingAttachmentPath,
        sha256: "detail-existing-sha256",
        mimeType: "image/jpeg",
      },
    ],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_admin_detail_test",
    channelName: "报账后台详情测试群",
    reporter: "小王",
    amount: 66.6,
    currency: "CNY",
    expenseCategory: "food",
    voucherDate: "2026-07-24",
    voucherDateSource: "model",
    note: "早餐采购",
    evidenceType: "image+text",
    merchant: "晨市档口",
    documentNo: "DETAIL-001",
    voucherType: "小票",
    ocrText: "晨市档口 66.60",
    confidence: 0.95,
    needsReview: false,
    primaryRawMessageId: existingMessage.rawMessageId,
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-24T01:00:00.000Z",
  });
  const missingMessage = saveRawMessage({
    messageExternalId: "reimbursement-admin-detail-missing-remark",
    channelCode: "reimbursement_admin_detail_test",
    channelName: "报账后台详情测试群",
    senderName: "小王",
    messageType: "7",
    textContent: "附加说明",
    eventReceivedAt: "2026-07-24T01:00:10.000Z",
    dedupeKey: "reimbursement-admin-detail-missing-remark",
    attachments: [
      {
        type: "image",
        localPath: missingAttachmentPath,
        sha256: "detail-missing-sha256",
        mimeType: "image/jpeg",
      },
    ],
  });

  attachRemarkToReimbursementReport({
    reimbursementReportId: report.id,
    rawMessageId: missingMessage.rawMessageId,
    note: "附加说明",
    timeZone: "Asia/Shanghai",
    referenceDateTime: "2026-07-24T01:00:10.000Z",
  });
  saveReimbursementReceiptDelivery({
    reimbursementReportId: report.id,
    channelCode: "reimbursement_admin_detail_test",
    targetType: "room_topic",
    targetValue: "报账后台详情测试群",
    receiptText: "报账66.6元已录入(分类: 食材)",
    sentAt: "2026-07-24T01:01:00.000Z",
  });

  fs.unlinkSync(missingAttachmentPath);

  const detail = getAdminReimbursementReportDetail(report.id);

  assert(detail);
  assert.equal(detail.expenseCategoryLabel, "食材");
  assert.equal(detail.sources.length, 2);
  assert.equal(detail.receiptDeliveries.length, 1);
  assert.equal(detail.sources[0]?.attachments[0]?.exists, true);
  assert.equal(detail.sources[1]?.attachments[0]?.exists, false);

  const existingAttachment = detail.sources[0]?.attachments[0];
  const missingAttachment = detail.sources[1]?.attachments[0];

  assert(existingAttachment);
  assert(missingAttachment);
  assert.equal(findAdminReimbursementAttachment(existingAttachment.id)?.exists, true);
  assert.equal(findAdminReimbursementAttachment(missingAttachment.id)?.exists, false);
});
