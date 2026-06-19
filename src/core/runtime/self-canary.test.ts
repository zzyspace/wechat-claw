import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { buildSelfCanaryMessage, extractSelfCanaryToken, startSelfCanaryManager } from "./self-canary.js";

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

function createConfig(
  stateDir: string,
  options: {
    autoResetEnabled?: boolean;
    failureThreshold?: number;
  } = {},
): AppConfig {
  return {
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
    channels: [],
    channelsSource: "json",
    coldStartIgnoreWindowSeconds: 60,
    debugMessageSnapshotEnabled: false,
    logDir: path.join(stateDir, "logs"),
    logLevel: "info",
    logRetentionDays: 7,
    lossExtractionApiKey: undefined,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossExtractionModel: undefined,
    lossExtractionProvider: undefined,
    lossMergeWindowSeconds: 60,
    reimbursementBackwardTextMergeWindowSeconds: 3,
    puppet: "wechaty-puppet-wechat",
    puppetServiceToken: undefined,
    reimbursementExtractionApiKey: undefined,
    reimbursementExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionModel: "qwen3.5-flash",
    reimbursementExtractionProvider: "qwen",
    selfCanary: {
      enabled: true,
      targetContactName: "文件传输助手",
      intervalSeconds: 1,
      ackTimeoutSeconds: 1,
      failureThreshold: options.failureThreshold ?? 2,
      autoResetEnabled: options.autoResetEnabled ?? false,
    },
    stateDir,
    summaryPromptTemplate: "",
    timeZone: "Asia/Shanghai",
    watchdogMemoryLimitMb: 0,
    watchdogMemoryPersistenceSeconds: 300,
  };
}

test("extractSelfCanaryToken parses only canary messages", () => {
  const text = buildSelfCanaryMessage("abc-123");

  assert.equal(extractSelfCanaryToken(text), "abc-123");
  assert.equal(extractSelfCanaryToken("hello"), null);
});

test("self canary acknowledges matching self message and resets failure count", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-self-canary-"));
  const deliveredTexts: string[] = [];
  const bot = {
    Contact: {
      find: async () => ({
        async say(text: string) {
          deliveredTexts.push(text);
        },
      }),
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
  };

  const manager = startSelfCanaryManager({
    bot,
    config: createConfig(stateDir),
    logger,
    initialDelayMs: 5,
  });

  manager.notifyLogin();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(deliveredTexts.length, 1);
  const token = extractSelfCanaryToken(deliveredTexts[0] ?? "");
  assert.ok(token);

  await manager.observeMessage({
    self() {
      return true;
    },
    text() {
      return deliveredTexts[0] ?? "";
    },
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "self-canary.json"), "utf8"));
  assert.equal(state.status, "acked");
  assert.equal(state.consecutiveFailureCount, 0);

  manager.stop();
});

test("self canary requests reset after repeated failures when auto reset is enabled", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-self-canary-"));
  const failurePayloads: Array<Record<string, unknown>> = [];
  const bot = {
    Contact: {
      find: async () => ({
        async say() {
          // no-op
        },
      }),
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
  };

  const manager = startSelfCanaryManager({
    bot,
    config: createConfig(stateDir, {
      autoResetEnabled: true,
      failureThreshold: 1,
    }),
    logger,
    initialDelayMs: 5,
    onFailureThresholdReached(payload) {
      failurePayloads.push(payload);
    },
  });

  manager.notifyLogin();
  const deadline = Date.now() + 2500;
  while (failurePayloads.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(failurePayloads.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "self-canary.json"), "utf8"));
  assert.equal(state.status, "reset_requested");

  manager.stop();
});
