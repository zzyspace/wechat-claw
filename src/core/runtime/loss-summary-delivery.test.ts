import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { WechatyInstance } from "../../bot/types.js";
import { saveScenarioExtraction } from "../scenarios/scenario-extraction-repository.js";
import { saveRawMessage } from "../storage/raw-message-repository.js";
import type { ChannelConfig } from "../channels/types.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { sendLossDailySummary, sendLossWeeklySummary } from "./loss-summary-delivery.js";

const originalStateDir = process.env.WECHATY_STATE_DIR;

const logger = {
  debug() {
    // no-op
  },
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

function createBot(delivered: string[]): WechatyInstance {
  return {
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
}

function seedLossMessage(input: {
  channelCode: string;
  channelName: string;
  senderName: string;
  textContent: string;
  eventReceivedAt: string;
}) {
  const saveResult = saveRawMessage({
    messageExternalId: `${input.channelCode}:${input.senderName}:${input.eventReceivedAt}`,
    channelCode: input.channelCode,
    channelName: input.channelName,
    senderName: input.senderName,
    messageType: "text",
    textContent: input.textContent,
    eventReceivedAt: input.eventReceivedAt,
    dedupeKey: `${input.channelCode}:${input.senderName}:${input.eventReceivedAt}`,
    attachments: [],
  });

  saveScenarioExtraction({
    rawMessageId: saveResult.rawMessageId,
    scenarioCode: "loss-report",
    extractorCode: "heuristic",
    status: "extracted",
    confidence: 0.95,
    needsReview: false,
    resultJson: {
      rawMessageId: saveResult.rawMessageId,
      reportedAt: input.eventReceivedAt,
      isRelevant: true,
      evidenceType: "text",
      reporterSummary: "生菜 1份",
      notes: "变质",
      reasonCategory: "变质",
      items: [{ name: "生菜", quantity: 1, unit: "份", confidence: 0.95 }],
    },
  });
}

test("sendLossDailySummary renders and delivers the summary text", async () => {
  process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-summary-send-"));
  const delivered: string[] = [];
  const bot = createBot(delivered);
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
    attachmentRetentionDays: 60,
    alertEmailEnabled: false,
    alertEmailFrom: undefined,
    alertEmailTo: [],
    alertSmtpHost: undefined,
    alertSmtpPassword: undefined,
    alertSmtpPort: 587,
    alertSmtpSecure: false,
    alertSmtpUsername: undefined,
    botName: "wechat-loss-bot",
    channels: [channel],
    channelsSource: "json",
    coldStartIgnoreWindowSeconds: 60,
    debugMessageSnapshotEnabled: false,
    logDir: path.join(process.env.WECHATY_STATE_DIR, "logs"),
    logLevel: "info",
    logRetentionDays: 7,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossMergeWindowSeconds: 60,
    reimbursementBackwardTextMergeWindowSeconds: 3,
    reimbursementExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionModel: "qwen3.5-flash",
    reimbursementExtractionProvider: "qwen",
    stateDir: process.env.WECHATY_STATE_DIR,
    summaryPromptTemplate: "请汇总",
    timeZone: "Asia/Shanghai",
    watchdogMemoryLimitMb: 0,
    watchdogMemoryPersistenceSeconds: 300,
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

test("sendLossWeeklySummary renders a Sunday weekly report for the current week", async () => {
  process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-weekly-summary-send-"));
  const delivered: string[] = [];
  const bot = createBot(delivered);
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
    weeklySummarySchedule: "10 22 * * 0",
  };
  const config: AppConfig = {
    attachmentRetentionDays: 60,
    alertEmailEnabled: false,
    alertEmailFrom: undefined,
    alertEmailTo: [],
    alertSmtpHost: undefined,
    alertSmtpPassword: undefined,
    alertSmtpPort: 587,
    alertSmtpSecure: false,
    alertSmtpUsername: undefined,
    botName: "wechat-loss-bot",
    channels: [channel],
    channelsSource: "json",
    coldStartIgnoreWindowSeconds: 60,
    debugMessageSnapshotEnabled: false,
    logDir: path.join(process.env.WECHATY_STATE_DIR, "logs"),
    logLevel: "info",
    logRetentionDays: 7,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossMergeWindowSeconds: 60,
    reimbursementBackwardTextMergeWindowSeconds: 3,
    reimbursementExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionModel: "qwen3.5-flash",
    reimbursementExtractionProvider: "qwen",
    stateDir: process.env.WECHATY_STATE_DIR,
    summaryPromptTemplate: "",
    timeZone: "Asia/Shanghai",
    watchdogMemoryLimitMb: 0,
    watchdogMemoryPersistenceSeconds: 300,
  };

  seedLossMessage({
    channelCode: "loss_a",
    channelName: "门店A报损群",
    senderName: "小王",
    textContent: "生菜坏了",
    eventReceivedAt: "2026-05-18T02:00:00.000Z",
  });
  seedLossMessage({
    channelCode: "loss_a",
    channelName: "门店A报损群",
    senderName: "小李",
    textContent: "番茄坏了",
    eventReceivedAt: "2026-05-25T02:00:00.000Z",
  });

  const result = await sendLossWeeklySummary({
    bot,
    channel,
    config,
    logger,
    targetDate: "2026-05-24",
  });

  assert.equal(result.deliveredTargets, 1);
  assert.equal(result.totalTargets, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /^报损周报（2026-05-18 ~ 2026-05-24）/);
  assert.match(delivered[0] ?? "", /小王：/);
  assert.doesNotMatch(delivered[0] ?? "", /小李：/);
});
