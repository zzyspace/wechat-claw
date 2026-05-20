import type { ChannelConfig } from "../core/channels/types.js";
import { matchChannelByRoomTopic } from "../core/channels/router.js";
import type { Logger } from "../core/logging/logger.js";
import { saveImageAttachment } from "../core/attachments/save-image-attachment.js";
import { normalizeMessage } from "../core/messages/normalize-message.js";
import { saveScenarioExtraction } from "../core/scenarios/scenario-extraction-repository.js";
import { saveRawMessage } from "../core/storage/raw-message-repository.js";
import { extractLossReportHeuristically } from "../scenarios/loss-report/heuristic-extractor.js";
import { extractLossReportByModel } from "../scenarios/loss-report/model-provider.js";
import { sendTextToTarget } from "./delivery-contact.js";

export interface MessageContext {
  channels: ChannelConfig[];
  debugContactName?: string;
  lossExtractionProvider?: string;
  lossExtractionModel?: string;
  lossExtractionApiKey?: string;
  lossExtractionBaseUrl: string;
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
  const channel = matchChannelByRoomTopic(context.channels, roomTopic);

  if (!channel || channel.scenario !== "loss-report") {
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

  if (isTextOnlyMessage(normalizedText, attachments)) {
    logger.info("Skipped text-only room message", {
      channelCode: channel.code,
      roomTopic,
      senderName,
      text: normalizedText,
      typeValue,
    });
    return;
  }

  const normalized = normalizeMessage({
    messageExternalId: String(messageId),
    channelCode: channel.code,
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
      provider: context.lossExtractionProvider,
      model: context.lossExtractionModel,
      apiKey: context.lossExtractionApiKey,
      baseUrl: context.lossExtractionBaseUrl,
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
    channelCode: channel.code,
    inserted: saveResult.inserted,
    rawMessageId: saveResult.rawMessageId,
    roomTopic,
    scenarioStatus: savedExtraction.status,
    senderName,
    text: normalizedText,
    typeValue,
  });

  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  if (!bot) {
    logger.warn("Wechaty instance unavailable for delivery target notification", {
      channelCode: channel.code,
    });
    return;
  }

  if (!context.debugContactName) {
    return;
  }

  const deliveryResult = await sendTextToTarget(
    bot,
    {
      type: "contact_name",
      value: context.debugContactName,
    },
    [
      "[wechat-claw] 已收到群消息",
      `逻辑频道: ${channel.code}`,
      `群聊: ${roomTopic}`,
      `发送人: ${senderName}`,
      `消息类型: ${String(typeValue)}`,
      `内容: ${normalizedText}`,
      `附件数: ${attachments.length}`,
      `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
      `报损提取: ${savedExtraction.status} / review=${savedExtraction.needsReview ? "是" : "否"}`,
    ].join("\n"),
    logger,
  );

  logger.info("Sent room message delivery notifications", {
    channelCode: channel.code,
    debugContactName: context.debugContactName,
    delivered: deliveryResult.delivered,
  });
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

function isTextOnlyMessage(normalizedText: string, attachments: unknown[]) {
  return attachments.length === 0 && normalizedText !== "(非文本消息)";
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
