import { getChannelDisplayName, getEnabledScenarioChannels } from "../channels/router.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { WechatyInstance } from "../../bot/types.js";
import { countSuccessfulDeliveries, sendTextToTargets } from "../../bot/delivery-contact.js";
import { renderLossDailySummaryForDate } from "../../scenarios/loss-report/summary-service.js";
import { formatZonedDate } from "./timezone.js";
import { startCronScheduler } from "./cron-scheduler.js";
import type { HealthReporter } from "./health.js";

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
        if (!bot.isLoggedIn) {
          const error = new Error(`Bot is not logged in. Daily summary will not be sent for ${channel.code}.`);
          healthReporter.markError(error, {
            status: "degraded",
            category: "login_state_invalid",
          });
          logger.warn("Daily summary skipped because bot is not logged in", {
            channelCode: channel.code,
            targetDate: formatZonedDate(new Date(), config.timeZone),
          });
          return;
        }

        const targetDate = formatZonedDate(new Date(), config.timeZone);
        const summaryText = renderLossDailySummaryForDate(targetDate, {
          summaryCron: channel.summarySchedule,
          summaryPromptTemplate: config.summaryPromptTemplate,
          mergeWindowSeconds: config.lossMergeWindowSeconds,
          timeZone: config.timeZone,
          channelCode: channel.code,
          channelName: getChannelDisplayName(channel),
        });
        const deliveryResults = await sendTextToTargets(
          bot,
          channel.deliveryTargets,
          summaryText,
          logger,
        );
        const deliveredCount = countSuccessfulDeliveries(deliveryResults);

        if (deliveredCount === 0) {
          const error = new Error(`Daily summary delivery failed for all targets on channel ${channel.code}`);
          healthReporter.markError(error, {
            status: "degraded",
          });
          return;
        }

        healthReporter.markSummary();
        logger.info("Daily summary sent", {
          channelCode: channel.code,
          channelName: getChannelDisplayName(channel),
          deliveredTargets: deliveredCount,
          targetDate,
          totalTargets: deliveryResults.length,
        });
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
