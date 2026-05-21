import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { getEnabledChannels } from "../core/channels/router.js";
import { logger } from "../core/logging/logger.js";
import { parseCronExpression } from "../core/runtime/cron-scheduler.js";
import { assertLogDirWritable, assertStateDirWritable } from "../core/runtime/state-paths.js";
import { loadPuppetModule, loadWechatyModule } from "../bot/wechaty-loader.js";

async function main() {
  const config = getAppConfig();
  const validation = validateAppConfig(config);
  const enabledChannels = getEnabledChannels(config.channels);

  logger.info("Config summary", {
    botName: config.botName,
    debugContactName: config.debugContactName ?? "(empty)",
    channels: config.channels.map((channel) => ({
      code: channel.code,
      deliveryTargets: channel.deliveryTargets,
      enabled: channel.enabled,
      roomTopic: channel.match.value,
      scenario: channel.scenario,
      summarySchedule: channel.summarySchedule || "(disabled)",
      weeklySummarySchedule: channel.weeklySummarySchedule || "(disabled)",
    })),
    channelsSource: config.channelsSource,
    puppet: config.puppet ?? "(empty)",
    puppetServiceTokenConfigured: Boolean(config.puppetServiceToken),
    stateDir: config.stateDir,
    timeZone: config.timeZone,
    enabledChannels: enabledChannels.length,
    logDir: config.logDir,
    logLevel: config.logLevel,
    alertEmailEnabled: config.alertEmailEnabled,
    alertEmailRecipients: config.alertEmailTo.length,
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
    const logDir = assertLogDirWritable(config);
    logger.info("State directory check passed", {
      logDir,
      stateDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("State directory check failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
    return;
  }

  try {
    const scheduledChannels = enabledChannels.filter(
      (channel) => channel.summarySchedule || channel.weeklySummarySchedule,
    );

    if (scheduledChannels.length === 0) {
      logger.warn("Summary cron check skipped", {
        reason: "no enabled channel daily or weekly summary schedule configured",
      });
    } else {
      for (const channel of scheduledChannels) {
        if (channel.summarySchedule) {
          parseCronExpression(channel.summarySchedule);
        }

        if (channel.weeklySummarySchedule) {
          parseCronExpression(channel.weeklySummarySchedule);
        }
      }

      logger.info("Summary cron check passed", {
        channels: scheduledChannels.map((channel) => ({
          code: channel.code,
          summarySchedule: channel.summarySchedule,
          weeklySummarySchedule: channel.weeklySummarySchedule ?? "",
        })),
        timeZone: config.timeZone,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Summary cron check failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
    return;
  }

  try {
    await loadWechatyModule();
    logger.info("Wechaty module check passed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Wechaty module check failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
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
    logger.error("Puppet runtime check failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
    return;
  }

  logger.info("Doctor check passed", {
    nextStep: "Run `npm run dev` and scan the QR code with the bot account.",
  });
}

void main();
