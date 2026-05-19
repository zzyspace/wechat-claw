import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { logger } from "../core/logging/logger.js";
import { parseCronExpression } from "../core/runtime/cron-scheduler.js";
import { assertStateDirWritable } from "../core/runtime/state-paths.js";
import { loadPuppetModule, loadWechatyModule } from "../bot/wechaty-loader.js";

async function main() {
  const config = getAppConfig();
  const validation = validateAppConfig(config);

  logger.info("Config summary", {
    botName: config.botName,
    puppet: config.puppet ?? "(empty)",
    puppetServiceTokenConfigured: Boolean(config.puppetServiceToken),
    stateDir: config.stateDir,
    timeZone: config.timeZone,
    targetRoomTopic: config.targetRoomTopic ?? "(empty)",
    deliveryContactName: config.deliveryContactName ?? "(empty)",
    summaryCron: config.summaryCron || "(disabled)",
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
    const stateDir = assertStateDirWritable(config);
    logger.info("State directory check passed", { stateDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("State directory check failed", { message });
    process.exitCode = 1;
    return;
  }

  try {
    if (config.summaryCron) {
      parseCronExpression(config.summaryCron);
      logger.info("Summary cron check passed", {
        summaryCron: config.summaryCron,
        timeZone: config.timeZone,
      });
    } else {
      logger.warn("Summary cron check skipped", {
        reason: "scheduler disabled",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Summary cron check failed", { message });
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

  try {
    await loadPuppetModule(config.puppet);
    logger.info("Puppet runtime check passed", {
      puppet: config.puppet,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Puppet runtime check failed", { message });
    process.exitCode = 1;
    return;
  }

  logger.info("Doctor check passed", {
    nextStep: "Run `npm run dev` and scan the QR code with the bot account.",
  });
}

void main();
