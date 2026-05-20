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
  "WECHATY_TIMEZONE",
  "WECHATY_SUMMARY_CRON",
  "WECHATY_CHANNELS_JSON",
  "WECHATY_TARGET_ROOM_TOPIC",
  "WECHATY_DELIVERY_CONTACT_NAME",
  "WECHATY_DEBUG_CONTACT_NAME",
  "WECHATY_ATTACHMENT_RETENTION_DAYS",
  "WECHATY_COLD_START_IGNORE_WINDOW_SECONDS",
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
    WECHATY_PUPPET: "wechaty-puppet-wechat",
    WECHATY_COLD_START_IGNORE_WINDOW_SECONDS: "45",
    WECHATY_DEBUG_CONTACT_NAME: "调试联系人",
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
        code: "loss_b",
        enabled: true,
        scenario: "loss-report",
        match: { type: "room_topic", value: "门店B报损群" },
        deliveryTargets: [{ type: "contact_name", value: "店长B" }],
        summarySchedule: "",
      },
    ]),
  });

  const config = getAppConfig();
  const validation = validateAppConfig(config);

  assert.equal(config.channelsSource, "json");
  assert.equal(config.attachmentRetentionDays, 90);
  assert.equal(config.coldStartIgnoreWindowSeconds, 45);
  assert.equal(config.debugContactName, "调试联系人");
  assert.equal(config.channels.length, 2);
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
