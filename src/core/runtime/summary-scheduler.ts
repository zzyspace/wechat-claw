import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { WechatyInstance } from "../../bot/types.js";
import { sendTextToNamedContact } from "../../bot/delivery-contact.js";
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

  if (!config.summaryCron) {
    logger.info("Daily summary scheduler disabled", {
      reason: "WECHATY_SUMMARY_CRON is empty",
    });

    return {
      stop() {
        // no-op
      },
    };
  }

  logger.info("Daily summary scheduler enabled", {
    summaryCron: config.summaryCron,
    timeZone: config.timeZone,
  });

  return startCronScheduler({
    expression: config.summaryCron,
    timeZone: config.timeZone,
    taskName: "loss-daily-summary",
    logger,
    onTaskError(error) {
      healthReporter.markError(error, {
        status: "degraded",
      });
      logger.error("Daily summary task failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
    async task() {
      if (!config.deliveryContactName) {
        logger.warn("Daily summary skipped because delivery contact is not configured");
        return;
      }

      if (!bot.isLoggedIn) {
        const error = new Error("Bot is not logged in. Daily summary will not be sent.");
        healthReporter.markError(error, {
          status: "degraded",
          category: "login_state_invalid",
        });
        logger.warn("Daily summary skipped because bot is not logged in", {
          targetDate: formatZonedDate(new Date(), config.timeZone),
        });
        return;
      }

      const targetDate = formatZonedDate(new Date(), config.timeZone);
      const summaryText = renderLossDailySummaryForDate(targetDate, {
        summaryCron: config.summaryCron,
        summaryPromptTemplate: config.summaryPromptTemplate,
        mergeWindowSeconds: config.lossMergeWindowSeconds,
        timeZone: config.timeZone,
      });
      const delivered = await sendTextToNamedContact(
        bot,
        config.deliveryContactName,
        summaryText,
        logger,
      );

      if (!delivered) {
        const error = new Error(
          `Daily summary delivery contact not found: ${config.deliveryContactName}`,
        );
        healthReporter.markError(error, {
          status: "degraded",
        });
        return;
      }

      healthReporter.markSummary();
      logger.info("Daily summary sent", {
        targetDate,
        deliveryContactName: config.deliveryContactName,
      });
    },
  });
}
