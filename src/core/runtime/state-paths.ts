import fs from "node:fs";
import path from "node:path";

import { getAppConfig, type AppConfig } from "../config/env.js";

function resolveConfig(config?: AppConfig): AppConfig {
  return config ?? getAppConfig();
}

export function getStateDirPath(config?: AppConfig): string {
  return path.resolve(resolveConfig(config).stateDir);
}

export function ensureStateDir(config?: AppConfig): string {
  const stateDir = getStateDirPath(config);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

export function assertStateDirWritable(config?: AppConfig): string {
  const stateDir = ensureStateDir(config);
  const probePath = path.join(stateDir, ".write-test");

  try {
    fs.writeFileSync(probePath, String(Date.now()), "utf8");
    fs.unlinkSync(probePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`State directory is not writable: ${stateDir}. ${message}`);
  }

  return stateDir;
}

export function getDatabaseFilePath(config?: AppConfig): string {
  return path.join(getStateDirPath(config), "wechat-claw.sqlite");
}

export function getRawStorageDir(config?: AppConfig): string {
  return path.join(getStateDirPath(config), "raw");
}

export function getReimbursementRawStorageDir(config?: AppConfig): string {
  return path.join(getStateDirPath(config), "reimbursement", "raw");
}

export function getQrcodeArtifactPath(config?: AppConfig): string {
  return path.join(getStateDirPath(config), "latest-qrcode.txt");
}

export function getHealthArtifactPath(config?: AppConfig): string {
  return path.join(getStateDirPath(config), "health.json");
}

export function getMemoryCardFilePath(config?: AppConfig): string {
  const resolved = resolveConfig(config);
  return path.join(getStateDirPath(resolved), `${resolved.botName}.memory-card.json`);
}
