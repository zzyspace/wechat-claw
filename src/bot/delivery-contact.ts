import type { Logger } from "../core/logging/logger.js";
import type { WechatyInstance } from "./types.js";

export async function findNamedContact(
  bot: WechatyInstance,
  contactName: string,
): Promise<any | null> {
  if (typeof bot.Contact?.find !== "function") {
    return null;
  }

  return bot.Contact.find({ name: contactName });
}

export async function sendTextToNamedContact(
  bot: WechatyInstance,
  contactName: string,
  text: string,
  logger: Logger,
): Promise<boolean> {
  const contact = await findNamedContact(bot, contactName);

  if (!contact) {
    logger.warn("Named contact not found", {
      contactName,
    });
    return false;
  }

  await contact.say(text);
  return true;
}
