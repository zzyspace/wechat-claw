import fs from "node:fs";

import type { AppConfig } from "../config/env.js";
import type { RuntimeHealthSnapshot, RuntimeHealthStatus } from "./health.js";
import { getHealthArtifactPath } from "./state-paths.js";

export interface ManualSummaryRequestGateResult {
  allowed: boolean;
  reason?: string;
  status?: RuntimeHealthStatus | "missing" | "invalid";
}

export function getManualSummaryRequestGateResult(config: AppConfig): ManualSummaryRequestGateResult {
  const healthPath = getHealthArtifactPath(config);

  if (!fs.existsSync(healthPath)) {
    return {
      allowed: false,
      reason: `Bot health file not found: ${healthPath}. Start the bot and wait for login before using summary:send.`,
      status: "missing",
    };
  }

  let snapshot: Partial<RuntimeHealthSnapshot>;

  try {
    snapshot = JSON.parse(fs.readFileSync(healthPath, "utf8")) as Partial<RuntimeHealthSnapshot>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      allowed: false,
      reason: `Failed to read bot health file: ${healthPath}. ${message}`,
      status: "invalid",
    };
  }

  const status =
    typeof snapshot.status === "string" ? (snapshot.status as RuntimeHealthStatus) : "invalid";

  if (status !== "logged_in") {
    return {
      allowed: false,
      reason: `Bot is not logged in (runtime status: ${status}). summary:send was discarded and not queued.`,
      status,
    };
  }

  return {
    allowed: true,
    status,
  };
}
