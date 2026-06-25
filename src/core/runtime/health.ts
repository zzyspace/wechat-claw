import fs from "node:fs";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { classifyRuntimeError, extractErrorMessage, type RuntimeErrorCategory } from "./error-classification.js";
import { ensureStateDir, getHealthArtifactPath } from "./state-paths.js";

export type RuntimeHealthStatus = "starting" | "waiting_for_scan" | "logged_in" | "degraded" | "stopped";

interface HealthErrorRecord {
  at: string;
  category: RuntimeErrorCategory;
  message: string;
}

export interface RuntimeHealthSnapshot {
  status: RuntimeHealthStatus;
  pid: number;
  botName: string;
  puppet?: string;
  startedAt: string;
  degradedSinceAt: string | null;
  lastScanAt: string | null;
  lastLoginAt: string | null;
  lastMessageAt: string | null;
  lastSummaryAt: string | null;
  lastError: HealthErrorRecord | null;
}

function writeJsonFile(path: string, value: unknown) {
  const tempPath = `${path}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, path);
}

export class HealthReporter {
  private snapshot: RuntimeHealthSnapshot;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const startedAt = new Date().toISOString();

    this.snapshot = {
      status: "starting",
      pid: process.pid,
      botName: config.botName,
      puppet: config.puppet,
      startedAt,
      degradedSinceAt: null,
      lastScanAt: null,
      lastLoginAt: null,
      lastMessageAt: null,
      lastSummaryAt: null,
      lastError: null,
    };
  }

  private persist() {
    ensureStateDir(this.config);
    writeJsonFile(getHealthArtifactPath(this.config), this.snapshot);
  }

  private update(patch: Partial<RuntimeHealthSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
    };
    this.persist();
  }

  private updateStatus(status: RuntimeHealthStatus, patch: Partial<RuntimeHealthSnapshot> = {}) {
    const degradedSinceAt =
      status === "degraded"
        ? this.snapshot.status === "degraded"
          ? this.snapshot.degradedSinceAt ?? new Date().toISOString()
          : new Date().toISOString()
        : null;

    this.update({
      ...patch,
      status,
      degradedSinceAt,
    });
  }

  initialize() {
    this.persist();
  }

  getSnapshot(): RuntimeHealthSnapshot {
    return {
      ...this.snapshot,
      lastError: this.snapshot.lastError ? { ...this.snapshot.lastError } : null,
    };
  }

  setStatus(status: RuntimeHealthStatus) {
    this.updateStatus(status);
  }

  markScan() {
    this.updateStatus("waiting_for_scan", {
      lastScanAt: new Date().toISOString(),
    });
  }

  markLogin() {
    this.updateStatus("logged_in", {
      lastLoginAt: new Date().toISOString(),
    });
  }

  markMessage() {
    this.update({
      lastMessageAt: new Date().toISOString(),
    });
  }

  markExternalMessage() {
    this.markMessage();
  }

  markSummary() {
    this.update({
      lastSummaryAt: new Date().toISOString(),
    });
  }

  markError(
    error: unknown,
    options?: {
      status?: RuntimeHealthStatus;
      category?: RuntimeErrorCategory;
    },
  ) {
    const category = options?.category ?? classifyRuntimeError(error);
    const message = extractErrorMessage(error);

    this.updateStatus(options?.status ?? "degraded", {
      lastError: {
        at: new Date().toISOString(),
        category,
        message,
      },
    });

    this.logger.error("Runtime health recorded an error", {
      category,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
