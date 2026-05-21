import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import { parseManagedLogFileName } from "../logging/log-files.js";
import type { Logger } from "../logging/logger.js";
import { addDaysToDateString, formatZonedDate } from "./timezone.js";
import { getLogDirPath } from "./state-paths.js";
import { startCronScheduler } from "./cron-scheduler.js";

const LOG_CLEANUP_CRON = "23 3 * * *";

export interface LogCleanupResult {
  cutoffDate: string;
  deletedFileCount: number;
  disabled: boolean;
  logDir: string;
  retentionDays: number;
  scannedFileCount: number;
}

export function cleanupExpiredLogs(input: {
  config: AppConfig;
  now?: Date;
}): LogCleanupResult {
  const now = input.now ?? new Date();
  const retentionDays = input.config.logRetentionDays;
  const logDir = getLogDirPath(input.config);

  if (retentionDays <= 0) {
    return {
      cutoffDate: "",
      deletedFileCount: 0,
      disabled: true,
      logDir,
      retentionDays,
      scannedFileCount: 0,
    };
  }

  const today = formatZonedDate(now, input.config.timeZone);
  const cutoffDate = addDaysToDateString(today, -(retentionDays - 1));

  if (!fs.existsSync(logDir)) {
    return {
      cutoffDate,
      deletedFileCount: 0,
      disabled: false,
      logDir,
      retentionDays,
      scannedFileCount: 0,
    };
  }

  let deletedFileCount = 0;
  let scannedFileCount = 0;

  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseManagedLogFileName(entry.name);

    if (!parsed) {
      continue;
    }

    scannedFileCount += 1;

    if (parsed.date >= cutoffDate) {
      continue;
    }

    fs.rmSync(path.join(logDir, entry.name), { force: true });
    deletedFileCount += 1;
  }

  return {
    cutoffDate,
    deletedFileCount,
    disabled: false,
    logDir,
    retentionDays,
    scannedFileCount,
  };
}

export function startLogRetentionManager(input: {
  config: AppConfig;
  logger: Logger;
}): { stop(): void } {
  const { config, logger } = input;

  logger.info("Log retention enabled", {
    cleanupCron: LOG_CLEANUP_CRON,
    logDir: getLogDirPath(config),
    retentionDays: config.logRetentionDays,
    timeZone: config.timeZone,
  });

  let stopped = false;
  const startupTimer = setTimeout(() => {
    if (!stopped) {
      runCleanup(config, logger, "startup");
    }
  }, 0);
  startupTimer.unref();

  const scheduler = startCronScheduler({
    expression: LOG_CLEANUP_CRON,
    timeZone: config.timeZone,
    taskName: "log-cleanup",
    logger,
    async task() {
      runCleanup(config, logger, "scheduled");
    },
  });

  return {
    stop() {
      stopped = true;
      clearTimeout(startupTimer);
      scheduler.stop();
    },
  };
}

function runCleanup(config: AppConfig, logger: Logger, trigger: "startup" | "scheduled") {
  try {
    const result = cleanupExpiredLogs({ config });

    logger.info("Log cleanup completed", {
      cutoffDate: result.cutoffDate || "(disabled)",
      deletedFileCount: result.deletedFileCount,
      logDir: result.logDir,
      retentionDays: result.retentionDays,
      scannedFileCount: result.scannedFileCount,
      trigger,
    });
  } catch (error) {
    logger.error("Log cleanup failed", {
      message: error instanceof Error ? error.message : String(error),
      logDir: getLogDirPath(config),
      retentionDays: config.logRetentionDays,
      stack: error instanceof Error ? error.stack : undefined,
      trigger,
    });
  }
}
