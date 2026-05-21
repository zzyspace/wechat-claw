import fs from "node:fs";

import { getAppConfig, type AppConfig, type LogLevelName } from "../config/env.js";
import { buildManagedLogFileName, getManagedLogFilePath } from "./log-files.js";
import { getLogDirPath } from "../runtime/state-paths.js";
import { formatZonedDate, formatZonedTimestamp } from "../runtime/timezone.js";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

interface LoggerOptions {
  now?: () => Date;
  pid?: number;
  resolveConfig?: () => AppConfig;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  appendFile?: (filePath: string, content: string) => void;
  ensureDir?: (dirPath: string) => void;
}

interface PreparedContext {
  inlineParts: string[];
  stack?: string;
}

const levelPriority: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveKeyPattern = /(token|api[-_]?key|authorization|cookie|secret|password)/i;

function createRunId(date: Date, pid: number) {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${pid}`;
}

function shouldLog(level: LogLevelName, configuredLevel: LogLevelName) {
  return levelPriority[level] >= levelPriority[configuredLevel];
}

function isSensitiveKey(key: string) {
  return sensitiveKeyPattern.test(key);
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, seen));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveKey(key) || nestedValue === undefined) {
      continue;
    }

    sanitized[key] = sanitizeForJson(nestedValue, seen);
  }

  return sanitized;
}

function formatInlineValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return JSON.stringify(sanitizeForJson(value));
}

function normalizeStack(stack: string) {
  return stack
    .trimEnd()
    .split("\n")
    .map((line, index) => (index === 0 ? `  stack: ${line}` : `         ${line}`))
    .join("\n");
}

function prepareContext(context?: Record<string, unknown>): PreparedContext {
  const inlineParts: string[] = [];
  let stack: string | undefined;

  if (!context) {
    return { inlineParts };
  }

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || isSensitiveKey(key)) {
      continue;
    }

    if (key === "stack" && typeof value === "string" && value.trim().length > 0) {
      stack = value;
      continue;
    }

    if (value instanceof Error) {
      inlineParts.push(`${key}=${JSON.stringify(value.message)}`);
      if (!stack && value.stack) {
        stack = value.stack;
      }
      continue;
    }

    inlineParts.push(`${key}=${formatInlineValue(value)}`);
  }

  return {
    inlineParts,
    stack,
  };
}

function formatLogEntry(input: {
  context?: Record<string, unknown>;
  level: LogLevelName;
  message: string;
  now: Date;
  pid: number;
  runId: string;
  timeZone: string;
}) {
  const prepared = prepareContext(input.context);
  const parts = [
    formatZonedTimestamp(input.now, input.timeZone),
    input.level.toUpperCase(),
    input.message,
  ];

  if (prepared.inlineParts.length > 0) {
    parts.push(prepared.inlineParts.join(" "));
  }

  parts.push(`run=${input.runId}`);
  parts.push(`pid=${input.pid}`);

  const line = parts.join(" ");

  if (!prepared.stack) {
    return line;
  }

  return `${line}\n${normalizeStack(prepared.stack)}`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const pid = options.pid ?? process.pid;
  const startedAt = options.now ? options.now() : new Date();
  const runId = createRunId(startedAt, pid);
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const appendFile = options.appendFile ?? ((filePath: string, content: string) => fs.appendFileSync(filePath, content, "utf8"));
  const ensureDir = options.ensureDir ?? ((dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }));
  const resolveConfig = options.resolveConfig ?? (() => getAppConfig());
  const sinkFailureKeys = new Set<string>();

  function emitInternalSinkFailure(details: { error: unknown; filePath: string }) {
    const key = `${details.filePath}|${details.error instanceof Error ? details.error.message : String(details.error)}`;

    if (sinkFailureKeys.has(key)) {
      return;
    }

    sinkFailureKeys.add(key);

    const text = `${new Date().toISOString()} LOGGER_SINK_ERROR path=${JSON.stringify(details.filePath)} message=${JSON.stringify(details.error instanceof Error ? details.error.message : String(details.error))}\n`;
    stderr(text);
  }

  function write(level: LogLevelName, message: string, context?: Record<string, unknown>) {
    const config = resolveConfig();

    if (!shouldLog(level, config.logLevel)) {
      return;
    }

    const now = options.now ? options.now() : new Date();
    const line = formatLogEntry({
      context,
      level,
      message,
      now,
      pid,
      runId,
      timeZone: config.timeZone,
    });
    const content = `${line}\n`;
    const date = formatZonedDate(now, config.timeZone);
    const logDir = getLogDirPath(config);
    const appLogPath = getManagedLogFilePath(config, "app", date);

    stdout(content);

    try {
      ensureDir(logDir);
      appendFile(appLogPath, content);

      if (level === "error") {
        appendFile(getManagedLogFilePath(config, "error", date), content);
      }
    } catch (error) {
      emitInternalSinkFailure({
        error,
        filePath:
          level === "error"
            ? `${appLogPath},${buildManagedLogFileName("error", date)}`
            : appLogPath,
      });
    }
  }

  return {
    debug(message, context) {
      write("debug", message, context);
    },
    info(message, context) {
      write("info", message, context);
    },
    warn(message, context) {
      write("warn", message, context);
    },
    error(message, context) {
      write("error", message, context);
    },
  };
}

export const logger: Logger = createLogger();
