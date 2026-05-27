import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import {
  createWatchdogAlertEmail,
  evaluateWatchdogState,
  runWatchdogCheck,
  writeWatchdogPersistentState,
  readWatchdogPersistentState,
  type ServiceStatusSnapshot,
  type WatchdogPersistentState,
} from "./watchdog-check.js";
import type { RuntimeHealthSnapshot } from "./health.js";
import type { RuntimeWatchdogSnapshot } from "./watchdog-heartbeat.js";

function createConfig(stateDir: string, alertEmailEnabled = true): AppConfig {
  return {
    attachmentRetentionDays: 60,
    alertEmailEnabled,
    alertEmailFrom: "bot@example.com",
    alertEmailTo: ["ops@example.com"],
    alertSmtpHost: "smtp.example.com",
    alertSmtpPassword: "smtp-password",
    alertSmtpPort: 587,
    alertSmtpSecure: false,
    alertSmtpUsername: "bot@example.com",
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

function createServiceStatus(patch?: Partial<ServiceStatusSnapshot>): ServiceStatusSnapshot {
  return {
    activeState: "active",
    execMainStatus: 0,
    mainPid: 123,
    result: "success",
    subState: "running",
    ...patch,
  };
}

function createHealthSnapshot(patch?: Partial<RuntimeHealthSnapshot>): RuntimeHealthSnapshot {
  return {
    status: "logged_in",
    pid: 123,
    botName: "wechat-loss-bot",
    puppet: "wechaty-puppet-wechat",
    startedAt: "2026-05-21T12:00:00.000Z",
    degradedSinceAt: null,
    lastScanAt: null,
    lastLoginAt: "2026-05-21T12:01:00.000Z",
    lastMessageAt: "2026-05-21T12:02:00.000Z",
    lastSummaryAt: null,
    lastError: null,
    ...patch,
  };
}

function createWatchdogSnapshot(patch?: Partial<RuntimeWatchdogSnapshot>): RuntimeWatchdogSnapshot {
  return {
    pid: 123,
    runId: "watchdog-run-1",
    startedAt: "2026-05-21T12:00:00.000Z",
    lastHeartbeatAt: "2026-05-21T12:02:00.000Z",
    lastHealthStatus: "logged_in",
    degradedSinceAt: null,
    lastScanAt: null,
    lastLoginAt: "2026-05-21T12:01:00.000Z",
    lastMessageAt: "2026-05-21T12:02:00.000Z",
    lastSummaryAt: null,
    lastError: null,
    ...patch,
  };
}

test("evaluateWatchdogState marks waiting_for_scan timeout as manual action required", () => {
  const evaluation = evaluateWatchdogState({
    healthSnapshot: createHealthSnapshot({
      status: "waiting_for_scan",
      lastScanAt: "2026-05-21T11:40:00.000Z",
    }),
    hostName: "test-host",
    now: new Date("2026-05-21T12:00:00.000Z"),
    serviceName: "wechat-claw",
    serviceStatus: createServiceStatus(),
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T11:59:00.000Z",
      lastHealthStatus: "waiting_for_scan",
      lastScanAt: "2026-05-21T11:40:00.000Z",
    }),
  });

  assert.equal(evaluation.severity, "manual_action_required");
  assert.equal(evaluation.action, "email_only");
  assert.equal(evaluation.reasonCode, "login_waiting_for_scan_timeout");
});

test("runWatchdogCheck sends one email for repeated identical faults within the suppression window", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, true);
  const sentSubjects: string[] = [];

  const initial = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:05:00.000Z"),
    persistentState: {
      lastCheckAt: null,
      recentAlertsByFingerprint: {},
      recentRestartAts: [],
    },
    readServiceStatus: () => createServiceStatus(),
    restartService: () => {
      // no-op
    },
    sendAlertEmail: async (message) => {
      sentSubjects.push(message.subject);
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:01:00.000Z",
    }),
  });

  const second = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:10:00.000Z"),
    persistentState: initial.persistentState,
    readServiceStatus: () => createServiceStatus(),
    restartService: () => {
      // no-op
    },
    sendAlertEmail: async (message) => {
      sentSubjects.push(message.subject);
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:01:00.000Z",
    }),
  });

  assert.equal(initial.emailSent, true);
  assert.equal(second.emailSuppressed, true);
  assert.equal(sentSubjects.length, 1);
});

test("runWatchdogCheck throttles automatic restarts after the configured limit", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, true);
  let restartCount = 0;

  const result = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:10:00.000Z"),
    persistentState: {
      lastCheckAt: null,
      recentAlertsByFingerprint: {},
      recentRestartAts: ["2026-05-21T12:00:00.000Z", "2026-05-21T12:05:00.000Z"],
    },
    readServiceStatus: () => createServiceStatus(),
    restartService: () => {
      restartCount += 1;
    },
    sendAlertEmail: async () => {
      // no-op
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:01:00.000Z",
    }),
  });

  assert.equal(result.effectiveEvaluation.reasonCode, "restart_throttled");
  assert.equal(result.restartSuppressed, true);
  assert.equal(restartCount, 0);
});

test("watchdog persistent state can be written and read back", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, false);
  const state: WatchdogPersistentState = {
    lastCheckAt: "2026-05-21T12:05:00.000Z",
    recentAlertsByFingerprint: {
      abc: "2026-05-21T12:04:00.000Z",
    },
    recentRestartAts: ["2026-05-21T12:03:00.000Z"],
  };

  writeWatchdogPersistentState(config, state);

  assert.deepEqual(readWatchdogPersistentState(config), state);
});

test("createWatchdogAlertEmail includes diagnosis details and suggested commands", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, true);
  const evaluation = evaluateWatchdogState({
    healthSnapshot: createHealthSnapshot({
      status: "degraded",
      lastError: {
        at: "2026-05-21T11:55:00.000Z",
        category: "login_state_invalid",
        message: "Bot logged out: Claw",
      },
    }),
    hostName: "test-host",
    now: new Date("2026-05-21T12:10:00.000Z"),
    serviceName: "wechat-claw",
    serviceStatus: createServiceStatus(),
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:09:00.000Z",
      lastError: {
        at: "2026-05-21T11:55:00.000Z",
        category: "login_state_invalid",
        message: "Bot logged out: Claw",
      },
      lastHealthStatus: "degraded",
    }),
  });

  const email = createWatchdogAlertEmail({
    config,
    evaluation,
    now: new Date("2026-05-21T12:10:00.000Z"),
  });

  assert.match(email.subject, /\[wechat-claw\]\[recoverable\] test-host login_logged_out/);
  assert.match(email.text, /Health lastError\.message: Bot logged out: Claw/);
  assert.match(email.text, /journalctl -u wechat-claw -f -o short-iso/);
});

test("evaluateWatchdogState uses degradedSinceAt instead of a refreshed lastError timestamp", () => {
  const evaluation = evaluateWatchdogState({
    healthSnapshot: createHealthSnapshot({
      status: "degraded",
      degradedSinceAt: "2026-05-21T11:55:00.000Z",
      lastError: {
        at: "2026-05-21T12:09:30.000Z",
        category: "login_state_invalid",
        message: "Bot logged out: Claw",
      },
    }),
    hostName: "test-host",
    now: new Date("2026-05-21T12:10:00.000Z"),
    serviceName: "wechat-claw",
    serviceStatus: createServiceStatus(),
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:09:00.000Z",
      degradedSinceAt: "2026-05-21T11:55:00.000Z",
      lastHealthStatus: "degraded",
      lastError: {
        at: "2026-05-21T12:09:30.000Z",
        category: "login_state_invalid",
        message: "Bot logged out: Claw",
      },
    }),
  });

  assert.equal(evaluation.action, "email_and_restart");
  assert.equal(evaluation.reasonCode, "login_logged_out");
});
