export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function write(level: "INFO" | "WARN" | "ERROR", message: string, context?: Record<string, unknown>) {
  const payload = {
    level,
    message,
    ...(context ? { context } : {}),
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(payload);

  if (level === "ERROR") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger: Logger = {
  info(message, context) {
    write("INFO", message, context);
  },
  warn(message, context) {
    write("WARN", message, context);
  },
  error(message, context) {
    write("ERROR", message, context);
  },
};
