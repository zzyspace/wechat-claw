import { config as loadEnv } from "dotenv";

loadEnv();

export interface AppConfig {
  puppet?: string;
  puppetServiceToken?: string;
  botName: string;
  targetRoomTopic?: string;
  deliveryContactName?: string;
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

export function getAppConfig(): AppConfig {
  return {
    puppet: readOptionalEnv("WECHATY_PUPPET"),
    puppetServiceToken: readOptionalEnv("WECHATY_PUPPET_SERVICE_TOKEN"),
    botName: process.env.WECHATY_BOT_NAME?.trim() || "wechat-loss-bot",
    targetRoomTopic: readOptionalEnv("WECHATY_TARGET_ROOM_TOPIC"),
    deliveryContactName: readOptionalEnv("WECHATY_DELIVERY_CONTACT_NAME"),
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
