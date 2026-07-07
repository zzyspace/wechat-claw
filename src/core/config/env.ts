import { config as loadEnv } from "dotenv";

import { dedupeDeliveryTargets } from "../channels/router.js";
import type { ChannelConfig, ChannelMatch, DeliveryTarget } from "../channels/types.js";

const DEFAULT_ENV_FILE_PATHS = [".env", "/etc/wechat-claw.env"];

export function loadEnvironmentFiles(paths?: string[]) {
  const candidates = paths ?? resolveEnvFilePaths();
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const path = candidate?.trim();

    if (!path || seen.has(path)) {
      continue;
    }

    loadEnv({ path, override: false });
    seen.add(path);
  }
}

function resolveEnvFilePaths() {
  const explicitEnvPath = process.env.WECHATY_ENV_FILE?.trim();

  return explicitEnvPath ? [explicitEnvPath, ...DEFAULT_ENV_FILE_PATHS] : DEFAULT_ENV_FILE_PATHS;
}

loadEnvironmentFiles();

export type ChannelsSource = "json" | "legacy" | "none";

export interface AppConfig {
  puppet?: string;
  puppetServiceToken?: string;
  botName: string;
  stateDir: string;
  logDir: string;
  logRetentionDays: number;
  logLevel: LogLevelName;
  debugMessageSnapshotEnabled?: boolean;
  alertEmailEnabled: boolean;
  alertSmtpHost?: string;
  alertSmtpPort: number;
  alertSmtpSecure: boolean;
  alertSmtpUsername?: string;
  alertSmtpPassword?: string;
  alertEmailFrom?: string;
  alertEmailTo: string[];
  watchdogMemoryLimitMb: number;
  watchdogMemoryPersistenceSeconds: number;
  selfCanary?: SelfCanaryConfig;
  roomCanary?: RoomCanaryConfig;
  timeZone: string;
  debugContactName?: string;
  manualReimbursementContactName?: string;
  debugReceivedRoomMessageEnabled?: boolean;
  channels: ChannelConfig[];
  channelsSource: ChannelsSource;
  channelsParseError?: string;
  summaryPromptTemplate: string;
  attachmentRetentionDays: number;
  coldStartIgnoreWindowSeconds: number;
  lossMergeWindowSeconds: number;
  reimbursementBackwardTextMergeWindowSeconds: number;
  lossExtractionProvider?: string;
  lossExtractionModel?: string;
  lossExtractionApiKey?: string;
  lossExtractionBaseUrl: string;
  reimbursementExtractionProvider?: string;
  reimbursementExtractionModel?: string;
  reimbursementExtractionRetryModel?: string;
  reimbursementExtractionApiKey?: string;
  reimbursementExtractionBaseUrl: string;
  adminHost?: string;
  adminPort?: number;
  adminUsername?: string;
  adminPassword?: string;
}

export interface SelfCanaryConfig {
  enabled: boolean;
  targetContactName: string;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  ackTimeoutSeconds: number;
  failureThreshold: number;
  autoResetEnabled: boolean;
}

export interface RoomCanaryConfig {
  enabled: boolean;
  targetRoomTopic: string;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  ackTimeoutSeconds: number;
  failureThreshold: number;
  autoRestartEnabled: boolean;
}

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface ConfigValidationResult {
  errors: string[];
  warnings: string[];
}

interface ResolveChannelsInput {
  channelsJson?: string;
  legacyTargetRoomTopic?: string;
  legacyDeliveryContactName?: string;
  legacySummaryCron: string;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readStringEnv(name: string, fallback: string): string {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  return raw.trim();
}

function isBooleanLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "0" ||
    normalized === "true" ||
    normalized === "false" ||
    normalized === "yes" ||
    normalized === "no" ||
    normalized === "on" ||
    normalized === "off"
  );
}

function parseBooleanLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  if (!isBooleanLiteral(raw)) {
    return fallback;
  }

  return parseBooleanLiteral(raw);
}

function isServicePuppet(puppet?: string): boolean {
  return puppet === "wechaty-puppet-service";
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readConfiguredPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  return Number(raw);
}

function parsePositiveNumberRangeLiteral(raw: string): { min: number; max: number } | undefined {
  const trimmed = raw.trim();

  if (!trimmed) {
    return undefined;
  }

  const single = Number(trimmed);
  if (Number.isFinite(single) && single > 0) {
    return {
      min: single,
      max: single,
    };
  }

  const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return undefined;
  }

  const min = Number(match[1]);
  const max = Number(match[2]);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min > max) {
    return undefined;
  }

  return {
    min,
    max,
  };
}

function readConfiguredPositiveNumberRangeEnv(
  name: string,
  fallback: number,
): { min: number; max: number } {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return {
      min: fallback,
      max: fallback,
    };
  }

  return parsePositiveNumberRangeLiteral(raw) ?? { min: Number.NaN, max: Number.NaN };
}

function readConfiguredNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  return Number(raw);
}

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readEmailListEnv(name: string): string[] {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidCronExpression(expression: string): boolean {
  if (!expression) {
    return true;
  }

  return expression.trim().split(/\s+/).length === 5;
}

function normalizeChannelMatch(value: unknown): ChannelMatch {
  const record = isRecord(value) ? value : {};

  return {
    type: String(record.type ?? "").trim() as ChannelMatch["type"],
    value: String(record.value ?? "").trim(),
  };
}

function normalizeDeliveryTarget(value: unknown): DeliveryTarget {
  const record = isRecord(value) ? value : {};

  return {
    type: String(record.type ?? "").trim() as DeliveryTarget["type"],
    value: String(record.value ?? "").trim(),
  };
}

function normalizeChannelConfig(value: unknown): ChannelConfig {
  const record = isRecord(value) ? value : {};
  const rawTargets = Array.isArray(record.deliveryTargets) ? record.deliveryTargets : [];

  return {
    code: String(record.code ?? "").trim(),
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    scenario: String(record.scenario ?? "").trim() as ChannelConfig["scenario"],
    match: normalizeChannelMatch(record.match),
    deliveryTargets: dedupeDeliveryTargets(
      rawTargets
        .map((target) => normalizeDeliveryTarget(target))
        .filter((target) => target.value.length > 0),
    ),
    summarySchedule: typeof record.summarySchedule === "string" ? record.summarySchedule.trim() : "",
    weeklySummarySchedule:
      typeof record.weeklySummarySchedule === "string" ? record.weeklySummarySchedule.trim() : "",
  };
}

function buildLegacyChannel(input: {
  targetRoomTopic?: string;
  deliveryContactName?: string;
  summarySchedule: string;
}): ChannelConfig {
  const targets = input.deliveryContactName
    ? [{ type: "contact_name", value: input.deliveryContactName } satisfies DeliveryTarget]
    : [];

  return {
    code: "default_loss_report",
    enabled: true,
    scenario: "loss-report",
    match: {
      type: "room_topic",
      value: input.targetRoomTopic ?? "",
    },
    deliveryTargets: dedupeDeliveryTargets(targets),
    summarySchedule: input.summarySchedule,
    weeklySummarySchedule: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveChannelConfigs(
  input: ResolveChannelsInput,
): {
  channels: ChannelConfig[];
  source: ChannelsSource;
  error?: string;
} {
  if (input.channelsJson) {
    try {
      const parsed = JSON.parse(input.channelsJson) as unknown;

      if (!Array.isArray(parsed)) {
        return {
          channels: [],
          source: "json",
          error: "WECHATY_CHANNELS_JSON must be a JSON array",
        };
      }

      return {
        channels: parsed.map((channel) => normalizeChannelConfig(channel)),
        source: "json",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        channels: [],
        source: "json",
        error: `Invalid WECHATY_CHANNELS_JSON: ${message}`,
      };
    }
  }

  if (input.legacyTargetRoomTopic || input.legacyDeliveryContactName) {
    return {
      channels: [
        buildLegacyChannel({
          targetRoomTopic: input.legacyTargetRoomTopic,
          deliveryContactName: input.legacyDeliveryContactName,
          summarySchedule: input.legacySummaryCron,
        }),
      ],
      source: "legacy",
    };
  }

  return {
    channels: [],
    source: "none",
  };
}

export function getAppConfig(): AppConfig {
  const summaryCron = readStringEnv("WECHATY_SUMMARY_CRON", "0 22 * * *");
  const channelResolution = resolveChannelConfigs({
    channelsJson: readOptionalEnv("WECHATY_CHANNELS_JSON"),
    legacyTargetRoomTopic: readOptionalEnv("WECHATY_TARGET_ROOM_TOPIC"),
    legacyDeliveryContactName: readOptionalEnv("WECHATY_DELIVERY_CONTACT_NAME"),
    legacySummaryCron: summaryCron,
  });
  const selfCanaryIntervalRange = readConfiguredPositiveNumberRangeEnv(
    "WECHATY_SELF_CANARY_INTERVAL_SECONDS",
    1800,
  );
  const roomCanaryIntervalRange = readConfiguredPositiveNumberRangeEnv(
    "WECHATY_ROOM_CANARY_INTERVAL_SECONDS",
    1800,
  );

  return {
    puppet: readOptionalEnv("WECHATY_PUPPET"),
    puppetServiceToken: readOptionalEnv("WECHATY_PUPPET_SERVICE_TOKEN"),
    botName: process.env.WECHATY_BOT_NAME?.trim() || "wechat-loss-bot",
    stateDir: readStringEnv("WECHATY_STATE_DIR", "/var/lib/wechat-claw") || "/var/lib/wechat-claw",
    logDir:
      readStringEnv("WECHATY_LOG_DIR", "").trim() ||
      `${readStringEnv("WECHATY_STATE_DIR", "/var/lib/wechat-claw") || "/var/lib/wechat-claw"}/logs`,
    logRetentionDays: readConfiguredPositiveNumberEnv("WECHATY_LOG_RETENTION_DAYS", 7),
    logLevel: readLogLevelEnv("WECHATY_LOG_LEVEL", "info"),
    debugMessageSnapshotEnabled: readBooleanEnv("WECHATY_DEBUG_MESSAGE_SNAPSHOT_ENABLED", false),
    alertEmailEnabled: readBooleanEnv("WECHATY_ALERT_EMAIL_ENABLED", false),
    alertSmtpHost: readOptionalEnv("WECHATY_ALERT_SMTP_HOST"),
    alertSmtpPort: readConfiguredPositiveNumberEnv("WECHATY_ALERT_SMTP_PORT", 587),
    alertSmtpSecure: readBooleanEnv("WECHATY_ALERT_SMTP_SECURE", false),
    alertSmtpUsername: readOptionalEnv("WECHATY_ALERT_SMTP_USERNAME"),
    alertSmtpPassword: readOptionalEnv("WECHATY_ALERT_SMTP_PASSWORD"),
    alertEmailFrom: readOptionalEnv("WECHATY_ALERT_EMAIL_FROM"),
    alertEmailTo: readEmailListEnv("WECHATY_ALERT_EMAIL_TO"),
    watchdogMemoryLimitMb: readConfiguredNonNegativeNumberEnv("WECHATY_WATCHDOG_MEMORY_LIMIT_MB", 0),
    watchdogMemoryPersistenceSeconds: readConfiguredPositiveNumberEnv(
      "WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS",
      300,
    ),
    selfCanary: {
      enabled: readBooleanEnv("WECHATY_SELF_CANARY_ENABLED", false),
      targetContactName: readStringEnv("WECHATY_SELF_CANARY_TARGET_CONTACT_NAME", "文件传输助手"),
      intervalMinSeconds: selfCanaryIntervalRange.min,
      intervalMaxSeconds: selfCanaryIntervalRange.max,
      ackTimeoutSeconds: readConfiguredPositiveNumberEnv("WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS", 120),
      failureThreshold: readConfiguredPositiveNumberEnv("WECHATY_SELF_CANARY_FAILURE_THRESHOLD", 2),
      autoResetEnabled: readBooleanEnv("WECHATY_SELF_CANARY_AUTO_RESET_ENABLED", false),
    },
    roomCanary: {
      enabled: readBooleanEnv("WECHATY_ROOM_CANARY_ENABLED", false),
      targetRoomTopic: readStringEnv("WECHATY_ROOM_CANARY_TARGET_ROOM_TOPIC", ""),
      intervalMinSeconds: roomCanaryIntervalRange.min,
      intervalMaxSeconds: roomCanaryIntervalRange.max,
      ackTimeoutSeconds: readConfiguredPositiveNumberEnv("WECHATY_ROOM_CANARY_ACK_TIMEOUT_SECONDS", 120),
      failureThreshold: readConfiguredPositiveNumberEnv("WECHATY_ROOM_CANARY_FAILURE_THRESHOLD", 2),
      autoRestartEnabled: readBooleanEnv("WECHATY_ROOM_CANARY_AUTO_RESTART_ENABLED", false),
    },
    timeZone: readStringEnv("WECHATY_TIMEZONE", "Asia/Shanghai") || "Asia/Shanghai",
    debugContactName: readOptionalEnv("WECHATY_DEBUG_CONTACT_NAME"),
    manualReimbursementContactName: readOptionalEnv("WECHATY_MANUAL_REIMBURSEMENT_CONTACT_NAME"),
    debugReceivedRoomMessageEnabled: readBooleanEnv(
      "WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED",
      false,
    ),
    channels: channelResolution.channels,
    channelsSource: channelResolution.source,
    channelsParseError: channelResolution.error,
    summaryPromptTemplate: process.env.WECHATY_SUMMARY_PROMPT_TEMPLATE?.trim() || "",
    attachmentRetentionDays: readNonNegativeNumberEnv("WECHATY_ATTACHMENT_RETENTION_DAYS", 60),
    coldStartIgnoreWindowSeconds: readNonNegativeNumberEnv(
      "WECHATY_COLD_START_IGNORE_WINDOW_SECONDS",
      60,
    ),
    lossMergeWindowSeconds: readPositiveNumberEnv("WECHATY_LOSS_MERGE_WINDOW_SECONDS", 60),
    reimbursementBackwardTextMergeWindowSeconds: readNonNegativeNumberEnv(
      "WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS",
      3,
    ),
    lossExtractionProvider: readOptionalEnv("WECHATY_LOSS_EXTRACTION_PROVIDER"),
    lossExtractionModel: readOptionalEnv("WECHATY_LOSS_EXTRACTION_MODEL"),
    lossExtractionApiKey: readOptionalEnv("WECHATY_LOSS_EXTRACTION_API_KEY"),
    lossExtractionBaseUrl:
      process.env.WECHATY_LOSS_EXTRACTION_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionProvider:
      readOptionalEnv("WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER") ?? "qwen",
    reimbursementExtractionModel:
      readOptionalEnv("WECHATY_REIMBURSEMENT_EXTRACTION_MODEL") ?? "qwen3.5-flash",
    reimbursementExtractionRetryModel:
      readOptionalEnv("WECHATY_REIMBURSEMENT_EXTRACTION_RETRY_MODEL") ?? "qwen3.5-plus",
    reimbursementExtractionApiKey: readOptionalEnv("WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY"),
    reimbursementExtractionBaseUrl:
      process.env.WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    adminHost: readStringEnv("WECHATY_ADMIN_HOST", "127.0.0.1") || "127.0.0.1",
    adminPort: readConfiguredPositiveNumberEnv("WECHATY_ADMIN_PORT", 8788),
    adminUsername: readOptionalEnv("WECHATY_ADMIN_USERNAME"),
    adminPassword: readOptionalEnv("WECHATY_ADMIN_PASSWORD"),
  };
}

export function validateAppConfig(config: AppConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawAlertEmailEnabled = process.env.WECHATY_ALERT_EMAIL_ENABLED?.trim();
  const rawAlertSmtpSecure = process.env.WECHATY_ALERT_SMTP_SECURE?.trim();
  const rawSelfCanaryEnabled = process.env.WECHATY_SELF_CANARY_ENABLED?.trim();
  const rawSelfCanaryIntervalSeconds = process.env.WECHATY_SELF_CANARY_INTERVAL_SECONDS?.trim();
  const rawSelfCanaryAutoResetEnabled = process.env.WECHATY_SELF_CANARY_AUTO_RESET_ENABLED?.trim();
  const rawRoomCanaryEnabled = process.env.WECHATY_ROOM_CANARY_ENABLED?.trim();
  const rawRoomCanaryIntervalSeconds = process.env.WECHATY_ROOM_CANARY_INTERVAL_SECONDS?.trim();
  const rawRoomCanaryAutoRestartEnabled = process.env.WECHATY_ROOM_CANARY_AUTO_RESTART_ENABLED?.trim();
  const rawAdminPort = process.env.WECHATY_ADMIN_PORT?.trim();

  if (!config.puppet) {
    errors.push("Missing WECHATY_PUPPET");
  }

  if (!config.stateDir.trim()) {
    errors.push("Missing WECHATY_STATE_DIR");
  }

  if (!config.logDir.trim()) {
    errors.push("Missing WECHATY_LOG_DIR");
  }

  if (!Number.isInteger(config.logRetentionDays) || config.logRetentionDays <= 0) {
    errors.push(`Invalid WECHATY_LOG_RETENTION_DAYS: ${config.logRetentionDays}`);
  }

  if (!isValidLogLevel(config.logLevel)) {
    errors.push(`Invalid WECHATY_LOG_LEVEL: ${config.logLevel}`);
  }

  if (!Number.isFinite(config.watchdogMemoryLimitMb) || config.watchdogMemoryLimitMb < 0) {
    errors.push(`Invalid WECHATY_WATCHDOG_MEMORY_LIMIT_MB: ${config.watchdogMemoryLimitMb}`);
  }

  if (
    !Number.isFinite(config.watchdogMemoryPersistenceSeconds) ||
    config.watchdogMemoryPersistenceSeconds <= 0
  ) {
    errors.push(
      `Invalid WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS: ${config.watchdogMemoryPersistenceSeconds}`,
    );
  }

  if (rawAlertEmailEnabled && !isBooleanLiteral(rawAlertEmailEnabled)) {
    errors.push(`Invalid WECHATY_ALERT_EMAIL_ENABLED: ${rawAlertEmailEnabled}`);
  }

  if (rawAlertSmtpSecure && !isBooleanLiteral(rawAlertSmtpSecure)) {
    errors.push(`Invalid WECHATY_ALERT_SMTP_SECURE: ${rawAlertSmtpSecure}`);
  }

  if (rawSelfCanaryEnabled && !isBooleanLiteral(rawSelfCanaryEnabled)) {
    errors.push(`Invalid WECHATY_SELF_CANARY_ENABLED: ${rawSelfCanaryEnabled}`);
  }

  if (rawSelfCanaryAutoResetEnabled && !isBooleanLiteral(rawSelfCanaryAutoResetEnabled)) {
    errors.push(`Invalid WECHATY_SELF_CANARY_AUTO_RESET_ENABLED: ${rawSelfCanaryAutoResetEnabled}`);
  }

  if (rawRoomCanaryEnabled && !isBooleanLiteral(rawRoomCanaryEnabled)) {
    errors.push(`Invalid WECHATY_ROOM_CANARY_ENABLED: ${rawRoomCanaryEnabled}`);
  }

  if (rawRoomCanaryAutoRestartEnabled && !isBooleanLiteral(rawRoomCanaryAutoRestartEnabled)) {
    errors.push(`Invalid WECHATY_ROOM_CANARY_AUTO_RESTART_ENABLED: ${rawRoomCanaryAutoRestartEnabled}`);
  }

  if (config.selfCanary) {
    if (rawSelfCanaryIntervalSeconds && !parsePositiveNumberRangeLiteral(rawSelfCanaryIntervalSeconds)) {
      errors.push(`Invalid WECHATY_SELF_CANARY_INTERVAL_SECONDS: ${rawSelfCanaryIntervalSeconds}`);
    }

    if (
      !Number.isFinite(config.selfCanary.intervalMinSeconds) ||
      config.selfCanary.intervalMinSeconds <= 0 ||
      !Number.isFinite(config.selfCanary.intervalMaxSeconds) ||
      config.selfCanary.intervalMaxSeconds <= 0 ||
      config.selfCanary.intervalMinSeconds > config.selfCanary.intervalMaxSeconds
    ) {
      errors.push(
        `Invalid WECHATY_SELF_CANARY_INTERVAL_SECONDS range: ${config.selfCanary.intervalMinSeconds}-${config.selfCanary.intervalMaxSeconds}`,
      );
    }

    if (!Number.isFinite(config.selfCanary.ackTimeoutSeconds) || config.selfCanary.ackTimeoutSeconds <= 0) {
      errors.push(`Invalid WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS: ${config.selfCanary.ackTimeoutSeconds}`);
    }

    if (!Number.isFinite(config.selfCanary.failureThreshold) || config.selfCanary.failureThreshold <= 0) {
      errors.push(`Invalid WECHATY_SELF_CANARY_FAILURE_THRESHOLD: ${config.selfCanary.failureThreshold}`);
    }

    if (config.selfCanary.enabled && !config.selfCanary.targetContactName.trim()) {
      errors.push("Missing WECHATY_SELF_CANARY_TARGET_CONTACT_NAME");
    }
  }

  if (config.roomCanary) {
    if (rawRoomCanaryIntervalSeconds && !parsePositiveNumberRangeLiteral(rawRoomCanaryIntervalSeconds)) {
      errors.push(`Invalid WECHATY_ROOM_CANARY_INTERVAL_SECONDS: ${rawRoomCanaryIntervalSeconds}`);
    }

    if (
      !Number.isFinite(config.roomCanary.intervalMinSeconds) ||
      config.roomCanary.intervalMinSeconds <= 0 ||
      !Number.isFinite(config.roomCanary.intervalMaxSeconds) ||
      config.roomCanary.intervalMaxSeconds <= 0 ||
      config.roomCanary.intervalMinSeconds > config.roomCanary.intervalMaxSeconds
    ) {
      errors.push(
        `Invalid WECHATY_ROOM_CANARY_INTERVAL_SECONDS range: ${config.roomCanary.intervalMinSeconds}-${config.roomCanary.intervalMaxSeconds}`,
      );
    }

    if (!Number.isFinite(config.roomCanary.ackTimeoutSeconds) || config.roomCanary.ackTimeoutSeconds <= 0) {
      errors.push(`Invalid WECHATY_ROOM_CANARY_ACK_TIMEOUT_SECONDS: ${config.roomCanary.ackTimeoutSeconds}`);
    }

    if (!Number.isFinite(config.roomCanary.failureThreshold) || config.roomCanary.failureThreshold <= 0) {
      errors.push(`Invalid WECHATY_ROOM_CANARY_FAILURE_THRESHOLD: ${config.roomCanary.failureThreshold}`);
    }

    if (config.roomCanary.enabled && !config.roomCanary.targetRoomTopic.trim()) {
      errors.push("Missing WECHATY_ROOM_CANARY_TARGET_ROOM_TOPIC");
    }
  }

  if (!config.timeZone.trim()) {
    errors.push("Missing WECHATY_TIMEZONE");
  } else if (!isValidTimeZone(config.timeZone)) {
    errors.push(`Invalid WECHATY_TIMEZONE: ${config.timeZone}`);
  }

  if (!(config.adminHost ?? "").trim()) {
    errors.push("Missing WECHATY_ADMIN_HOST");
  }

  if (rawAdminPort && (!Number.isFinite(config.adminPort) || Number(config.adminPort) <= 0)) {
    errors.push(`Invalid WECHATY_ADMIN_PORT: ${config.adminPort}`);
  }

  if ((config.adminUsername && !config.adminPassword) || (!config.adminUsername && config.adminPassword)) {
    warnings.push("WECHATY_ADMIN_USERNAME and WECHATY_ADMIN_PASSWORD should be configured together.");
  }

  if (config.channelsParseError) {
    errors.push(config.channelsParseError);
  }

  if (config.channelsSource === "legacy") {
    warnings.push("Using legacy single-channel env vars. Prefer WECHATY_CHANNELS_JSON.");
  }

  if (config.channels.length === 0) {
    errors.push("No channels configured. Set WECHATY_CHANNELS_JSON or legacy single-channel env vars.");
  }

  const enabledChannels = config.channels.filter((channel) => channel.enabled);

  if (config.channels.length > 0 && enabledChannels.length === 0) {
    errors.push("No enabled channels configured.");
  }

  const seenCodes = new Set<string>();
  const seenEnabledTopics = new Set<string>();

  for (const channel of config.channels) {
    if (!channel.code) {
      errors.push("Channel code is required.");
    } else if (seenCodes.has(channel.code)) {
      errors.push(`Duplicate channel code: ${channel.code}`);
    } else {
      seenCodes.add(channel.code);
    }

    if (channel.scenario !== "loss-report" && channel.scenario !== "reimbursement") {
      errors.push(`Unsupported scenario for channel ${channel.code || "(missing-code)"}: ${channel.scenario}`);
    }

    if (channel.match.type !== "room_topic") {
      errors.push(
        `Unsupported match.type for channel ${channel.code || "(missing-code)"}: ${channel.match.type}`,
      );
    }

    if (!channel.match.value) {
      errors.push(`Missing match.value for channel ${channel.code || "(missing-code)"}`);
    } else if (channel.enabled && seenEnabledTopics.has(channel.match.value)) {
      errors.push(`Duplicate enabled room_topic match: ${channel.match.value}`);
    } else if (channel.enabled) {
      seenEnabledTopics.add(channel.match.value);
    }

    if (channel.scenario === "loss-report" && channel.deliveryTargets.length === 0) {
      errors.push(`Channel ${channel.code || "(missing-code)"} must have at least one delivery target.`);
    }

    for (const target of channel.deliveryTargets) {
      if (target.type !== "contact_name" && target.type !== "room_topic") {
        errors.push(
          `Unsupported delivery target type for channel ${channel.code || "(missing-code)"}: ${target.type}`,
        );
      }

      if (!target.value) {
        errors.push(`Empty delivery target value for channel ${channel.code || "(missing-code)"}`);
      }
    }

    if (!isValidCronExpression(channel.summarySchedule)) {
      errors.push(
        `Invalid summarySchedule for channel ${channel.code || "(missing-code)"}: ${channel.summarySchedule}`,
      );
    }

    if (!isValidCronExpression(channel.weeklySummarySchedule ?? "")) {
      errors.push(
        `Invalid weeklySummarySchedule for channel ${channel.code || "(missing-code)"}: ${channel.weeklySummarySchedule}`,
      );
    }
  }

  if (isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    errors.push("Missing WECHATY_PUPPET_SERVICE_TOKEN for wechaty-puppet-service");
  }

  if (config.alertEmailEnabled) {
    if (!config.alertSmtpHost) {
      errors.push("Missing WECHATY_ALERT_SMTP_HOST");
    }

    if (!Number.isInteger(config.alertSmtpPort) || config.alertSmtpPort <= 0) {
      errors.push(`Invalid WECHATY_ALERT_SMTP_PORT: ${config.alertSmtpPort}`);
    }

    if (!config.alertSmtpUsername) {
      errors.push("Missing WECHATY_ALERT_SMTP_USERNAME");
    }

    if (!config.alertSmtpPassword) {
      errors.push("Missing WECHATY_ALERT_SMTP_PASSWORD");
    }

    if (!config.alertEmailFrom) {
      errors.push("Missing WECHATY_ALERT_EMAIL_FROM");
    } else if (!isValidEmailAddress(config.alertEmailFrom)) {
      errors.push(`Invalid WECHATY_ALERT_EMAIL_FROM: ${config.alertEmailFrom}`);
    }

    if (config.alertEmailTo.length === 0) {
      errors.push("Missing WECHATY_ALERT_EMAIL_TO");
    }

    for (const address of config.alertEmailTo) {
      if (!isValidEmailAddress(address)) {
        errors.push(`Invalid WECHATY_ALERT_EMAIL_TO address: ${address}`);
      }
    }

    if (config.alertSmtpSecure && config.alertSmtpPort === 587) {
      warnings.push(
        "WECHATY_ALERT_SMTP_SECURE=true with port 587 is unusual. Double-check whether your SMTP provider expects STARTTLS instead.",
      );
    }

    if (!config.alertSmtpSecure && config.alertSmtpPort === 465) {
      warnings.push(
        "WECHATY_ALERT_SMTP_SECURE=false with port 465 is unusual. Double-check whether your SMTP provider expects implicit TLS instead.",
      );
    }
  }

  return {
    errors,
    warnings,
  };
}

function isValidLogLevel(value: string): value is LogLevelName {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function readLogLevelEnv(name: string, fallback: LogLevelName): LogLevelName {
  const value = process.env[name]?.trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  return isValidLogLevel(value) ? value : (value as LogLevelName);
}

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
