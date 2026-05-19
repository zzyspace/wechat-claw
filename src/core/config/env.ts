import { config as loadEnv } from "dotenv";

loadEnv();

export interface AppConfig {
  puppet?: string;
  puppetServiceToken?: string;
  botName: string;
  stateDir: string;
  timeZone: string;
  targetRoomTopic?: string;
  deliveryContactName?: string;
  summaryCron: string;
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

export function getAppConfig(): AppConfig {
  return {
    puppet: readOptionalEnv("WECHATY_PUPPET"),
    puppetServiceToken: readOptionalEnv("WECHATY_PUPPET_SERVICE_TOKEN"),
    botName: process.env.WECHATY_BOT_NAME?.trim() || "wechat-loss-bot",
    stateDir: readStringEnv("WECHATY_STATE_DIR", "/var/lib/wechat-claw") || "/var/lib/wechat-claw",
    timeZone: readStringEnv("WECHATY_TIMEZONE", "Asia/Shanghai") || "Asia/Shanghai",
    targetRoomTopic: readOptionalEnv("WECHATY_TARGET_ROOM_TOPIC"),
    deliveryContactName: readOptionalEnv("WECHATY_DELIVERY_CONTACT_NAME"),
    summaryCron: readStringEnv("WECHATY_SUMMARY_CRON", "0 22 * * *"),
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

  if (!config.targetRoomTopic) {
    errors.push("Missing WECHATY_TARGET_ROOM_TOPIC");
  }

  if (!config.deliveryContactName) {
    errors.push("Missing WECHATY_DELIVERY_CONTACT_NAME");
  }

  if (!config.stateDir.trim()) {
    errors.push("Missing WECHATY_STATE_DIR");
  }

  if (!config.timeZone.trim()) {
    errors.push("Missing WECHATY_TIMEZONE");
  } else if (!isValidTimeZone(config.timeZone)) {
    errors.push(`Invalid WECHATY_TIMEZONE: ${config.timeZone}`);
  }

  if (!isValidCronExpression(config.summaryCron)) {
    errors.push(`Invalid WECHATY_SUMMARY_CRON: ${config.summaryCron}`);
  }

  if (isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    errors.push("Missing WECHATY_PUPPET_SERVICE_TOKEN for wechaty-puppet-service");
  }

  if (!isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    warnings.push("WECHATY_PUPPET_SERVICE_TOKEN is empty. This is expected for tokenless puppets such as wechaty-puppet-wechat.");
  }

  if (!config.summaryCron) {
    warnings.push("WECHATY_SUMMARY_CRON is empty. Daily summary scheduler is disabled.");
  }

  return {
    errors,
    warnings,
  };
}
