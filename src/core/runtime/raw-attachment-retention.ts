import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { getRawStorageDir, getReimbursementRawStorageDir } from "./state-paths.js";
import { addDaysToDateString, formatZonedDate } from "./timezone.js";
import { startCronScheduler } from "./cron-scheduler.js";

const RAW_ATTACHMENT_CLEANUP_CRON = "17 3 * * *";

export interface RawAttachmentCleanupResult {
  cutoffDate?: string;
  deletedDayDirectoryCount: number;
  deletedFileCount: number;
  deletedMonthDirectoryCount: number;
  deletedYearDirectoryCount: number;
  disabled: boolean;
  rawDir: string;
  rawDirs: string[];
  retentionDays: number;
  scannedDayDirectoryCount: number;
}

export function cleanupExpiredRawAttachments(input: {
  config: AppConfig;
  now?: Date;
}): RawAttachmentCleanupResult {
  const now = input.now ?? new Date();
  const rawDirs = [getRawStorageDir(input.config), getReimbursementRawStorageDir(input.config)];
  const retentionDays = input.config.attachmentRetentionDays;

  if (retentionDays <= 0) {
    return {
      deletedDayDirectoryCount: 0,
      deletedFileCount: 0,
      deletedMonthDirectoryCount: 0,
      deletedYearDirectoryCount: 0,
      disabled: true,
      rawDir: rawDirs[0] ?? "",
      rawDirs,
      retentionDays,
      scannedDayDirectoryCount: 0,
    };
  }

  const today = formatZonedDate(now, input.config.timeZone);
  const cutoffDate = addDaysToDateString(today, -(retentionDays - 1));
  const aggregate = rawDirs
    .map((rawDir) => cleanupExpiredRawAttachmentDir(rawDir, cutoffDate))
    .reduce(
      (total, current) => ({
        deletedDayDirectoryCount: total.deletedDayDirectoryCount + current.deletedDayDirectoryCount,
        deletedFileCount: total.deletedFileCount + current.deletedFileCount,
        deletedMonthDirectoryCount:
          total.deletedMonthDirectoryCount + current.deletedMonthDirectoryCount,
        deletedYearDirectoryCount:
          total.deletedYearDirectoryCount + current.deletedYearDirectoryCount,
        scannedDayDirectoryCount:
          total.scannedDayDirectoryCount + current.scannedDayDirectoryCount,
      }),
      {
        deletedDayDirectoryCount: 0,
        deletedFileCount: 0,
        deletedMonthDirectoryCount: 0,
        deletedYearDirectoryCount: 0,
        scannedDayDirectoryCount: 0,
      },
    );

  return {
    cutoffDate,
    deletedDayDirectoryCount: aggregate.deletedDayDirectoryCount,
    deletedFileCount: aggregate.deletedFileCount,
    deletedMonthDirectoryCount: aggregate.deletedMonthDirectoryCount,
    deletedYearDirectoryCount: aggregate.deletedYearDirectoryCount,
    disabled: false,
    rawDir: rawDirs[0] ?? "",
    rawDirs,
    retentionDays,
    scannedDayDirectoryCount: aggregate.scannedDayDirectoryCount,
  };
}

export function startRawAttachmentRetentionManager(input: {
  config: AppConfig;
  logger: Logger;
}): { stop(): void } {
  const { config, logger } = input;

  if (config.attachmentRetentionDays <= 0) {
    logger.info("Raw attachment retention disabled", {
      retentionDays: config.attachmentRetentionDays,
      reason: "WECHATY_ATTACHMENT_RETENTION_DAYS is 0",
    });

    return {
      stop() {
        // no-op
      },
    };
  }

  logger.info("Raw attachment retention enabled", {
    cleanupCron: RAW_ATTACHMENT_CLEANUP_CRON,
    retentionDays: config.attachmentRetentionDays,
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
    expression: RAW_ATTACHMENT_CLEANUP_CRON,
    timeZone: config.timeZone,
    taskName: "raw-attachment-cleanup",
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
    const result = cleanupExpiredRawAttachments({ config });

    if (trigger === "scheduled" && result.deletedFileCount === 0 && result.deletedDayDirectoryCount === 0) {
      return;
    }

    logger.info("Raw attachment cleanup completed", {
      cutoffDate: result.cutoffDate ?? "(disabled)",
      deletedDayDirectoryCount: result.deletedDayDirectoryCount,
      deletedFileCount: result.deletedFileCount,
      deletedMonthDirectoryCount: result.deletedMonthDirectoryCount,
      deletedYearDirectoryCount: result.deletedYearDirectoryCount,
      rawDir: result.rawDir,
      rawDirs: result.rawDirs,
      retentionDays: result.retentionDays,
      scannedDayDirectoryCount: result.scannedDayDirectoryCount,
      trigger,
    });
  } catch (error) {
    logger.error("Raw attachment cleanup failed", {
      message: error instanceof Error ? error.message : String(error),
      retentionDays: config.attachmentRetentionDays,
      stack: error instanceof Error ? error.stack : undefined,
      trigger,
    });
  }
}

function cleanupExpiredRawAttachmentDir(rawDir: string, cutoffDate: string) {
  if (!fs.existsSync(rawDir)) {
    return {
      deletedDayDirectoryCount: 0,
      deletedFileCount: 0,
      deletedMonthDirectoryCount: 0,
      deletedYearDirectoryCount: 0,
      scannedDayDirectoryCount: 0,
    };
  }

  let deletedDayDirectoryCount = 0;
  let deletedFileCount = 0;
  let deletedMonthDirectoryCount = 0;
  let deletedYearDirectoryCount = 0;
  let scannedDayDirectoryCount = 0;

  for (const yearEntry of fs.readdirSync(rawDir, { withFileTypes: true })) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }

    const yearPath = path.join(rawDir, yearEntry.name);

    for (const monthEntry of fs.readdirSync(yearPath, { withFileTypes: true })) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) {
        continue;
      }

      const monthPath = path.join(yearPath, monthEntry.name);

      for (const dayEntry of fs.readdirSync(monthPath, { withFileTypes: true })) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) {
          continue;
        }

        const dayPath = path.join(monthPath, dayEntry.name);
        const dayDate = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`;
        scannedDayDirectoryCount += 1;

        if (dayDate >= cutoffDate) {
          continue;
        }

        deletedFileCount += countFilesRecursively(dayPath);
        fs.rmSync(dayPath, { force: true, recursive: true });
        deletedDayDirectoryCount += 1;
      }

      if (removeDirectoryIfEmpty(monthPath)) {
        deletedMonthDirectoryCount += 1;
      }
    }

    if (removeDirectoryIfEmpty(yearPath)) {
      deletedYearDirectoryCount += 1;
    }
  }

  return {
    deletedDayDirectoryCount,
    deletedFileCount,
    deletedMonthDirectoryCount,
    deletedYearDirectoryCount,
    scannedDayDirectoryCount,
  };
}

function countFilesRecursively(dirPath: string): number {
  let count = 0;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      count += countFilesRecursively(entryPath);
      continue;
    }

    count += 1;
  }

  return count;
}

function removeDirectoryIfEmpty(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) {
    return false;
  }

  if (fs.readdirSync(dirPath).length > 0) {
    return false;
  }

  fs.rmdirSync(dirPath);
  return true;
}
