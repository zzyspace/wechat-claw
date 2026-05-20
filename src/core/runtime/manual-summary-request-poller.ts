import type { WechatyInstance } from "../../bot/types.js";
import { getEnabledScenarioChannels } from "../channels/router.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { HealthReporter } from "./health.js";
import { sendLossDailySummary } from "./loss-summary-delivery.js";
import {
  claimSummarySendRequest,
  listPendingSummarySendRequests,
  markSummarySendRequestFailed,
  markSummarySendRequestSent,
} from "./manual-summary-request.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export function startManualSummaryRequestPoller(input: {
  bot: WechatyInstance;
  config: AppConfig;
  healthReporter: HealthReporter;
  logger: Logger;
  pollIntervalMs?: number;
}): { stop(): void } {
  const { bot, config, healthReporter, logger } = input;
  const channels = getEnabledScenarioChannels(config.channels, "loss-report");
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let loginBlockedLogged = false;

  async function tick() {
    if (stopped || running) {
      return;
    }

    running = true;

    try {
      const pendingRequests = listPendingSummarySendRequests();

      if (pendingRequests.length > 0 && !bot.isLoggedIn) {
        if (!loginBlockedLogged) {
          const error = new Error("Bot is not logged in. Manual daily summary requests are waiting in queue.");
          healthReporter.markError(error, {
            category: "login_state_invalid",
            status: "degraded",
          });
          logger.warn("Manual daily summary requests are waiting because bot is not logged in", {
            pendingRequests: pendingRequests.map((request) => ({
              channelCode: request.channelCode,
              requestId: request.id,
              targetDate: request.targetDate,
            })),
          });
          loginBlockedLogged = true;
        }

        return;
      }

      loginBlockedLogged = false;

      for (const pendingRequest of pendingRequests) {
        const request = claimSummarySendRequest(pendingRequest.id);

        if (!request) {
          continue;
        }

        const channel = channels.find((item) => item.code === request.channelCode);

        if (!channel) {
          const errorMessage = `Enabled loss-report channel not found: ${request.channelCode}`;
          markSummarySendRequestFailed(request.id, errorMessage);
          logger.warn("Manual daily summary request failed", {
            channelCode: request.channelCode,
            errorMessage,
            requestId: request.id,
            targetDate: request.targetDate,
          });
          continue;
        }

        try {
          const result = await sendLossDailySummary({
            bot,
            channel,
            config,
            logger,
            targetDate: request.targetDate,
          });

          markSummarySendRequestSent(request.id);
          healthReporter.markSummary();
          logger.info("Manual daily summary request completed", {
            channelCode: result.channelCode,
            channelName: result.channelName,
            deliveredTargets: result.deliveredTargets,
            requestId: request.id,
            requestedBy: request.requestedBy,
            targetDate: result.targetDate,
            totalTargets: result.totalTargets,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          markSummarySendRequestFailed(request.id, errorMessage);

          healthReporter.markError(error, {
            status: "degraded",
          });
          logger.error("Manual daily summary request failed", {
            channelCode: request.channelCode,
            message: errorMessage,
            requestId: request.id,
            targetDate: request.targetDate,
          });
        }
      }
    } finally {
      running = false;

      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, pollIntervalMs);
      }
    }
  }

  timer = setTimeout(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
