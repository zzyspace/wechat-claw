import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelConfig } from "../core/channels/types.js";
import type { Logger } from "../core/logging/logger.js";
import { listRecentRawMessages } from "../core/storage/raw-message-repository.js";
import { handleMessage } from "./message-handler.js";

function createLogger(records: Array<{ level: string; message: string; context?: Record<string, unknown> }>) {
  return {
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

function createChannel(): ChannelConfig {
  return {
    code: "loss_a",
    deliveryTargets: [{ type: "contact_name", value: "Ryan。" }],
    enabled: true,
    match: {
      type: "room_topic",
      value: "AI测试群",
    },
    scenario: "loss-report",
    summarySchedule: "",
  };
}

test(
  "handleMessage skips storing text-only room messages",
  { concurrency: false },
  async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const beforeMessages = listRecentRawMessages(1000);

    await handleMessage(
      {
        id: () => "text-only-skip-test",
        room: async () => ({
          alias: async () => null,
          id: () => "room_1",
          topic: async () => "AI测试群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "talker_1",
          name: () => "Ryan。",
        }),
        text: () => "玻璃破了",
        type: () => 7,
      },
      {
        channels: [createChannel()],
        debugContactName: "Ryan。",
        lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      createLogger(logs),
    );

    const afterMessages = listRecentRawMessages(1000);

    assert.equal(afterMessages.length, beforeMessages.length);
    assert.equal(
      afterMessages.some((message) => message.messageExternalId === "text-only-skip-test"),
      false,
    );
    assert(logs.some((entry) => entry.message === "Skipped text-only room message"));
    assert.equal(logs.some((entry) => entry.message === "Received room message"), false);
  },
);
