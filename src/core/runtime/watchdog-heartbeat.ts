import fs from "node:fs";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { ensureStateDir, getWatchdogArtifactPath } from "./state-paths.js";
import type { RuntimeHealthSnapshot, RuntimeHealthStatus } from "./health.js";
import type { RuntimeErrorCategory } from "./error-classification.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface RuntimeWatchdogSnapshot {
  pid: number;
  runId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  lastHealthStatus: RuntimeHealthStatus;
  lastScanAt: string | null;
  lastLoginAt: string | null;
  lastMessageAt: string | null;
  lastSummaryAt: string | null;
  lastError:
    | {
        at: string;
        category: RuntimeErrorCategory;
        message: string;
      }
    | null;
}

function writeJsonFile(path: string, value: unknown) {
  const tempPath = `${path}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, path);
}

function buildSnapshot(input: {
  health: RuntimeHealthSnapshot;
  now: Date;
  pid: number;
  runId: string;
  startedAt: string;
}): RuntimeWatchdogSnapshot {
  return {
    pid: input.pid,
    runId: input.runId,
    startedAt: input.startedAt,
    lastHeartbeatAt: input.now.toISOString(),
    lastHealthStatus: input.health.status,
    lastScanAt: input.health.lastScanAt,
    lastLoginAt: input.health.lastLoginAt,
    lastMessageAt: input.health.lastMessageAt,
    lastSummaryAt: input.health.lastSummaryAt,
    lastError: input.health.lastError ? { ...input.health.lastError } : null,
  };
}

export function createRuntimeRunId(now: Date, pid: number) {
  return `watchdog-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${pid}`;
}

export function writeWatchdogSnapshot(input: {
  config: AppConfig;
  health: RuntimeHealthSnapshot;
  now?: Date;
  pid?: number;
  runId: string;
  startedAt: string;
}) {
  const now = input.now ?? new Date();
  ensureStateDir(input.config);
  const snapshot = buildSnapshot({
    health: input.health,
    now,
    pid: input.pid ?? process.pid,
    runId: input.runId,
    startedAt: input.startedAt,
  });
  writeJsonFile(getWatchdogArtifactPath(input.config), snapshot);
  return snapshot;
}

export function readWatchdogSnapshot(config: AppConfig): RuntimeWatchdogSnapshot {
  return JSON.parse(fs.readFileSync(getWatchdogArtifactPath(config), "utf8")) as RuntimeWatchdogSnapshot;
}

export function startWatchdogHeartbeatManager(input: {
  config: AppConfig;
  getHealthSnapshot: () => RuntimeHealthSnapshot;
  logger: Logger;
  runId: string;
  startedAt: string;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}): { stop(): void; touch(): RuntimeWatchdogSnapshot | null } {
  const now = input.now ?? (() => new Date());
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let stopped = false;

  function persist() {
    try {
      return writeWatchdogSnapshot({
        config: input.config,
        health: input.getHealthSnapshot(),
        now: now(),
        runId: input.runId,
        startedAt: input.startedAt,
      });
    } catch (error) {
      input.logger.error("Watchdog heartbeat write failed", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  const interval = setInterval(() => {
    if (!stopped) {
      persist();
    }
  }, heartbeatIntervalMs);
  interval.unref();

  persist();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    touch() {
      if (stopped) {
        return null;
      }

      return persist();
    },
  };
}
