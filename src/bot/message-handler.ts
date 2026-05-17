import type { Logger } from "../core/logging/logger.js";

export interface MessageContext {
  targetRoomTopic?: string;
  deliveryContactName?: string;
}

async function safeTalk(contact: any, text: string, logger: Logger) {
  if (!contact) {
    logger.warn("Delivery contact not found");
    return;
  }

  await contact.say(text);
}

export async function handleMessage(message: any, context: MessageContext, logger: Logger) {
  if (message.self && typeof message.self === "function" && message.self()) {
    return;
  }

  const room = typeof message.room === "function" ? await message.room() : null;

  if (!room) {
    return;
  }

  const roomTopic = typeof room.topic === "function" ? await room.topic() : "";

  if (context.targetRoomTopic && roomTopic !== context.targetRoomTopic) {
    return;
  }

  const talker = typeof message.talker === "function" ? await message.talker() : null;
  const senderName = talker && typeof talker.name === "function" ? talker.name() : "unknown";
  const text = typeof message.text === "function" ? message.text() : "";
  const typeValue = typeof message.type === "function" ? message.type() : "unknown";
  const normalizedText = text.trim() || "(非文本消息)";

  logger.info("Received room message", {
    roomTopic,
    senderName,
    text: normalizedText,
    typeValue,
  });

  if (!context.deliveryContactName) {
    return;
  }

  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  const deliveryContact =
    bot && typeof bot.Contact?.find === "function"
      ? await bot.Contact.find({ name: context.deliveryContactName })
      : null;

  await safeTalk(
    deliveryContact,
    `[wechat-claw] 已收到群消息\n群聊: ${roomTopic}\n发送人: ${senderName}\n消息类型: ${String(typeValue)}\n内容: ${normalizedText}`,
    logger,
  );
}
