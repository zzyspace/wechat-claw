import type { Logger } from "../core/logging/logger.js";
import { saveImageAttachment } from "../core/attachments/save-image-attachment.js";
import { normalizeMessage } from "../core/messages/normalize-message.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";

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
  const messageId = typeof message.id === "function" ? message.id() : message.id || cryptoRandomId();
  const sentAt =
    typeof message.date === "function"
      ? new Date(message.date()).toISOString()
      : new Date().toISOString();

  const attachments = [];

  if (String(typeValue).toLowerCase().includes("image") || Number(typeValue) === 3) {
    const imageAttachment = await saveImageAttachment(message);
    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
  }

  const normalized = normalizeMessage({
    messageExternalId: String(messageId),
    channelExternalId: typeof room.id === "function" ? room.id() : undefined,
    channelName: roomTopic,
    senderExternalId: talker && typeof talker.id === "function" ? talker.id() : undefined,
    senderName,
    messageType: String(typeValue),
    textContent: normalizedText,
    sentAt,
    attachments,
  });

  const saveResult = saveRawMessage(normalized);

  logger.info("Received room message", {
    attachmentsCount: attachments.length,
    inserted: saveResult.inserted,
    rawMessageId: saveResult.rawMessageId,
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
    `[wechat-claw] 已收到群消息\n群聊: ${roomTopic}\n发送人: ${senderName}\n消息类型: ${String(typeValue)}\n内容: ${normalizedText}\n附件数: ${attachments.length}\n入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
    logger,
  );
}

function cryptoRandomId() {
  return `generated_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
