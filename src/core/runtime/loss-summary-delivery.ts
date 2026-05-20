import type { WechatyInstance } from "../../bot/types.js";
import { countSuccessfulDeliveries, sendTextToTargets } from "../../bot/delivery-contact.js";
import { getChannelDisplayName } from "../channels/router.js";
import type { ChannelConfig } from "../channels/types.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { renderLossDailySummaryForDate } from "../../scenarios/loss-report/summary-service.js";
import { formatZonedDate, parseDateString } from "./timezone.js";

export interface LossSummaryDeliveryResult {
  channelCode: string;
  channelName: string;
  deliveredTargets: number;
  summaryText: string;
  targetDate: string;
  totalTargets: number;
}

export async function sendLossDailySummary(input: {
  bot: WechatyInstance;
  channel: ChannelConfig;
  config: AppConfig;
  logger: Logger;
  targetDate?: string;
}): Promise<LossSummaryDeliveryResult> {
  const { bot, channel, config, logger } = input;

  if (!bot.isLoggedIn) {
    throw new Error(`Bot is not logged in. Daily summary will not be sent for ${channel.code}.`);
  }

  const targetDate = input.targetDate ?? formatZonedDate(new Date(), config.timeZone);
  parseDateString(targetDate);

  const channelName = getChannelDisplayName(channel);
  const summaryText = renderLossDailySummaryForDate(targetDate, {
    summaryCron: channel.summarySchedule,
    summaryPromptTemplate: config.summaryPromptTemplate,
    mergeWindowSeconds: config.lossMergeWindowSeconds,
    timeZone: config.timeZone,
    channelCode: channel.code,
    channelName,
  });
  const deliveryResults = await sendTextToTargets(
    bot,
    channel.deliveryTargets,
    summaryText,
    logger,
  );
  const deliveredTargets = countSuccessfulDeliveries(deliveryResults);

  if (deliveredTargets === 0) {
    throw new Error(`Daily summary delivery failed for all targets on channel ${channel.code}`);
  }

  return {
    channelCode: channel.code,
    channelName,
    deliveredTargets,
    summaryText,
    targetDate,
    totalTargets: deliveryResults.length,
  };
}
