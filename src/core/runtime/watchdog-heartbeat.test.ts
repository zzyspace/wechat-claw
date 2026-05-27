import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { getWatchdogArtifactPath } from "./state-paths.js";
import { startWatchdogHeartbeatManager, writeWatchdogSnapshot } from "./watchdog-heartbeat.js";
import type { RuntimeHealthSnapshot } from "./health.js";
import type { Logger } from "../logging/logger.js";

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
  };
}

function createHealthSnapshot(patch?: Partial<RuntimeHealthSnapshot>): RuntimeHealthSnapshot {
  return {
    status: "starting",
    pid: 123,
    botName: "wechat-loss-bot",
    puppet: "wechaty-puppet-wechat",
    startedAt: "2026-05-21T12:00:00.000Z",
    degradedSinceAt: null,
    lastScanAt: null,
    lastLoginAt: null,
    lastMessageAt: null,
    lastSummaryAt: null,
    lastError: null,
    ...patch,
  };
}

test("writeWatchdogSnapshot persists the runtime heartbeat file", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-heartbeat-"));
  const config = createConfig(stateDir);

  const snapshot = writeWatchdogSnapshot({
    config,
    health: createHealthSnapshot({
      status: "logged_in",
      lastLoginAt: "2026-05-21T12:01:00.000Z",
    }),
    now: new Date("2026-05-21T12:02:00.000Z"),
    pid: 456,
    runId: "watchdog-run-1",
    startedAt: "2026-05-21T12:00:00.000Z",
  });

  assert.equal(snapshot.runId, "watchdog-run-1");
  assert.equal(snapshot.lastHealthStatus, "logged_in");

  const persisted = JSON.parse(fs.readFileSync(getWatchdogArtifactPath(config), "utf8"));
  assert.equal(persisted.pid, 456);
  assert.equal(persisted.lastHealthStatus, "logged_in");
  assert.equal(persisted.lastLoginAt, "2026-05-21T12:01:00.000Z");
});

test("startWatchdogHeartbeatManager writes initial state and refreshes on touch", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-heartbeat-"));
  const config = createConfig(stateDir);
  let health = createHealthSnapshot();
  let currentTime = new Date("2026-05-21T12:02:00.000Z");
  const manager = startWatchdogHeartbeatManager({
    config,
    getHealthSnapshot: () => health,
    heartbeatIntervalMs: 60_000,
    logger,
    now: () => currentTime,
    runId: "watchdog-run-2",
    startedAt: "2026-05-21T12:00:00.000Z",
  });

  let persisted = JSON.parse(fs.readFileSync(getWatchdogArtifactPath(config), "utf8"));
  assert.equal(persisted.lastHealthStatus, "starting");

  health = createHealthSnapshot({
    status: "logged_in",
    lastLoginAt: "2026-05-21T12:03:00.000Z",
  });
  currentTime = new Date("2026-05-21T12:03:30.000Z");
  manager.touch();

  persisted = JSON.parse(fs.readFileSync(getWatchdogArtifactPath(config), "utf8"));
  assert.equal(persisted.lastHealthStatus, "logged_in");
  assert.equal(persisted.lastHeartbeatAt, "2026-05-21T12:03:30.000Z");
  assert.equal(persisted.lastLoginAt, "2026-05-21T12:03:00.000Z");

  manager.stop();
});
