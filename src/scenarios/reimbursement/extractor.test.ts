import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { extractReimbursementReport } from "./extractor.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("extractReimbursementReport calls qwen OCR and normalizes amount, date, and category", async () => {
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
        model: "qwen-vl-ocr-2025-11-20",
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
    );

    assert.equal(requestedBody.model, "qwen-vl-ocr-2025-11-20");
    assert.equal(result.extractorCode, "model-qwen-qwen-vl-ocr-2025-11-20");
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
      model: "qwen-vl-ocr-2025-11-20",
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
