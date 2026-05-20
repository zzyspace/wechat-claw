import { dedupeDeliveryTargets, serializeDeliveryTarget } from "../core/channels/router.js";
import type { DeliveryTarget } from "../core/channels/types.js";
import type { Logger } from "../core/logging/logger.js";
import type { WechatyInstance } from "./types.js";

export interface DeliveryTargetResult {
  target: DeliveryTarget;
  delivered: boolean;
  error?: string;
}

export async function findDeliveryTarget(
  bot: WechatyInstance,
  target: DeliveryTarget,
): Promise<any | null> {
  if (target.type === "contact_name") {
    if (typeof bot.Contact?.find !== "function") {
      return null;
    }

    return bot.Contact.find({ name: target.value });
  }

  if (target.type === "room_topic") {
    if (typeof bot.Room?.find !== "function") {
      return null;
    }

    return bot.Room.find({ topic: target.value });
  }

  return null;
}

export async function sendTextToTarget(
  bot: WechatyInstance,
  target: DeliveryTarget,
  text: string,
  logger: Logger,
): Promise<DeliveryTargetResult> {
  try {
    const recipient = await findDeliveryTarget(bot, target);

    if (!recipient) {
      const error = `Delivery target not found: ${serializeDeliveryTarget(target)}`;
      logger.warn("Delivery target not found", {
        targetType: target.type,
        targetValue: target.value,
      });

      return {
        target,
        delivered: false,
        error,
      };
    }

    await recipient.say(text);

    return {
      target,
      delivered: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to send text to delivery target", {
      message,
      targetType: target.type,
      targetValue: target.value,
    });

    return {
      target,
      delivered: false,
      error: message,
    };
  }
}

export async function sendTextToTargets(
  bot: WechatyInstance,
  targets: DeliveryTarget[],
  text: string,
  logger: Logger,
): Promise<DeliveryTargetResult[]> {
  const dedupedTargets = dedupeDeliveryTargets(targets);
  const results: DeliveryTargetResult[] = [];

  for (const target of dedupedTargets) {
    results.push(await sendTextToTarget(bot, target, text, logger));
  }

  return results;
}

export function countSuccessfulDeliveries(results: DeliveryTargetResult[]): number {
  return results.filter((result) => result.delivered).length;
}
