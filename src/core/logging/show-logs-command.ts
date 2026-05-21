import fs from "node:fs";

import type { AppConfig } from "../config/env.js";
import { getManagedLogFilePath, type ManagedLogKind } from "./log-files.js";
import { formatZonedDate, parseDateString } from "../runtime/timezone.js";

const DEFAULT_TAIL_LINES = 100;

export interface ShowLogsCliOptions {
  date: string;
  errorsOnly: boolean;
  grep?: string;
  lines: number;
}

export interface ShowLogsResult {
  filePath: string;
  lines: string[];
  missing: boolean;
}

export function buildShowLogsUsageText() {
  return [
    "Usage:",
    "  npm run logs:recent -- [--errors] [--date YYYY-MM-DD] [--grep keyword]",
    "",
    "Options:",
    "  --errors             Read error-YYYY-MM-DD.log instead of app-YYYY-MM-DD.log",
    "  --date YYYY-MM-DD    Read logs for the specified local date",
    "  --grep keyword       Keep only lines containing the keyword",
  ].join("\n");
}

export function parseShowLogsCliArgs(
  argv: string[],
  input: {
    now?: Date;
    timeZone: string;
  },
): ShowLogsCliOptions {
  const options: ShowLogsCliOptions = {
    date: formatZonedDate(input.now ?? new Date(), input.timeZone),
    errorsOnly: false,
    lines: DEFAULT_TAIL_LINES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--errors") {
      options.errorsOnly = true;
      continue;
    }

    if (arg === "--date") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --date");
      }

      parseDateString(value);
      options.date = value;
      index += 1;
      continue;
    }

    if (arg === "--grep") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --grep");
      }

      options.grep = value;
      index += 1;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      throw new Error(buildShowLogsUsageText());
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function readRecentLogs(config: AppConfig, options: ShowLogsCliOptions): ShowLogsResult {
  const kind: ManagedLogKind = options.errorsOnly ? "error" : "app";
  const filePath = getManagedLogFilePath(config, kind, options.date);

  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      lines: [],
      missing: true,
    };
  }

  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .filter((line) => (options.grep ? line.includes(options.grep) : true));

  return {
    filePath,
    lines: lines.slice(-options.lines),
    missing: false,
  };
}
