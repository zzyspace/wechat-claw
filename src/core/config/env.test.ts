import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { getAppConfig, loadEnvironmentFiles, validateAppConfig } from "./env.js";

const managedEnvKeys = [
  "WECHATY_PUPPET",
  "WECHATY_PUPPET_SERVICE_TOKEN",
  "WECHATY_STATE_DIR",
  "WECHATY_LOG_DIR",
  "WECHATY_LOG_RETENTION_DAYS",
  "WECHATY_LOG_LEVEL",
  "WECHATY_DEBUG_MESSAGE_SNAPSHOT_ENABLED",
  "WECHATY_ALERT_EMAIL_ENABLED",
  "WECHATY_ALERT_SMTP_HOST",
  "WECHATY_ALERT_SMTP_PORT",
  "WECHATY_ALERT_SMTP_SECURE",
  "WECHATY_ALERT_SMTP_USERNAME",
  "WECHATY_ALERT_SMTP_PASSWORD",
  "WECHATY_ALERT_EMAIL_FROM",
  "WECHATY_ALERT_EMAIL_TO",
  "WECHATY_WATCHDOG_MEMORY_LIMIT_MB",
  "WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS",
  "WECHATY_SELF_CANARY_ENABLED",
  "WECHATY_SELF_CANARY_TARGET_CONTACT_NAME",
  "WECHATY_SELF_CANARY_INTERVAL_SECONDS",
  "WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS",
  "WECHATY_SELF_CANARY_FAILURE_THRESHOLD",
  "WECHATY_SELF_CANARY_AUTO_RESET_ENABLED",
  "WECHATY_TIMEZONE",
  "WECHATY_SUMMARY_CRON",
  "WECHATY_CHANNELS_JSON",
  "WECHATY_TARGET_ROOM_TOPIC",
  "WECHATY_DELIVERY_CONTACT_NAME",
  "WECHATY_DEBUG_CONTACT_NAME",
  "WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED",
  "WECHATY_ATTACHMENT_RETENTION_DAYS",
  "WECHATY_COLD_START_IGNORE_WINDOW_SECONDS",
  "WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS",
  "WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER",
  "WECHATY_REIMBURSEMENT_EXTRACTION_MODEL",
  "WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY",
  "WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL",
  "WECHATY_ENV_FILE",
];
const originalEnv = new Map(managedEnvKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of managedEnvKeys) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

function applyEnv(values: Record<string, string | undefined>) {
  restoreEnv();

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

test("getAppConfig parses WECHATY_CHANNELS_JSON with mixed delivery targets", () => {
  applyEnv({
    WECHATY_ATTACHMENT_RETENTION_DAYS: "90",
    WECHATY_ALERT_EMAIL_ENABLED: "true",
    WECHATY_ALERT_SMTP_HOST: "smtp.example.com",
    WECHATY_ALERT_SMTP_PORT: "587",
    WECHATY_ALERT_SMTP_SECURE: "false",
    WECHATY_ALERT_SMTP_USERNAME: "bot@example.com",
    WECHATY_ALERT_SMTP_PASSWORD: "smtp-password",
    WECHATY_ALERT_EMAIL_FROM: "bot@example.com",
    WECHATY_ALERT_EMAIL_TO: "ops@example.com,dev@example.com",
    WECHATY_LOG_LEVEL: "debug",
    WECHATY_DEBUG_MESSAGE_SNAPSHOT_ENABLED: "true",
    WECHATY_WATCHDOG_MEMORY_LIMIT_MB: "512",
    WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS: "420",
    WECHATY_LOG_RETENTION_DAYS: "14",
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_COLD_START_IGNORE_WINDOW_SECONDS: "45",
    WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS: "5",
    WECHATY_DEBUG_CONTACT_NAME: "调试联系人",
    WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED: "true",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "门店A报损群" },
        deliveryTargets: [
          { type: "contact_name", value: "店长A" },
          { type: "contact_name", value: "店长A" },
          { type: "room_topic", value: "门店A日报群" },
        ],
        summarySchedule: "0 22 * * *",
        weeklySummarySchedule: "10 22 * * 0",
      },
      {
        code: "reimbursement_a",
        enabled: true,
        scenario: "reimbursement",
        match: { type: "room_topic", value: "门店A报账群" },
        deliveryTargets: [],
        summarySchedule: "",
      },
    ]),
    WECHATY_REIMBURSEMENT_EXTRACTION_MODEL: "qwen3.5-flash",
    WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY: "test-key",
  });

  const config = getAppConfig();
  const validation = validateAppConfig(config);

  assert.equal(config.channelsSource, "json");
  assert.equal(config.attachmentRetentionDays, 90);
  assert.equal(config.coldStartIgnoreWindowSeconds, 45);
  assert.equal(config.reimbursementBackwardTextMergeWindowSeconds, 5);
  assert.equal(config.debugContactName, "调试联系人");
  assert.equal(config.debugReceivedRoomMessageEnabled, true);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.debugMessageSnapshotEnabled, true);
  assert.equal(config.logRetentionDays, 14);
  assert.equal(config.alertEmailEnabled, true);
  assert.equal(config.alertSmtpHost, "smtp.example.com");
  assert.equal(config.alertSmtpPort, 587);
  assert.equal(config.alertSmtpSecure, false);
  assert.equal(config.alertSmtpUsername, "bot@example.com");
  assert.equal(config.alertSmtpPassword, "smtp-password");
  assert.equal(config.alertEmailFrom, "bot@example.com");
  assert.deepEqual(config.alertEmailTo, ["ops@example.com", "dev@example.com"]);
  assert.equal(config.watchdogMemoryLimitMb, 512);
  assert.equal(config.watchdogMemoryPersistenceSeconds, 420);
  assert.equal(config.selfCanary?.enabled, false);
  assert.equal(config.channels.length, 2);
  assert.equal(config.channels[1]?.scenario, "reimbursement");
  assert.equal(config.reimbursementExtractionProvider, "qwen");
  assert.equal(config.reimbursementExtractionModel, "qwen3.5-flash");
  assert.equal(config.reimbursementExtractionApiKey, "test-key");
  assert.deepEqual(validation.errors, []);
  assert.equal(config.channels[0]?.deliveryTargets.length, 2);
  assert.deepEqual(config.channels[0]?.deliveryTargets[1], {
    type: "room_topic",
    value: "门店A日报群",
  });
  assert.equal(config.channels[0]?.weeklySummarySchedule, "10 22 * * 0");
});

test("validateAppConfig rejects duplicate channel code and invalid target type", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "dup",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "0 22 * * *",
      },
      {
        code: "dup",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "invalid_target", value: "X" }],
        summarySchedule: "bad cron",
        weeklySummarySchedule: "bad weekly cron",
      },
    ]),
  });

  const validation = validateAppConfig(getAppConfig());

  assert(validation.errors.some((error) => error.includes("Duplicate channel code: dup")));
  assert(validation.errors.some((error) => error.includes("Duplicate enabled room_topic match: 报损群A")));
  assert(validation.errors.some((error) => error.includes("Unsupported delivery target type")));
  assert(validation.errors.some((error) => error.includes("Invalid summarySchedule")));
  assert(validation.errors.some((error) => error.includes("Invalid weeklySummarySchedule")));
});

test("getAppConfig falls back to legacy single-channel env vars", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_SUMMARY_CRON: "15 21 * * *",
    WECHATY_TARGET_ROOM_TOPIC: "AI测试群",
    WECHATY_DELIVERY_CONTACT_NAME: "Ryan",
    WECHATY_CHANNELS_JSON: undefined,
  });

  const config = getAppConfig();
  const validation = validateAppConfig(config);

  assert.equal(config.channelsSource, "legacy");
  assert.equal(config.channels.length, 1);
  assert.equal(config.channels[0]?.code, "default_loss_report");
  assert.equal(config.channels[0]?.summarySchedule, "15 21 * * *");
  assert.equal(config.channels[0]?.weeklySummarySchedule, "");
  assert.deepEqual(config.channels[0]?.deliveryTargets, [{ type: "contact_name", value: "Ryan" }]);
  assert.deepEqual(validation.errors, []);
  assert(validation.warnings.some((warning) => warning.includes("Prefer WECHATY_CHANNELS_JSON")));
});

test("getAppConfig defaults log settings from state dir", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_STATE_DIR: "/tmp/wechat-claw-state",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_LOG_DIR: undefined,
    WECHATY_LOG_LEVEL: undefined,
    WECHATY_DEBUG_MESSAGE_SNAPSHOT_ENABLED: undefined,
    WECHATY_LOG_RETENTION_DAYS: undefined,
    WECHATY_ALERT_EMAIL_ENABLED: undefined,
    WECHATY_ALERT_SMTP_HOST: undefined,
    WECHATY_ALERT_SMTP_PORT: undefined,
    WECHATY_ALERT_SMTP_SECURE: undefined,
    WECHATY_ALERT_SMTP_USERNAME: undefined,
    WECHATY_ALERT_SMTP_PASSWORD: undefined,
    WECHATY_ALERT_EMAIL_FROM: undefined,
    WECHATY_ALERT_EMAIL_TO: undefined,
    WECHATY_WATCHDOG_MEMORY_LIMIT_MB: undefined,
    WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS: undefined,
  });

  const config = getAppConfig();

  assert.equal(config.logDir, "/tmp/wechat-claw-state/logs");
  assert.equal(config.logLevel, "info");
  assert.equal(config.logRetentionDays, 7);
  assert.equal(config.debugMessageSnapshotEnabled, false);
  assert.equal(config.alertEmailEnabled, false);
  assert.deepEqual(config.alertEmailTo, []);
  assert.equal(config.watchdogMemoryLimitMb, 0);
  assert.equal(config.watchdogMemoryPersistenceSeconds, 300);
  assert.equal(config.selfCanary?.targetContactName, "文件传输助手");
  assert.equal(config.debugReceivedRoomMessageEnabled, false);
});

test("getAppConfig parses self canary settings", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_SELF_CANARY_ENABLED: "true",
    WECHATY_SELF_CANARY_TARGET_CONTACT_NAME: "文件传输助手",
    WECHATY_SELF_CANARY_INTERVAL_SECONDS: "1800",
    WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS: "120",
    WECHATY_SELF_CANARY_FAILURE_THRESHOLD: "2",
    WECHATY_SELF_CANARY_AUTO_RESET_ENABLED: "true",
  });

  const config = getAppConfig();
  const validation = validateAppConfig(config);

  assert.equal(config.selfCanary?.enabled, true);
  assert.equal(config.selfCanary?.targetContactName, "文件传输助手");
  assert.equal(config.selfCanary?.intervalSeconds, 1800);
  assert.equal(config.selfCanary?.ackTimeoutSeconds, 120);
  assert.equal(config.selfCanary?.failureThreshold, 2);
  assert.equal(config.selfCanary?.autoResetEnabled, true);
  assert.deepEqual(validation.errors, []);
});

test("validateAppConfig rejects invalid self canary settings", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_SELF_CANARY_ENABLED: "maybe",
    WECHATY_SELF_CANARY_TARGET_CONTACT_NAME: "",
    WECHATY_SELF_CANARY_INTERVAL_SECONDS: "0",
    WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS: "-1",
    WECHATY_SELF_CANARY_FAILURE_THRESHOLD: "0",
    WECHATY_SELF_CANARY_AUTO_RESET_ENABLED: "perhaps",
  });

  const validation = validateAppConfig(getAppConfig());

  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_SELF_CANARY_ENABLED")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_SELF_CANARY_INTERVAL_SECONDS")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_SELF_CANARY_FAILURE_THRESHOLD")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_SELF_CANARY_AUTO_RESET_ENABLED")));
});

test("validateAppConfig rejects invalid log settings", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_LOG_LEVEL: "verbose",
    WECHATY_LOG_RETENTION_DAYS: "0",
  });

  const validation = validateAppConfig(getAppConfig());

  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_LOG_LEVEL")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_LOG_RETENTION_DAYS")));
});

test("validateAppConfig rejects invalid alert email settings when enabled", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_ALERT_EMAIL_ENABLED: "true",
    WECHATY_ALERT_SMTP_HOST: "",
    WECHATY_ALERT_SMTP_PORT: "abc",
    WECHATY_ALERT_SMTP_SECURE: "maybe",
    WECHATY_ALERT_SMTP_USERNAME: "",
    WECHATY_ALERT_SMTP_PASSWORD: "",
    WECHATY_ALERT_EMAIL_FROM: "bad-address",
    WECHATY_ALERT_EMAIL_TO: "ops@example.com,broken-address",
    WECHATY_WATCHDOG_MEMORY_LIMIT_MB: "-1",
    WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS: "0",
  });

  const validation = validateAppConfig(getAppConfig());

  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_ALERT_SMTP_SECURE")));
  assert(validation.errors.some((error) => error.includes("Missing WECHATY_ALERT_SMTP_HOST")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_ALERT_SMTP_PORT")));
  assert(validation.errors.some((error) => error.includes("Missing WECHATY_ALERT_SMTP_USERNAME")));
  assert(validation.errors.some((error) => error.includes("Missing WECHATY_ALERT_SMTP_PASSWORD")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_ALERT_EMAIL_FROM")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_ALERT_EMAIL_TO address")));
  assert(validation.errors.some((error) => error.includes("Invalid WECHATY_WATCHDOG_MEMORY_LIMIT_MB")));
  assert(
    validation.errors.some((error) => error.includes("Invalid WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS")),
  );
});

test("validateAppConfig warns about unusual alert smtp secure and port combinations", () => {
  applyEnv({
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_CHANNELS_JSON: JSON.stringify([
      {
        code: "loss_a",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "报损群A" },
        deliveryTargets: [{ type: "contact_name", value: "店长A" }],
        summarySchedule: "",
      },
    ]),
    WECHATY_ALERT_EMAIL_ENABLED: "true",
    WECHATY_ALERT_SMTP_HOST: "smtp.example.com",
    WECHATY_ALERT_SMTP_PORT: "465",
    WECHATY_ALERT_SMTP_SECURE: "false",
    WECHATY_ALERT_SMTP_USERNAME: "bot@example.com",
    WECHATY_ALERT_SMTP_PASSWORD: "smtp-password",
    WECHATY_ALERT_EMAIL_FROM: "bot@example.com",
    WECHATY_ALERT_EMAIL_TO: "ops@example.com",
  });

  const validation = validateAppConfig(getAppConfig());

  assert.deepEqual(validation.errors, []);
  assert(validation.warnings.some((warning) => warning.includes("WECHATY_ALERT_SMTP_SECURE=false with port 465")));
});

test("loadEnvironmentFiles loads config from a specified env file without overriding existing env", () => {
  applyEnv({
    WECHATY_PUPPET: undefined,
    WECHATY_DEBUG_CONTACT_NAME: undefined,
    WECHATY_CHANNELS_JSON: undefined,
    WECHATY_TIMEZONE: "Asia/Shanghai",
    WECHATY_ENV_FILE: undefined,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-env-test-"));
  const envPath = path.join(tempDir, "wechat-claw.env");

  fs.writeFileSync(
    envPath,
    [
      "WECHATY_PUPPET=wechaty-puppet-wechat",
      "WECHATY_DEBUG_CONTACT_NAME=文件调试联系人",
      'WECHATY_CHANNELS_JSON=[{"code":"loss_file","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"文件群"},"deliveryTargets":[{"type":"contact_name","value":"店长"}],"summarySchedule":"0 22 * * *"}]',
      "WECHATY_TIMEZONE=UTC",
    ].join("\n"),
    "utf8",
  );

  process.env.WECHATY_TIMEZONE = "Asia/Shanghai";
  loadEnvironmentFiles([envPath]);

  const config = getAppConfig();

  assert.equal(config.puppet, "wechaty-puppet-wechat");
  assert.equal(config.debugContactName, "文件调试联系人");
  assert.equal(config.channels[0]?.code, "loss_file");
  assert.equal(config.timeZone, "Asia/Shanghai");
});
