import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { createLogger } from "./logger.js";

function createConfig(logDir: string, logLevel: AppConfig["logLevel"] = "info"): AppConfig {
  const stateDir = path.dirname(logDir);

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
    logDir,
    logLevel,
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

test("createLogger writes readable app logs with event content before run metadata", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-logger-"));
  const logDir = path.join(stateDir, "logs");
  const stdout: string[] = [];
  const now = new Date("2026-05-21T10:11:12.345Z");
  const logger = createLogger({
    now: () => now,
    pid: 4242,
    resolveConfig: () => createConfig(logDir),
    stdout(text) {
      stdout.push(text);
    },
  });

  logger.info("Bot logged in", {
    name: "Claw",
  });

  const output = stdout.join("");
  assert.match(
    output,
    /^2026-05-21 18:11:12\.345 INFO Bot logged in name="Claw" run=20260521T101112Z-4242 pid=4242\n$/,
  );

  const fileContent = fs.readFileSync(path.join(logDir, "app-2026-05-21.log"), "utf8");
  assert.equal(fileContent, output);
});

test("createLogger filters below-threshold logs and omits sensitive fields", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-logger-"));
  const logDir = path.join(stateDir, "logs");
  const stdout: string[] = [];
  const logger = createLogger({
    now: () => new Date("2026-05-21T10:11:12.345Z"),
    pid: 4242,
    resolveConfig: () => createConfig(logDir, "warn"),
    stdout(text) {
      stdout.push(text);
    },
  });

  logger.debug("Hidden debug", { token: "secret-token" });
  logger.info("Hidden info", { apiKey: "secret-api-key" });
  logger.warn("Visible warning", {
    nested: {
      cookie: "should-not-appear",
      value: "kept",
    },
    token: "should-not-appear",
  });

  const output = stdout.join("");
  assert.doesNotMatch(output, /Hidden debug|Hidden info|secret-token|secret-api-key|should-not-appear/);
  assert.match(output, /Visible warning/);
  assert.match(output, /nested=\{"value":"kept"\}/);
});

test("createLogger writes error logs to both app and error files with stack details", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-logger-"));
  const logDir = path.join(stateDir, "logs");
  const stdout: string[] = [];
  const logger = createLogger({
    now: () => new Date("2026-05-21T10:11:12.345Z"),
    pid: 4242,
    resolveConfig: () => createConfig(logDir),
    stdout(text) {
      stdout.push(text);
    },
  });

  logger.error("Failed to handle message", {
    message: "boom",
    stack: "Error: boom\n    at main (app.js:1:1)",
  });

  const output = stdout.join("");
  assert.match(output, /^2026-05-21 18:11:12\.345 ERROR Failed to handle message message="boom" run=20260521T101112Z-4242 pid=4242\n  stack: Error: boom\n             at main \(app\.js:1:1\)\n$/);

  assert.equal(
    fs.readFileSync(path.join(logDir, "app-2026-05-21.log"), "utf8"),
    output,
  );
  assert.equal(
    fs.readFileSync(path.join(logDir, "error-2026-05-21.log"), "utf8"),
    output,
  );
});

test("createLogger writes multiline details blocks readably", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-logger-"));
  const logDir = path.join(stateDir, "logs");
  const stdout: string[] = [];
  const logger = createLogger({
    now: () => new Date("2026-05-21T10:11:12.345Z"),
    pid: 4242,
    resolveConfig: () => createConfig(logDir),
    stdout(text) {
      stdout.push(text);
    },
  });

  logger.info("[ CUSTOM LOG ] Raw wechaty message snapshot", {
    details: '{\n  "id": "123"\n}',
  });

  const output = stdout.join("");
  assert.equal(
    output,
    [
      "2026-05-21 18:11:12.345 INFO [ CUSTOM LOG ] Raw wechaty message snapshot run=20260521T101112Z-4242 pid=4242",
      "  details: {",
      '             "id": "123"',
      "           }",
      "",
    ].join("\n"),
  );
});

test("createLogger can be configured for stdout-only logging", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-logger-"));
  const logDir = path.join(stateDir, "logs");
  const stdout: string[] = [];
  const logger = createLogger({
    appendFile() {
      // no-op
    },
    ensureDir() {
      // no-op
    },
    now: () => new Date("2026-05-21T10:11:12.345Z"),
    pid: 4242,
    resolveConfig: () => createConfig(logDir),
    stdout(text) {
      stdout.push(text);
    },
  });

  logger.info("Watchdog check ok", {
    serviceName: "wechat-claw",
  });

  assert.match(
    stdout.join(""),
    /^2026-05-21 18:11:12\.345 INFO Watchdog check ok serviceName="wechat-claw" run=20260521T101112Z-4242 pid=4242\n$/,
  );
  assert.equal(fs.existsSync(path.join(logDir, "app-2026-05-21.log")), false);
  assert.equal(fs.existsSync(path.join(logDir, "error-2026-05-21.log")), false);
});
