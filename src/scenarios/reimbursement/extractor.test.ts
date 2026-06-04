import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { Logger } from "../../core/logging/logger.js";
import { extractReimbursementReport } from "./extractor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createLogger(records: Array<{ level: string; message: string; context?: Record<string, unknown> }>) {
  return {
    debug(message: string, context?: Record<string, unknown>) {
      records.push({ level: "debug", message, context });
    },
    error(message: string, context?: Record<string, unknown>) {
      records.push({ level: "error", message, context });
    },
    info(message: string, context?: Record<string, unknown>) {
      records.push({ level: "info", message, context });
    },
    warn(message: string, context?: Record<string, unknown>) {
      records.push({ level: "warn", message, context });
    },
  } satisfies Logger;
}

test("extractReimbursementReport calls qwen3.5-flash and normalizes amount, date, and category", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-extractor-"));
  const imagePath = path.join(tempDir, "receipt.jpg");
  let requestedBody: any;

  try {
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    globalThis.fetch = (async (_url, init) => {
      requestedBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  amount: "128.50",
                  currency: "人民币",
                  expense_category: "food",
                  voucher_date: "2026-05-20",
                  merchant: "测试菜场",
                  document_no: "NO123",
                  voucher_type: "收据",
                  ocr_text: "测试菜场 合计128.50",
                  confidence: 0.91,
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const result = await extractReimbursementReport(
      {
        rawMessageId: 1,
        channelCode: "reimbursement_a",
        channelName: "AI报账群",
        reporter: "小王",
        textContent: "晚餐食材",
        sentAt: "2026-05-21T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
        attachments: [
          {
            type: "image",
            localPath: imagePath,
            sha256: "abc",
            mimeType: "image/jpeg",
          },
        ],
      },
      {
        provider: "qwen",
        model: "qwen3.5-flash",
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
    );

    assert.equal(requestedBody.model, "qwen3.5-flash");
    const promptText = requestedBody.messages?.[0]?.content?.[0]?.text ?? "";
    assert.match(promptText, /外卖或商城订单页如果有多个商品、套餐或明细金额，但页面没有明确总金额，应把每个商品或明细的实际价格加总/);
    assert.match(promptText, /对于订单截图里的“总预算”金额，如果图中没有比它更明确的最终付款金额，也应把它作为最终付款总金额候选值/);
    assert.match(promptText, /微信聊天界面的转账截图如果包含多条转账记录，应把每条转账的金额加起来/);
    assert.match(promptText, /支付宝聊天界面的转账或代付截图如果包含多条记录，应把每条转账或代付的金额加起来/);
    assert.match(promptText, /如果识别结果表示这笔记录是退款、退回、退款成功或退款到账，amount 应返回负数/);
    assert.match(promptText, /只要明确包含“店长报账”字样一律输出 manager_reimbursement；无论是否满足前面其他条件，只要明确包含“李晨晨”字样且为多条转账、汇款记录的一律输出 planned_expense/);
    assert.match(promptText, /鲜花、花卉、绿植、花材、花束、菊花、百合等花店订单默认不属于 food/);
    assert.equal(result.extractorCode, "model-qwen-qwen3.5-flash");
    assert.equal(result.resultJson.amount, 128.5);
    assert.equal(result.resultJson.currency, "CNY");
    assert.equal(result.resultJson.expenseCategory, "food");
    assert.equal(result.resultJson.voucherDate, "2026-05-20");
    assert.equal(result.resultJson.voucherDateSource, "model");
    assert.equal(result.needsReview, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extractReimbursementReport falls back to message date and other category when model is unavailable", async () => {
  const result = await extractReimbursementReport(
    {
      rawMessageId: 2,
      channelCode: "reimbursement_a",
      channelName: "AI报账群",
      reporter: "小王",
      textContent: "打印纸报账 20元",
      sentAt: "2026-05-20T18:30:00.000Z",
      timeZone: "Asia/Shanghai",
      attachments: [],
    },
    {
      provider: "qwen",
      model: "qwen3.5-flash",
      baseUrl: "https://example.com",
    },
  );

  assert.equal(result.extractorCode, "heuristic-v1");
  assert.equal(result.resultJson.amount, 20);
  assert.equal(result.resultJson.expenseCategory, "other");
  assert.equal(result.resultJson.voucherDate, "2026-05-21");
  assert.equal(result.resultJson.voucherDateSource, "message");
  assert.equal(result.needsReview, false);
});

test("extractReimbursementReport retries once when the model returns an empty structured result", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-extractor-"));
  const imagePath = path.join(tempDir, "receipt.jpg");
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  let fetchCallCount = 0;
  const requestedModels: string[] = [];

  try {
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    globalThis.fetch = (async (_url, init) => {
      fetchCallCount += 1;
      requestedModels.push(JSON.parse(String(init?.body)).model);

      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "   ",
                },
              },
            ],
            id: "empty-first-attempt",
            usage: {
              prompt_tokens: 120,
              completion_tokens: 0,
              total_tokens: 120,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  amount: "88",
                  currency: "CNY",
                  expense_category: "other",
                  voucher_date: "2026-05-20",
                  merchant: "测试商户",
                  document_no: "DOC-88",
                  voucher_type: "小票",
                  ocr_text: "合计 88",
                  confidence: 0.86,
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const result = await extractReimbursementReport(
      {
        rawMessageId: 3,
        channelCode: "reimbursement_a",
        channelName: "AI报账群",
        reporter: "小王",
        textContent: "备注",
        sentAt: "2026-05-21T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
        attachments: [
          {
            type: "image",
            localPath: imagePath,
            sha256: "retry-on-empty",
            mimeType: "image/jpeg",
          },
        ],
      },
      {
        provider: "qwen",
        model: "qwen3.5-flash",
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
      createLogger(logs),
    );

    assert.equal(fetchCallCount, 2);
    assert.deepEqual(requestedModels, ["qwen3.5-flash", "qwen3.5-plus"]);
    assert.equal(result.extractorCode, "model-qwen-qwen3.5-plus");
    assert.equal(result.resultJson.amount, 88);

    const retryLog = logs.find((entry) => entry.message === "Reimbursement model returned empty structured result, retrying once");
    assert(retryLog);
    assert.equal(retryLog.level, "warn");
    assert.equal(retryLog.context?.attempt, 1);
    assert.equal(retryLog.context?.choiceCount, 1);
    assert.equal(retryLog.context?.finishReason, "stop");
    assert.equal(retryLog.context?.messageContentLength, 3);
    assert.equal(retryLog.context?.messageContentType, "string");
    assert.equal(retryLog.context?.responseId, "empty-first-attempt");
    assert.equal(retryLog.context?.retryModel, "qwen3.5-plus");
    assert.equal(retryLog.context?.usageTotalTokens, 120);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extractReimbursementReport falls back after the retry also returns an empty structured result", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-reimbursement-extractor-"));
  const imagePath = path.join(tempDir, "receipt.jpg");
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  let fetchCallCount = 0;
  const requestedModels: string[] = [];

  try {
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    globalThis.fetch = (async (_url, init) => {
      fetchCallCount += 1;
      requestedModels.push(JSON.parse(String(init?.body)).model);

      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "",
              },
            },
          ],
          id: `empty-attempt-${fetchCallCount}`,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const result = await extractReimbursementReport(
      {
        rawMessageId: 4,
        channelCode: "reimbursement_a",
        channelName: "AI报账群",
        reporter: "小王",
        textContent: "平",
        sentAt: "2026-05-21T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
        attachments: [
          {
            type: "image",
            localPath: imagePath,
            sha256: "still-empty",
            mimeType: "image/jpeg",
          },
        ],
      },
      {
        provider: "qwen",
        model: "qwen3.5-flash",
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
      createLogger(logs),
    );

    assert.equal(fetchCallCount, 2);
    assert.deepEqual(requestedModels, ["qwen3.5-flash", "qwen3.5-plus"]);
    assert.equal(result.extractorCode, "heuristic-v1");
    assert.equal(result.resultJson.ocrText, null);
    assert.equal(result.needsReview, true);

    const fallbackLog = logs.find((entry) => entry.message === "Reimbursement model returned no structured result, using heuristic fallback");
    assert(fallbackLog);
    assert.equal(fallbackLog.level, "warn");
    assert.equal(fallbackLog.context?.attempt, 2);
    assert.equal(fallbackLog.context?.model, "qwen3.5-plus");
    assert.equal(fallbackLog.context?.responseId, "empty-attempt-2");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
