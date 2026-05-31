import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { cleanupExpiredRawAttachments } from "./raw-attachment-retention.js";
import { getRawStorageDir, getReimbursementRawStorageDir } from "./state-paths.js";

const originalStateDir = process.env.WECHATY_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.WECHATY_STATE_DIR;
    return;
  }

  process.env.WECHATY_STATE_DIR = originalStateDir;
});

function createConfig(stateDir: string, attachmentRetentionDays: number): AppConfig {
  return {
    attachmentRetentionDays,
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
    debugContactName: "Ryan。",
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

test("cleanupExpiredRawAttachments deletes day directories older than the retention cutoff", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-attachment-retention-"));
  process.env.WECHATY_STATE_DIR = stateDir;
  const config = createConfig(stateDir, 60);
  const rawDir = getRawStorageDir(config);
  const oldDayDir = path.join(rawDir, "2026", "03", "20");
  const keptDayDir = path.join(rawDir, "2026", "03", "23");

  fs.mkdirSync(oldDayDir, { recursive: true });
  fs.mkdirSync(keptDayDir, { recursive: true });
  fs.writeFileSync(path.join(oldDayDir, "old-a.jpg"), "a", "utf8");
  fs.writeFileSync(path.join(oldDayDir, "old-b.jpg"), "b", "utf8");
  fs.writeFileSync(path.join(keptDayDir, "keep.jpg"), "c", "utf8");

  const result = cleanupExpiredRawAttachments({
    config,
    now: new Date("2026-05-21T12:00:00.000Z"),
  });

  assert.equal(result.cutoffDate, "2026-03-23");
  assert.equal(result.deletedDayDirectoryCount, 1);
  assert.equal(result.deletedFileCount, 2);
  assert.equal(result.scannedDayDirectoryCount, 2);
  assert.equal(fs.existsSync(oldDayDir), false);
  assert.equal(fs.existsSync(keptDayDir), true);
});

test("cleanupExpiredRawAttachments also cleans reimbursement raw directories", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-attachment-retention-"));
  process.env.WECHATY_STATE_DIR = stateDir;
  const config = createConfig(stateDir, 60);
  const reimbursementRawDir = getReimbursementRawStorageDir(config);
  const oldDayDir = path.join(reimbursementRawDir, "2026", "03", "20");
  const keptDayDir = path.join(reimbursementRawDir, "2026", "03", "23");

  fs.mkdirSync(oldDayDir, { recursive: true });
  fs.mkdirSync(keptDayDir, { recursive: true });
  fs.writeFileSync(path.join(oldDayDir, "old.jpg"), "a", "utf8");
  fs.writeFileSync(path.join(keptDayDir, "keep.jpg"), "b", "utf8");

  const result = cleanupExpiredRawAttachments({
    config,
    now: new Date("2026-05-21T12:00:00.000Z"),
  });

  assert.equal(result.deletedDayDirectoryCount, 1);
  assert.equal(result.deletedFileCount, 1);
  assert.equal(result.scannedDayDirectoryCount, 2);
  assert(result.rawDirs.includes(reimbursementRawDir));
  assert.equal(fs.existsSync(oldDayDir), false);
  assert.equal(fs.existsSync(keptDayDir), true);
});

test("cleanupExpiredRawAttachments removes empty month and year directories after deleting expired data", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-attachment-retention-"));
  process.env.WECHATY_STATE_DIR = stateDir;
  const config = createConfig(stateDir, 30);
  const oldDayDir = path.join(getRawStorageDir(config), "2026", "01", "01");

  fs.mkdirSync(oldDayDir, { recursive: true });
  fs.writeFileSync(path.join(oldDayDir, "old.jpg"), "x", "utf8");

  const result = cleanupExpiredRawAttachments({
    config,
    now: new Date("2026-05-21T12:00:00.000Z"),
  });

  assert.equal(result.deletedDayDirectoryCount, 1);
  assert.equal(result.deletedMonthDirectoryCount, 1);
  assert.equal(result.deletedYearDirectoryCount, 1);
  assert.equal(fs.existsSync(path.join(getRawStorageDir(config), "2026")), false);
});

test("cleanupExpiredRawAttachments is disabled when retention days is zero", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-attachment-retention-"));
  process.env.WECHATY_STATE_DIR = stateDir;
  const config = createConfig(stateDir, 0);
  const dayDir = path.join(getRawStorageDir(config), "2026", "03", "20");

  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, "keep.jpg"), "x", "utf8");

  const result = cleanupExpiredRawAttachments({
    config,
    now: new Date("2026-05-21T12:00:00.000Z"),
  });

  assert.equal(result.disabled, true);
  assert.equal(result.deletedDayDirectoryCount, 0);
  assert.equal(fs.existsSync(dayDir), true);
});
