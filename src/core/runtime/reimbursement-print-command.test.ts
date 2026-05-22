import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReimbursementReportDetail } from "../../scenarios/reimbursement/types.js";
import { saveRawMessage } from "../storage/raw-message-repository.js";
import {
  buildPrintReimbursementUsageText,
  parsePrintReimbursementCliArgs,
  renderReimbursementReportList,
} from "./reimbursement-print-command.js";
import {
  attachRemarkToReimbursementReport,
  listReimbursementReportDetails,
  saveReimbursementReport,
} from "../../scenarios/reimbursement/repository.js";

test("parsePrintReimbursementCliArgs supports channel and limit filters", () => {
  const options = parsePrintReimbursementCliArgs(["--channel", "reimbursement_test", "--limit", "20"]);

  assert.equal(options.channelCode, "reimbursement_test");
  assert.equal(options.limit, 20);
});

test("parsePrintReimbursementCliArgs returns usage on help", () => {
  assert.throws(
    () => parsePrintReimbursementCliArgs(["--help"]),
    (error: unknown) =>
      error instanceof Error && error.message === buildPrintReimbursementUsageText(),
  );
});

test("renderReimbursementReportList prints readable report details with sources", () => {
  const primaryMessage = saveRawMessage({
    messageExternalId: "reimbursement-print-primary",
    channelCode: "reimbursement_print_test",
    channelName: "报账打印测试群",
    senderName: "小周",
    messageType: "6",
    textContent: "(非文本消息)",
    eventReceivedAt: "2026-05-21T01:00:00.000Z",
    dedupeKey: "reimbursement-print-primary",
    attachments: [],
  });
  const report = saveReimbursementReport({
    channelCode: "reimbursement_print_test",
    channelName: "报账打印测试群",
    reporter: "小周",
    amount: 128.5,
    currency: "CNY",
    expenseCategory: "food",
    voucherDate: "2026-05-20",
    voucherDateSource: "model",
    note: "",
    evidenceType: "image",
    merchant: "测试菜场",
    documentNo: "A-001",
    voucherType: "小票",
    ocrText: "测试菜场 合计128.50",
    confidence: 0.91,
    needsReview: false,
    primaryRawMessageId: primaryMessage.rawMessageId,
  });
  const remarkMessage = saveRawMessage({
    messageExternalId: "reimbursement-print-remark",
    channelCode: "reimbursement_print_test",
    channelName: "报账打印测试群",
    senderName: "小周",
    messageType: "7",
    textContent: "晚餐食材采购",
    eventReceivedAt: "2026-05-21T01:00:15.000Z",
    dedupeKey: "reimbursement-print-remark",
    attachments: [],
  });

  attachRemarkToReimbursementReport({
    reimbursementReportId: report.id,
    rawMessageId: remarkMessage.rawMessageId,
    note: "晚餐食材采购",
  });

  const details = listReimbursementReportDetails({
    channelCode: "reimbursement_print_test",
  });
  const text = renderReimbursementReportList(details, {
    channelCode: "reimbursement_print_test",
  });

  assert.match(text, /timezone=Asia\/Shanghai/);
  assert.match(text, /reports=1/);
  assert.match(text, /报账ID: \d+/);
  assert.match(text, /群聊: 报账打印测试群 \(reimbursement_print_test\)/);
  assert.match(text, /金额: 128\.50 CNY/);
  assert.match(text, /类别: 食材/);
  assert.match(text, /票据日期: 2026-05-20 \(model\)/);
  assert.match(text, /备注: 晚餐食材采购/);
  assert.match(text, /来源消息数: 2/);
  assert.match(text, /\[primary\] raw_message_id=\d+/);
  assert.match(text, /\[remark\] raw_message_id=\d+/);
  assert.match(text, /text=晚餐食材采购/);
});

test("renderReimbursementReportList formats runtime timestamps in the selected timezone", () => {
  const reports: ReimbursementReportDetail[] = [
    {
      id: 1,
      channelCode: "reimbursement_print_test",
      channelName: "报账打印测试群",
      reporter: "小周",
      amount: 128.5,
      currency: "CNY",
      expenseCategory: "food",
      voucherDate: "2026-05-20",
      voucherDateSource: "model",
      note: "晚餐食材采购",
      evidenceType: "image+text",
      merchant: "测试菜场",
      documentNo: "A-001",
      voucherType: "小票",
      ocrText: "测试菜场 合计128.50",
      confidence: 0.91,
      needsReview: false,
      createdAt: "2026-05-21 00:00:00",
      updatedAt: "2026-05-21 00:00:14",
      sources: [],
    },
  ];

  const text = renderReimbursementReportList(reports, {
    channelCode: "reimbursement_print_test",
    timeZone: "Asia/Shanghai",
  });

  assert.match(text, /创建时间: 2026-05-21 08:00:00 \(Asia\/Shanghai\)/);
  assert.match(text, /更新时间: 2026-05-21 08:00:14 \(Asia\/Shanghai\)/);
});
