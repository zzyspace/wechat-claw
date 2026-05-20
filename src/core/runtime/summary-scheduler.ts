import { getChannelDisplayName, getEnabledScenarioChannels } from "../channels/router.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { WechatyInstance } from "../../bot/types.js";
import { formatZonedDate } from "./timezone.js";
import { startCronScheduler } from "./cron-scheduler.js";
import type { HealthReporter } from "./health.js";
import { sendLossDailySummary, sendLossWeeklySummary } from "./loss-summary-delivery.js";

export function startLossSummaryScheduler(input: {
  bot: WechatyInstance;
  config: AppConfig;
  logger: Logger;
  healthReporter: HealthReporter;
}): { stop(): void } {
  const { bot, config, logger, healthReporter } = input;
  const lossChannels = getEnabledScenarioChannels(config.channels, "loss-report");
  const scheduledTasks = [
    ...lossChannels
      .filter((channel) => channel.summarySchedule)
      .map((channel) => ({
        channel,
        expression: channel.summarySchedule,
        kind: "daily" as const,
      })),
    ...lossChannels
      .filter((channel) => channel.weeklySummarySchedule)
      .map((channel) => ({
        channel,
        expression: channel.weeklySummarySchedule ?? "",
        kind: "weekly" as const,
      })),
  ];

  if (scheduledTasks.length === 0) {
    logger.info("Summary scheduler disabled", {
      reason: "No enabled loss-report channel has a daily or weekly summary schedule",
    });

    return {
      stop() {
        // no-op
      },
    };
  }

  const schedulers = scheduledTasks.map(({ channel, expression, kind }) => {
    logger.info(`${kind === "daily" ? "Daily" : "Weekly"} summary scheduler enabled`, {
      channelCode: channel.code,
      channelName: getChannelDisplayName(channel),
      summaryCron: expression,
      timeZone: config.timeZone,
    });

    return startCronScheduler({
      expression,
      timeZone: config.timeZone,
      taskName: `loss-${kind}-summary:${channel.code}`,
      logger,
      onTaskError(error) {
        healthReporter.markError(error, {
          status: "degraded",
        });
        logger.error(`${kind === "daily" ? "Daily" : "Weekly"} summary task failed`, {
          channelCode: channel.code,
          channelName: getChannelDisplayName(channel),
          message: error instanceof Error ? error.message : String(error),
        });
      },
      async task() {
        const targetDate = formatZonedDate(new Date(), config.timeZone);

        try {
          const result =
            kind === "daily"
              ? await sendLossDailySummary({
                  bot,
                  channel,
                  config,
                  logger,
                  targetDate,
                })
              : await sendLossWeeklySummary({
                  bot,
                  channel,
                  config,
                  logger,
                  targetDate,
                });

          healthReporter.markSummary();
          logger.info(`${kind === "daily" ? "Daily" : "Weekly"} summary sent`, {
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
            logger.warn(`${kind === "daily" ? "Daily" : "Weekly"} summary skipped because bot is not logged in`, {
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
