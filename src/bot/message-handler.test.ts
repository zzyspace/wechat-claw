import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ChannelConfig } from "../core/channels/types.js";
import type { Logger } from "../core/logging/logger.js";
import { listRecentRawMessages } from "../core/storage/raw-message-repository.js";
import { handleMessage } from "./message-handler.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-message-handler-"));

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
        lossMergeWindowSeconds: 30,
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

test(
  "handleMessage keeps text-only messages when a recent image from the same sender exists",
  { concurrency: false },
  async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const imageMessageId = "image-before-text-test";
    const textMessageId = "text-after-image-test";

    await handleMessage(
      {
        id: () => imageMessageId,
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
        text: () => "",
        toFileBox: async () => ({
          name: "sample.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
        wechaty: {
          Contact: {
            find: async () => null,
          },
          on() {
            return this;
          },
          async start() {
            // no-op
          },
          async stop() {
            // no-op
          },
        },
      },
      {
        channels: [createChannel()],
        debugContactName: "Ryan。",
        lossMergeWindowSeconds: 30,
        lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      createLogger(logs),
    );

    await handleMessage(
      {
        id: () => textMessageId,
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
        wechaty: {
          Contact: {
            find: async () => null,
          },
          on() {
            return this;
          },
          async start() {
            // no-op
          },
          async stop() {
            // no-op
          },
        },
      },
      {
        channels: [createChannel()],
        debugContactName: "Ryan。",
        lossMergeWindowSeconds: 30,
        lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      createLogger(logs),
    );

    const recentMessages = listRecentRawMessages(1000);

    assert.equal(
      recentMessages.some((message) => message.messageExternalId === imageMessageId),
      true,
    );
    assert.equal(
      recentMessages.some((message) => message.messageExternalId === textMessageId),
      true,
    );
    assert.equal(logs.some((entry) => entry.message === "Skipped text-only room message"), false);
  },
);
