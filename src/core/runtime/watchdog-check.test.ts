import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import {
  createWatchdogAlertEmail,
  createWaitingForScanAlertEmail,
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

test("evaluateWatchdogState immediately flags chromium dependency failures for manual action", () => {
  const evaluation = evaluateWatchdogState({
    healthSnapshot: createHealthSnapshot({
      status: "degraded",
      degradedSinceAt: "2026-05-21T11:59:30.000Z",
      lastError: {
        at: "2026-05-21T11:59:30.000Z",
        category: "chromium_dependency_missing",
        message: "Could not find expected browser (chrome) locally.",
      },
    }),
    hostName: "test-host",
    now: new Date("2026-05-21T12:00:00.000Z"),
    serviceName: "wechat-claw",
    serviceStatus: createServiceStatus(),
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T11:59:50.000Z",
      lastHealthStatus: "degraded",
      degradedSinceAt: "2026-05-21T11:59:30.000Z",
      lastError: {
        at: "2026-05-21T11:59:30.000Z",
        category: "chromium_dependency_missing",
        message: "Could not find expected browser (chrome) locally.",
      },
    }),
  });

  assert.equal(evaluation.severity, "manual_action_required");
  assert.equal(evaluation.action, "email_only");
  assert.equal(evaluation.reasonCode, "chromium_dependency_missing");
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
      firstObservedAtByFingerprint: {},
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
      firstObservedAtByFingerprint: {},
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

test("runWatchdogCheck waits for sustained high memory before restarting", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = {
    ...createConfig(stateDir, true),
    watchdogMemoryLimitMb: 512,
    watchdogMemoryPersistenceSeconds: 300,
  };
  let restartCount = 0;

  const initial = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:00:00.000Z"),
    persistentState: {
      firstObservedAtByFingerprint: {},
      lastCheckAt: null,
      recentAlertsByFingerprint: {},
      recentRestartAts: [],
    },
    readServiceStatus: () =>
      createServiceStatus({
        memoryCurrentBytes: 600 * 1024 * 1024,
      }),
    restartService: () => {
      restartCount += 1;
    },
    sendAlertEmail: async () => {
      // no-op
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T11:59:00.000Z",
    }),
  });

  assert.equal(initial.effectiveEvaluation.action, "none");
  assert.equal(initial.effectiveEvaluation.reasonCode, "service_memory_high");
  assert.equal(restartCount, 0);

  const later = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:06:00.000Z"),
    persistentState: initial.persistentState,
    readServiceStatus: () =>
      createServiceStatus({
        memoryCurrentBytes: 600 * 1024 * 1024,
      }),
    restartService: () => {
      restartCount += 1;
    },
    sendAlertEmail: async () => {
      // no-op
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:05:00.000Z",
    }),
  });

  assert.equal(later.effectiveEvaluation.action, "email_and_restart");
  assert.equal(later.effectiveEvaluation.reasonCode, "service_memory_high");
  assert.equal(restartCount, 1);
});

test("runWatchdogCheck restarts when room canary reaches the failure threshold", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config: AppConfig = {
    ...createConfig(stateDir, true),
    roomCanary: {
      enabled: true,
      targetRoomTopic: "AI报账群",
      intervalMinSeconds: 600,
      intervalMaxSeconds: 1200,
      ackTimeoutSeconds: 120,
      failureThreshold: 2,
      autoRestartEnabled: true,
    },
  };
  let restartCount = 0;

  const result = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot(),
    now: new Date("2026-05-21T12:10:00.000Z"),
    persistentState: {
      firstObservedAtByFingerprint: {},
      lastCheckAt: null,
      recentAlertsByFingerprint: {},
      recentRestartAts: [],
    },
    readServiceStatus: () => createServiceStatus(),
    restartService: () => {
      restartCount += 1;
    },
    roomCanaryState: {
      status: "restart_requested",
      targetRoomTopic: "AI报账群",
      enabled: true,
      autoRestartEnabled: true,
      intervalMinSeconds: 600,
      intervalMaxSeconds: 1200,
      lastScheduledIntervalSeconds: 600,
      ackTimeoutSeconds: 120,
      failureThreshold: 2,
      lastSentAt: "2026-05-21T12:05:00.000Z",
      lastSentToken: "abc-123",
      lastSentText: "[wechat-claw][room-canary] token=abc-123",
      pendingSinceAt: null,
      lastAckAt: "2026-05-21T11:50:00.000Z",
      lastAckToken: "previous-token",
      consecutiveFailureCount: 2,
      lastFailureAt: "2026-05-21T12:07:00.000Z",
      lastFailureReason: "ack_timeout",
      lastDeliveryError: null,
      lastRestartRequestedAt: "2026-05-21T12:07:00.000Z",
    },
    sendAlertEmail: async () => {
      // no-op
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T12:09:00.000Z",
    }),
  });

  assert.equal(result.effectiveEvaluation.reasonCode, "room_canary_failed");
  assert.equal(result.effectiveEvaluation.action, "email_and_restart");
  assert.equal(result.restartPerformed, true);
  assert.equal(restartCount, 1);
});

test("watchdog persistent state can be written and read back", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, false);
  const state: WatchdogPersistentState = {
    firstObservedAtByFingerprint: {},
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

test("runWatchdogCheck sends alert email for chromium dependency failures without restart", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-watchdog-check-"));
  const config = createConfig(stateDir, true);
  const sentSubjects: string[] = [];
  let restartCount = 0;

  const result = await runWatchdogCheck({
    config,
    healthSnapshot: createHealthSnapshot({
      status: "degraded",
      degradedSinceAt: "2026-05-21T11:59:30.000Z",
      lastError: {
        at: "2026-05-21T11:59:30.000Z",
        category: "chromium_dependency_missing",
        message: "Could not find expected browser (chrome) locally.",
      },
    }),
    now: new Date("2026-05-21T12:00:00.000Z"),
    persistentState: {
      firstObservedAtByFingerprint: {},
      lastCheckAt: null,
      recentAlertsByFingerprint: {},
      recentRestartAts: [],
    },
    readServiceStatus: () => createServiceStatus(),
    restartService: () => {
      restartCount += 1;
    },
    sendAlertEmail: async (message) => {
      sentSubjects.push(message.subject);
    },
    serviceName: "wechat-claw",
    watchdogSnapshot: createWatchdogSnapshot({
      lastHeartbeatAt: "2026-05-21T11:59:50.000Z",
      lastHealthStatus: "degraded",
      degradedSinceAt: "2026-05-21T11:59:30.000Z",
      lastError: {
        at: "2026-05-21T11:59:30.000Z",
        category: "chromium_dependency_missing",
        message: "Could not find expected browser (chrome) locally.",
      },
    }),
  });

  assert.equal(result.effectiveEvaluation.reasonCode, "chromium_dependency_missing");
  assert.equal(result.effectiveEvaluation.action, "email_only");
  assert.equal(result.emailSent, true);
  assert.equal(restartCount, 0);
  assert.equal(sentSubjects.length, 1);
  assert.match(sentSubjects[0] ?? "", /\[manual-action\].*chromium_dependency_missing/);
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

test("createWaitingForScanAlertEmail includes qrcode url and attaches the latest qrcode artifact", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-waiting-scan-email-"));
  const config = createConfig(stateDir, true);
  const artifactPath = path.join(stateDir, "latest-qrcode.txt");
  fs.writeFileSync(
    artifactPath,
    "updated_at=2026-05-21T12:00:00.000Z\nqrcode_url=https://wechaty.js.org/qrcode/example\n\nASCII-QR\n",
    "utf8",
  );

  const email = createWaitingForScanAlertEmail({
    artifactPath,
    config,
    hostName: "test-host",
    now: new Date("2026-05-21T12:10:00.000Z"),
    qrcodeUrl: "https://wechaty.js.org/qrcode/example",
  });

  assert.match(email.subject, /\[wechat-claw\]\[manual-action\] test-host waiting_for_scan/);
  assert.match(email.text, /QR code URL: https:\/\/wechaty\.js\.org\/qrcode\/example/);
  assert.equal(email.attachments?.length, 1);
  assert.equal(email.attachments?.[0]?.filename, "latest-qrcode.txt");
  assert.match(String(email.attachments?.[0]?.content ?? ""), /ASCII-QR/);
});
