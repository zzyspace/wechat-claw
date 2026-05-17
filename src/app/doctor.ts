import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { logger } from "../core/logging/logger.js";
import { loadWechatyModule } from "../bot/wechaty-loader.js";

async function main() {
  const config = getAppConfig();
  const validation = validateAppConfig(config);

  logger.info("Config summary", {
    botName: config.botName,
    puppet: config.puppet ?? "(empty)",
    puppetServiceTokenConfigured: Boolean(config.puppetServiceToken),
    targetRoomTopic: config.targetRoomTopic ?? "(empty)",
    deliveryContactName: config.deliveryContactName ?? "(empty)",
  });

  for (const warning of validation.warnings) {
    logger.warn("Config warning", { warning });
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      logger.error("Config error", { error });
    }

    process.exitCode = 1;
    return;
  }

  try {
    await loadWechatyModule();
    logger.info("Wechaty module check passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Wechaty module check failed", { message });
    process.exitCode = 1;
    return;
  }

  logger.info("Doctor check passed", {
    nextStep: "Run `npm run dev` and scan the QR code with the bot account.",
  });
}

void main();
