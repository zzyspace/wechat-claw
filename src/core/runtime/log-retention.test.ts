import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { cleanupExpiredLogs } from "./log-retention.js";

function createConfig(stateDir: string, logRetentionDays: number): AppConfig {
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
    logRetentionDays,
    lossExtractionApiKey: undefined,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossExtractionModel: undefined,
    lossExtractionProvider: undefined,
    lossMergeWindowSeconds: 60,
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

test("cleanupExpiredLogs removes only managed files older than the retention window", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-log-retention-"));
  const config = createConfig(stateDir, 7);
  fs.mkdirSync(config.logDir, { recursive: true });
  fs.writeFileSync(path.join(config.logDir, "app-2026-05-14.log"), "old", "utf8");
  fs.writeFileSync(path.join(config.logDir, "error-2026-05-14.log"), "old-error", "utf8");
  fs.writeFileSync(path.join(config.logDir, "app-2026-05-15.log"), "keep", "utf8");
  fs.writeFileSync(path.join(config.logDir, "manual-note.txt"), "keep-manual", "utf8");

  const result = cleanupExpiredLogs({
    config,
    now: new Date("2026-05-21T10:11:12.345Z"),
  });

  assert.equal(result.cutoffDate, "2026-05-15");
  assert.equal(result.deletedFileCount, 2);
  assert.equal(result.scannedFileCount, 3);
  assert.equal(fs.existsSync(path.join(config.logDir, "app-2026-05-14.log")), false);
  assert.equal(fs.existsSync(path.join(config.logDir, "error-2026-05-14.log")), false);
  assert.equal(fs.existsSync(path.join(config.logDir, "app-2026-05-15.log")), true);
  assert.equal(fs.existsSync(path.join(config.logDir, "manual-note.txt")), true);
});

test("cleanupExpiredLogs succeeds when the log directory does not exist", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-log-retention-"));
  const config = createConfig(stateDir, 7);

  const result = cleanupExpiredLogs({
    config,
    now: new Date("2026-05-21T10:11:12.345Z"),
  });

  assert.equal(result.deletedFileCount, 0);
  assert.equal(result.scannedFileCount, 0);
  assert.equal(result.logDir, config.logDir);
});
