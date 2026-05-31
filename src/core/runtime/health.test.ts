import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { HealthReporter } from "./health.js";

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

function createConfig(stateDir: string): AppConfig {
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
    stateDir,
    summaryPromptTemplate: "",
    timeZone: "Asia/Shanghai",
    watchdogMemoryLimitMb: 0,
    watchdogMemoryPersistenceSeconds: 300,
  };
}

test("HealthReporter preserves degradedSinceAt across repeated degraded errors", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-health-"));
  const reporter = new HealthReporter(createConfig(stateDir), logger);
  reporter.initialize();

  reporter.markError(new Error("first failure"), {
    category: "login_state_invalid",
    status: "degraded",
  });
  const first = reporter.getSnapshot();

  await new Promise((resolve) => setTimeout(resolve, 10));

  reporter.markError(new Error("second failure"), {
    category: "unknown",
    status: "degraded",
  });
  const second = reporter.getSnapshot();

  assert.equal(first.status, "degraded");
  assert.equal(second.status, "degraded");
  assert.ok(first.degradedSinceAt);
  assert.equal(second.degradedSinceAt, first.degradedSinceAt);
  assert.notEqual(second.lastError?.at, first.lastError?.at);
});

test("HealthReporter clears degradedSinceAt after recovery", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-health-"));
  const reporter = new HealthReporter(createConfig(stateDir), logger);
  reporter.initialize();

  reporter.markError(new Error("first failure"), {
    category: "login_state_invalid",
    status: "degraded",
  });
  assert.ok(reporter.getSnapshot().degradedSinceAt);

  reporter.markLogin();
  const recovered = reporter.getSnapshot();

  assert.equal(recovered.status, "logged_in");
  assert.equal(recovered.degradedSinceAt, null);
});
