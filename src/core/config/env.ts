import { config as loadEnv } from "dotenv";

loadEnv();

export interface AppConfig {
  puppet?: string;
  puppetServiceToken?: string;
  botName: string;
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

export function getAppConfig(): AppConfig {
  return {
    puppet: readOptionalEnv("WECHATY_PUPPET"),
    puppetServiceToken: readOptionalEnv("WECHATY_PUPPET_SERVICE_TOKEN"),
    botName: process.env.WECHATY_BOT_NAME?.trim() || "wechat-loss-bot",
    targetRoomTopic: readOptionalEnv("WECHATY_TARGET_ROOM_TOPIC"),
    deliveryContactName: readOptionalEnv("WECHATY_DELIVERY_CONTACT_NAME"),
    summaryCron: process.env.WECHATY_SUMMARY_CRON?.trim() || "0 22 * * *",
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

  if (isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    errors.push("Missing WECHATY_PUPPET_SERVICE_TOKEN for wechaty-puppet-service");
  }

  if (!isServicePuppet(config.puppet) && !config.puppetServiceToken) {
    warnings.push("WECHATY_PUPPET_SERVICE_TOKEN is empty. This is expected for tokenless puppets such as wechaty-puppet-wechat.");
  }

  return {
    errors,
    warnings,
  };
}
