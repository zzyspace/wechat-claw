import path from "node:path";

import type { AppConfig } from "../config/env.js";
import { getLogDirPath } from "../runtime/state-paths.js";
import { parseDateString } from "../runtime/timezone.js";

export type ManagedLogKind = "app" | "error";

const managedLogFilePattern = /^(app|error)-(\d{4}-\d{2}-\d{2})\.log$/;

export function buildManagedLogFileName(kind: ManagedLogKind, date: string) {
  return `${kind}-${date}.log`;
}

export function getManagedLogFilePath(config: AppConfig, kind: ManagedLogKind, date: string) {
  return path.join(getLogDirPath(config), buildManagedLogFileName(kind, date));
}

export function parseManagedLogFileName(fileName: string): { date: string; kind: ManagedLogKind } | null {
  const match = managedLogFilePattern.exec(fileName);

  if (!match) {
    return null;
  }

  try {
    parseDateString(match[2]);
  } catch {
    return null;
  }

  return {
    date: match[2],
    kind: match[1] as ManagedLogKind,
  };
}
