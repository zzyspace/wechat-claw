import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { parseShowLogsCliArgs, readRecentLogs } from "./show-logs-command.js";

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

test("parseShowLogsCliArgs applies timezone-aware default date and supports filters", () => {
  const options = parseShowLogsCliArgs(["--errors", "--grep", "login"], {
    now: new Date("2026-05-20T23:30:00.000Z"),
    timeZone: "Asia/Shanghai",
  });

  assert.equal(options.date, "2026-05-21");
  assert.equal(options.errorsOnly, true);
  assert.equal(options.grep, "login");
  assert.equal(options.lines, 100);
});

test("readRecentLogs tails the selected file and applies grep filtering", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-show-logs-"));
  const config = createConfig(stateDir);
  fs.mkdirSync(config.logDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.logDir, "error-2026-05-21.log"),
    ["alpha", "beta login", "gamma", "delta login"].join("\n"),
    "utf8",
  );

  const result = readRecentLogs(config, {
    date: "2026-05-21",
    errorsOnly: true,
    grep: "login",
    lines: 100,
  });

  assert.equal(result.missing, false);
  assert.equal(result.filePath, path.join(config.logDir, "error-2026-05-21.log"));
  assert.deepEqual(result.lines, ["beta login", "delta login"]);
});

test("readRecentLogs reports missing files without throwing", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-show-logs-"));
  const config = createConfig(stateDir);

  const result = readRecentLogs(config, {
    date: "2026-05-21",
    errorsOnly: false,
    lines: 100,
  });

  assert.equal(result.missing, true);
  assert.equal(result.lines.length, 0);
});
