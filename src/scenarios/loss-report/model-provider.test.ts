import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { extractLossReportByModel } from "./model-provider.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("extractLossReportByModel ignores model is_relevant=false for image messages", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-model-provider-"));
  const imagePath = path.join(tempDir, "sample.jpg");

  try {
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  is_relevant: false,
                  reporter_summary: "玻璃杯",
                  reason_category: "破损",
                  notes: "",
                  items: [
                    {
                      name: "玻璃杯",
                      quantity: 1,
                      unit: "个",
                      confidence: 0.92,
                    },
                  ],
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
      )) as typeof fetch;

    const result = await extractLossReportByModel(
      {
        rawMessageId: 1,
        channelName: "AI测试群2",
        senderName: "Ryan。",
        textContent: "(非文本消息)",
        sentAt: "2026-05-20T08:20:54.464Z",
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
        enabled: true,
        provider: "qwen",
        model: "qwen3-vl-flash",
        apiKey: "test-key",
        baseUrl: "https://example.com",
      },
    );

    assert(result);
    assert.equal(result.status, "extracted");
    assert.equal(result.resultJson.isRelevant, true);
    assert.equal(result.resultJson.items[0]?.name, "玻璃杯");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
