export type RuntimeErrorCategory =
  | "state_dir_permission"
  | "chromium_dependency_missing"
  | "dependency_missing"
  | "login_state_invalid"
  | "wechaty_runtime_error"
  | "unknown";

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function classifyRuntimeError(error: unknown): RuntimeErrorCategory {
  const message = extractErrorMessage(error).toLowerCase();

  if (
    message.includes("eacces") ||
    message.includes("eperm") ||
    message.includes("permission denied") ||
    message.includes("read-only file system")
  ) {
    return "state_dir_permission";
  }

  if (
    message.includes("chromium") ||
    message.includes("browser process") ||
    message.includes("libx11") ||
    message.includes("libatk") ||
    message.includes("libnss3") ||
    message.includes("sandbox")
  ) {
    return "chromium_dependency_missing";
  }

  if (message.includes("cannot find package") || message.includes("module not found")) {
    return "dependency_missing";
  }

  if (message.includes("login") || message.includes("logout") || message.includes("scan")) {
    return "login_state_invalid";
  }

  if (message.includes("wechaty") || message.includes("puppet")) {
    return "wechaty_runtime_error";
  }

  return "unknown";
}
