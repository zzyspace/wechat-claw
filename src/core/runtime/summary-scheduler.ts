import { getChannelDisplayName, getEnabledScenarioChannels } from "../channels/router.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { WechatyInstance } from "../../bot/types.js";
import { formatZonedDate } from "./timezone.js";
import { startCronScheduler } from "./cron-scheduler.js";
import type { HealthReporter } from "./health.js";
import { sendLossDailySummary } from "./loss-summary-delivery.js";

export function startLossSummaryScheduler(input: {
  bot: WechatyInstance;
  config: AppConfig;
  logger: Logger;
  healthReporter: HealthReporter;
}): { stop(): void } {
  const { bot, config, logger, healthReporter } = input;
  const summaryChannels = getEnabledScenarioChannels(config.channels, "loss-report").filter(
    (channel) => channel.summarySchedule,
  );

  if (summaryChannels.length === 0) {
    logger.info("Daily summary scheduler disabled", {
      reason: "No enabled loss-report channel has a summarySchedule",
    });

    return {
      stop() {
        // no-op
      },
    };
  }

  const schedulers = summaryChannels.map((channel) => {
    logger.info("Daily summary scheduler enabled", {
      channelCode: channel.code,
      channelName: getChannelDisplayName(channel),
      summaryCron: channel.summarySchedule,
      timeZone: config.timeZone,
    });

    return startCronScheduler({
      expression: channel.summarySchedule,
      timeZone: config.timeZone,
      taskName: `loss-daily-summary:${channel.code}`,
      logger,
      onTaskError(error) {
        healthReporter.markError(error, {
          status: "degraded",
        });
        logger.error("Daily summary task failed", {
          channelCode: channel.code,
          channelName: getChannelDisplayName(channel),
          message: error instanceof Error ? error.message : String(error),
        });
      },
      async task() {
        const targetDate = formatZonedDate(new Date(), config.timeZone);

        try {
          const result = await sendLossDailySummary({
            bot,
            channel,
            config,
            logger,
            targetDate,
          });

          healthReporter.markSummary();
          logger.info("Daily summary sent", {
            channelCode: result.channelCode,
            channelName: result.channelName,
            deliveredTargets: result.deliveredTargets,
            targetDate: result.targetDate,
            totalTargets: result.totalTargets,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes("Bot is not logged in")) {
            healthReporter.markError(error, {
              status: "degraded",
              category: "login_state_invalid",
            });
            logger.warn("Daily summary skipped because bot is not logged in", {
              channelCode: channel.code,
              targetDate,
            });
            return;
          }

          healthReporter.markError(error, {
            status: "degraded",
          });
          throw error;
        }
      },
    });
  });

  return {
    stop() {
      for (const scheduler of schedulers) {
        scheduler.stop();
      }
    },
  };
}
