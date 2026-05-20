import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { WechatyInstance } from "../../bot/types.js";
import type { ChannelConfig } from "../channels/types.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { sendLossDailySummary } from "./loss-summary-delivery.js";

const originalStateDir = process.env.WECHATY_STATE_DIR;

const logger = {
  error() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
} satisfies Logger;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.WECHATY_STATE_DIR;
    return;
  }

  process.env.WECHATY_STATE_DIR = originalStateDir;
});

test("sendLossDailySummary renders and delivers the summary text", async () => {
  process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-summary-send-"));
  const delivered: string[] = [];
  const bot = {
    Contact: {
      find: async (query: Record<string, unknown>) =>
        query.name === "店长A"
          ? {
              async say(text: string) {
                delivered.push(text);
              },
            }
          : null,
    },
    isLoggedIn: true,
    on() {
      return this;
    },
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
  } satisfies WechatyInstance;
  const channel: ChannelConfig = {
    code: "loss_a",
    deliveryTargets: [{ type: "contact_name", value: "店长A" }],
    enabled: true,
    match: {
      type: "room_topic",
      value: "门店A报损群",
    },
    scenario: "loss-report",
    summarySchedule: "",
  };
  const config: AppConfig = {
    botName: "wechat-loss-bot",
    channels: [channel],
    channelsSource: "json",
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossMergeWindowSeconds: 60,
    stateDir: process.env.WECHATY_STATE_DIR,
    summaryPromptTemplate: "请汇总",
    timeZone: "Asia/Shanghai",
  };

  const result = await sendLossDailySummary({
    bot,
    channel,
    config,
    logger,
    targetDate: "2026-05-20",
  });

  assert.equal(result.deliveredTargets, 1);
  assert.equal(result.totalTargets, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /报损日报（2026-05-20）/);
});
