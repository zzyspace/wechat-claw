import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManualReimbursementImportMessageFormatText,
  parseManualReimbursementImportMessageCommand,
} from "./reimbursement-manual-import-message-command.js";

test("parseManualReimbursementImportMessageCommand parses fixed structured message", () => {
  const command = parseManualReimbursementImportMessageCommand([
    "补录报账",
    "channel_code: reimbursement_fuzzy",
    "reporter: 张三",
    "amount: 36.5",
    "category: 食材",
    "note: 午餐报账",
    "sent_at: 2026-07-02T14:32:00+08:00",
  ].join("\n"));

  assert.deepEqual(command, {
    amount: 36.5,
    channelCode: "reimbursement_fuzzy",
    expenseCategory: "food",
    note: "午餐报账",
    reporter: "张三",
    sentAt: "2026-07-02T06:32:00.000Z",
  });
});

test("parseManualReimbursementImportMessageCommand supports Chinese field names", () => {
  const command = parseManualReimbursementImportMessageCommand([
    "补录报账",
    "群聊代码：reimbursement_fuzzy",
    "报账人：张三",
    "金额：-12.5",
    "分类：其他",
    "备注：退款冲销",
  ].join("\n"));

  assert.deepEqual(command, {
    amount: -12.5,
    channelCode: "reimbursement_fuzzy",
    expenseCategory: "other",
    note: "退款冲销",
    reporter: "张三",
    sentAt: undefined,
  });
});

test("parseManualReimbursementImportMessageCommand returns null for unrelated text", () => {
  assert.equal(parseManualReimbursementImportMessageCommand("hello"), null);
});

test("parseManualReimbursementImportMessageCommand throws on malformed command", () => {
  assert.throws(
    () =>
      parseManualReimbursementImportMessageCommand([
        "补录报账",
        "channel_code: reimbursement_fuzzy",
        "amount: abc",
      ].join("\n")),
    /Invalid amount/,
  );
});

test("buildManualReimbursementImportMessageFormatText prints an example payload", () => {
  const text = buildManualReimbursementImportMessageFormatText();

  assert.match(text, /^补录报账$/m);
  assert.match(text, /channel_code: reimbursement_fuzzy/);
  assert.match(text, /reporter: 张三/);
});
