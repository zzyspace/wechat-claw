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
  timeZone: string;
  channels: ChannelConfig[];
  channelsSource: ChannelsSource;
  channelsParseError?: string;
  summaryPromptTemplate: string;
  lossMergeWindowSeconds: number;
  lossExtractionProvider?: string;
  lossExtractionModel?: string;
  lossExtractionApiKey?: string;
  lossExtractionBaseUrl: string;
}

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

  return {
    puppet: readOptionalEnv("WECHATY_PUPPET"),
    puppetServiceToken: readOptionalEnv("WECHATY_PUPPET_SERVICE_TOKEN"),
    botName: process.env.WECHATY_BOT_NAME?.trim() || "wechat-loss-bot",
    stateDir: readStringEnv("WECHATY_STATE_DIR", "/var/lib/wechat-claw") || "/var/lib/wechat-claw",
    timeZone: readStringEnv("WECHATY_TIMEZONE", "Asia/Shanghai") || "Asia/Shanghai",
    channels: channelResolution.channels,
    channelsSource: channelResolution.source,
    channelsParseError: channelResolution.error,
    summaryPromptTemplate:
      process.env.WECHATY_SUMMARY_PROMPT_TEMPLATE?.trim() ||
      [
        "请按人汇总今天的报损上报情况。",
        "输出格式：先给总览，再按人列出其报损的物品。",
        "如果某条记录只有图片、没有明确文字，请直接按识别结果汇总，不要输出待确认字样。",
      ].join("\n"),
    lossMergeWindowSeconds: readPositiveNumberEnv("WECHATY_LOSS_MERGE_WINDOW_SECONDS", 60),
    lossExtractionProvider: readOptionalEnv("WECHATY_LOSS_EXTRACTION_PROVIDER"),
    lossExtractionModel: readOptionalEnv("WECHATY_LOSS_EXTRACTION_MODEL"),
    lossExtractionApiKey: readOptionalEnv("WECHATY_LOSS_EXTRACTION_API_KEY"),
    lossExtractionBaseUrl:
      process.env.WECHATY_LOSS_EXTRACTION_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  };
}

export function validateAppConfig(config: AppConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.puppet) {
    errors.push("Missing WECHATY_PUPPET");
  }

  if (!config.stateDir.trim()) {
    errors.push("Missing WECHATY_STATE_DIR");
  }

  if (!config.timeZone.trim()) {
    errors.push("Missing WECHATY_TIMEZONE");
  } else if (!isValidTimeZone(config.timeZone)) {
    errors.push(`Invalid WECHATY_TIMEZONE: ${config.timeZone}`);
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

    if (channel.scenario !== "loss-report") {
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

    if (channel.deliveryTargets.length === 0) {
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
  }

  if (isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    errors.push("Missing WECHATY_PUPPET_SERVICE_TOKEN for wechaty-puppet-service");
  }

  if (!isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    warnings.push(
      "WECHATY_PUPPET_SERVICE_TOKEN is empty. This is expected for tokenless puppets such as wechaty-puppet-wechat.",
    );
  }

  return {
    errors,
    warnings,
  };
}
