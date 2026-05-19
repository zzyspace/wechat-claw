import type { Logger } from "../core/logging/logger.js";
import { saveImageAttachment } from "../core/attachments/save-image-attachment.js";
import { getAppConfig } from "../core/config/env.js";
import { normalizeMessage } from "../core/messages/normalize-message.js";
import { saveScenarioExtraction } from "../core/scenarios/scenario-extraction-repository.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";
import { sendTextToNamedContact } from "./delivery-contact.js";
import { extractLossReportHeuristically } from "../scenarios/loss-report/heuristic-extractor.js";
import { extractLossReportByModel } from "../scenarios/loss-report/model-provider.js";

export interface MessageContext {
  targetRoomTopic?: string;
  deliveryContactName?: string;
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
  const senderName = await resolveSenderName(room, talker);
  const text = typeof message.text === "function" ? message.text() : "";
  const typeValue = typeof message.type === "function" ? message.type() : "unknown";
  const normalizedText = normalizeMessageText(text, typeValue);
  const messageId = typeof message.id === "function" ? message.id() : message.id || cryptoRandomId();
  const eventReceivedAt = new Date().toISOString();

  const attachments = [];

  if (isImageLikeMessage(typeValue, normalizedText)) {
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
    eventReceivedAt,
    attachments,
  });

  const saveResult = saveRawMessage(normalized);
  const appConfig = getAppConfig();
  const modelExtraction = await extractLossReportByModel(
    {
      rawMessageId: saveResult.rawMessageId,
      channelName: roomTopic,
      senderName,
      textContent: normalizedText,
      sentAt: eventReceivedAt,
      attachments,
    },
    {
      enabled: true,
      provider: appConfig.lossExtractionProvider,
      model: appConfig.lossExtractionModel,
      apiKey: appConfig.lossExtractionApiKey,
      baseUrl: appConfig.lossExtractionBaseUrl,
    },
  );
  const lossReportExtraction =
    modelExtraction ??
    extractLossReportHeuristically({
      rawMessageId: saveResult.rawMessageId,
      channelName: roomTopic,
      senderName,
      messageType: String(typeValue),
      textContent: normalizedText,
      sentAt: eventReceivedAt,
      attachments,
    });
  const savedExtraction = saveScenarioExtraction({
    rawMessageId: saveResult.rawMessageId,
    scenarioCode: lossReportExtraction.scenarioCode,
    extractorCode: lossReportExtraction.extractorCode,
    status: lossReportExtraction.status,
    confidence: lossReportExtraction.confidence,
    needsReview: lossReportExtraction.needsReview,
    resultJson: lossReportExtraction.resultJson,
  });

  logger.info("Received room message", {
    attachmentsCount: attachments.length,
    inserted: saveResult.inserted,
    rawMessageId: saveResult.rawMessageId,
    roomTopic,
    scenarioStatus: savedExtraction.status,
    senderName,
    text: normalizedText,
    typeValue,
  });

  if (!context.deliveryContactName) {
    return;
  }

  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  if (!bot) {
    logger.warn("Wechaty instance unavailable for delivery contact notification");
    return;
  }

  await sendTextToNamedContact(
    bot,
    context.deliveryContactName,
    `[wechat-claw] 已收到群消息\n群聊: ${roomTopic}\n发送人: ${senderName}\n消息类型: ${String(typeValue)}\n内容: ${normalizedText}\n附件数: ${attachments.length}\n入库: ${saveResult.inserted ? "新消息" : "已去重"}\n报损提取: ${savedExtraction.status} / review=${savedExtraction.needsReview ? "是" : "否"}`,
    logger,
  );
}

function cryptoRandomId() {
  return `generated_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isImageLikeMessage(typeValue: unknown, normalizedText: string) {
  const numericType = Number(typeValue);
  const textType = String(typeValue).toLowerCase();

  if (textType.includes("image")) {
    return true;
  }

  if (numericType === 3 || numericType === 6) {
    return true;
  }

  if (normalizedText.includes("<img ") || normalizedText.includes("&lt;img ")) {
    return true;
  }

  return false;
}

function normalizeMessageText(text: string, typeValue: unknown) {
  const trimmed = text.trim();

  if (!trimmed) {
    return "(非文本消息)";
  }

  if (isXmlImagePayload(trimmed, typeValue)) {
    return "(非文本消息)";
  }

  return trimmed;
}

function isXmlImagePayload(text: string, typeValue: unknown) {
  const numericType = Number(typeValue);

  if (numericType === 6 && (text.includes("<img ") || text.includes("&lt;img "))) {
    return true;
  }

  return false;
}

async function resolveSenderName(room: any, talker: any) {
  if (!talker) {
    return "unknown";
  }

  if (room && typeof room.alias === "function") {
    try {
      const roomAlias = await room.alias(talker);
      if (roomAlias && String(roomAlias).trim()) {
        return String(roomAlias).trim();
      }
    } catch {
      // ignore and fall back to contact nickname
    }
  }

  if (typeof talker.name === "function") {
    return talker.name();
  }

  return "unknown";
}
