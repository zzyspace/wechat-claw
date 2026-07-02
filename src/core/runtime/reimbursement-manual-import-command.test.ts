import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManualReimbursementImportUsageText,
  parseManualReimbursementImportCliArgs,
  renderManualReimbursementImportResult,
} from "./reimbursement-manual-import-command.js";

test("parseManualReimbursementImportCliArgs parses required and optional values", () => {
  const options = parseManualReimbursementImportCliArgs(
    [
      "--channel-code",
      "reimbursement_fuzzy",
      "--reporter",
      "张三",
      "--amount",
      "36.5",
      "--category",
      "食材",
      "--note",
      "午餐报账",
      "--sent-at",
      "2026-07-02T14:32:00+08:00",
    ],
    {
      now: new Date("2026-07-02T00:00:00.000Z"),
    },
  );

  assert.equal(options.channelCode, "reimbursement_fuzzy");
  assert.equal(options.reporter, "张三");
  assert.equal(options.amount, 36.5);
  assert.equal(options.expenseCategory, "food");
  assert.equal(options.note, "午餐报账");
  assert.equal(options.sentAt, "2026-07-02T06:32:00.000Z");
});

test("parseManualReimbursementImportCliArgs defaults sentAt to now", () => {
  const options = parseManualReimbursementImportCliArgs(
    [
      "--channel-code",
      "reimbursement_fuzzy",
      "--reporter",
      "张三",
      "--amount",
      "36.5",
      "--category",
      "other",
    ],
    {
      now: new Date("2026-07-02T01:02:03.000Z"),
    },
  );

  assert.equal(options.sentAt, "2026-07-02T01:02:03.000Z");
});

test("parseManualReimbursementImportCliArgs returns usage on help", () => {
  assert.throws(
    () => parseManualReimbursementImportCliArgs(["--help"]),
    (error: unknown) =>
      error instanceof Error && error.message === buildManualReimbursementImportUsageText(),
  );
});

test("renderManualReimbursementImportResult prints a readable summary", () => {
  const text = renderManualReimbursementImportResult(
    {
      extraction: {
        id: 1,
        rawMessageId: 101,
        scenarioCode: "reimbursement",
        extractorCode: "manual-import-v1",
        status: "extracted",
        confidence: 1,
        needsReview: false,
        resultJson: {},
        createdAt: "2026-07-02 06:32:00",
      },
      rawMessageId: 101,
      report: {
        id: 55,
        channelCode: "reimbursement_fuzzy",
        channelName: "模糊报账群",
        reporter: "张三",
        amount: 36.5,
        currency: "CNY",
        expenseCategory: "food",
        voucherDate: "2026-07-02",
        voucherDateSource: "message",
        note: "午餐报账",
        evidenceType: "text",
        merchant: null,
        documentNo: null,
        voucherType: null,
        ocrText: null,
        confidence: 1,
        needsReview: false,
        createdAt: "2026-07-02 06:32:00",
        updatedAt: "2026-07-02 06:32:00",
      },
      textContent: "午餐报账",
    },
    {
      amount: 36.5,
      channelCode: "reimbursement_fuzzy",
      channelName: "模糊报账群",
      expenseCategory: "food",
      reporter: "张三",
      sentAt: "2026-07-02T06:32:00.000Z",
      timeZone: "Asia/Shanghai",
    },
  );

  assert.match(text, /action=manual_imported/);
  assert.match(text, /channel=模糊报账群 \(reimbursement_fuzzy\)/);
  assert.match(text, /amount=36\.50 CNY/);
  assert.match(text, /category=food \(食材\)/);
  assert.match(text, /report_id=55/);
  assert.match(text, /raw_message_id=101/);
  assert.match(text, /extractor=manual-import-v1/);
});
