import type { ChannelConfig } from "../core/channels/types.js";
import { matchChannelByRoomTopic } from "../core/channels/router.js";
import type { Logger } from "../core/logging/logger.js";
import { saveImageAttachment } from "../core/attachments/save-image-attachment.js";
import { normalizeMessage } from "../core/messages/normalize-message.js";
import { getReimbursementRawStorageDir } from "../core/runtime/state-paths.js";
import { saveScenarioExtraction } from "../core/scenarios/scenario-extraction-repository.js";
import { hasRecentImageMessage, saveRawMessage } from "../core/storage/raw-message-repository.js";
import type { StoredAttachment } from "../core/storage/types.js";
import { extractLossReportHeuristically } from "../scenarios/loss-report/heuristic-extractor.js";
import { extractLossReportByModel } from "../scenarios/loss-report/model-provider.js";
import { extractReimbursementReport } from "../scenarios/reimbursement/extractor.js";
import {
  attachRemarkToReimbursementReport,
  findRecentPrimaryImageReimbursementReport,
  saveReimbursementReport,
} from "../scenarios/reimbursement/repository.js";
import { sendTextToTarget } from "./delivery-contact.js";

export interface MessageContext {
  channels: ChannelConfig[];
  debugContactName?: string;
  timeZone?: string;
  lossMergeWindowSeconds: number;
  lossExtractionProvider?: string;
  lossExtractionModel?: string;
  lossExtractionApiKey?: string;
  lossExtractionBaseUrl: string;
  reimbursementExtractionProvider?: string;
  reimbursementExtractionModel?: string;
  reimbursementExtractionApiKey?: string;
  reimbursementExtractionBaseUrl?: string;
}

interface ParsedRoomMessage {
  attachments: StoredAttachment[];
  channel: ChannelConfig;
  channelExternalId?: string;
  eventReceivedAt: string;
  messageExternalId: string;
  messageType: string;
  normalizedText: string;
  roomTopic: string;
  senderExternalId?: string;
  senderName: string;
  typeValue: unknown;
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

  if (!channel) {
    return;
  }

  const talker = typeof message.talker === "function" ? await message.talker() : null;
  const senderName = await resolveSenderName(room, talker);
  const text = typeof message.text === "function" ? message.text() : "";
  const typeValue = typeof message.type === "function" ? message.type() : "unknown";
  const normalizedText = normalizeMessageText(text, typeValue);
  const messageId = typeof message.id === "function" ? message.id() : message.id || cryptoRandomId();
  const eventReceivedAt = new Date().toISOString();
  const attachments: StoredAttachment[] = [];

  if (isImageLikeMessage(typeValue, normalizedText)) {
    const imageAttachment = await saveImageAttachment(message, {
      rawStorageDir: channel.scenario === "reimbursement" ? getReimbursementRawStorageDir() : undefined,
    });

    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
  }

  const senderExternalId = talker && typeof talker.id === "function" ? talker.id() : undefined;
  const parsed: ParsedRoomMessage = {
    attachments,
    channel,
    channelExternalId: typeof room.id === "function" ? room.id() : undefined,
    eventReceivedAt,
    messageExternalId: String(messageId),
    messageType: String(typeValue),
    normalizedText,
    roomTopic,
    senderExternalId,
    senderName,
    typeValue,
  };

  if (channel.scenario === "loss-report") {
    await handleLossReportMessage(message, parsed, context, logger);
    return;
  }

  if (channel.scenario === "reimbursement") {
    await handleReimbursementMessage(message, parsed, context, logger);
  }
}

async function handleLossReportMessage(
  message: any,
  parsed: ParsedRoomMessage,
  context: MessageContext,
  logger: Logger,
) {
  if (
    shouldSkipTextOnlyMessage({
      attachments: parsed.attachments,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      eventReceivedAt: parsed.eventReceivedAt,
      mergeWindowSeconds: context.lossMergeWindowSeconds,
      normalizedText: parsed.normalizedText,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
    })
  ) {
    logger.info("Skipped text-only room message", {
      channelCode: parsed.channel.code,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      text: parsed.normalizedText,
      typeValue: parsed.typeValue,
    });
    return;
  }

  const normalized = normalizeMessage({
    messageExternalId: parsed.messageExternalId,
    channelCode: parsed.channel.code,
    channelExternalId: parsed.channelExternalId,
    channelName: parsed.roomTopic,
    senderExternalId: parsed.senderExternalId,
    senderName: parsed.senderName,
    messageType: parsed.messageType,
    textContent: parsed.normalizedText,
    eventReceivedAt: parsed.eventReceivedAt,
    attachments: parsed.attachments,
  });

  const saveResult = saveRawMessage(normalized);
  const modelExtraction = await extractLossReportByModel(
    {
      rawMessageId: saveResult.rawMessageId,
      channelName: parsed.roomTopic,
      senderName: parsed.senderName,
      textContent: parsed.normalizedText,
      sentAt: parsed.eventReceivedAt,
      attachments: parsed.attachments,
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
      channelName: parsed.roomTopic,
      senderName: parsed.senderName,
      messageType: parsed.messageType,
      textContent: parsed.normalizedText,
      sentAt: parsed.eventReceivedAt,
      attachments: parsed.attachments,
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
    attachmentsCount: parsed.attachments.length,
    channelCode: parsed.channel.code,
    inserted: saveResult.inserted,
    rawMessageId: saveResult.rawMessageId,
    roomTopic: parsed.roomTopic,
    scenarioStatus: savedExtraction.status,
    senderName: parsed.senderName,
    text: parsed.normalizedText,
    typeValue: parsed.typeValue,
  });

  await sendDebugNotification(message, context, logger, parsed.channel, [
    "[wechat-claw] 已收到群消息",
    `逻辑频道: ${parsed.channel.code}`,
    `场景: 报损`,
    `群聊: ${parsed.roomTopic}`,
    `发送人: ${parsed.senderName}`,
    `消息类型: ${parsed.messageType}`,
    `内容: ${parsed.normalizedText}`,
    `附件数: ${parsed.attachments.length}`,
    `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
    `报损提取: ${savedExtraction.status} / review=${savedExtraction.needsReview ? "是" : "否"}`,
  ]);
}

async function handleReimbursementMessage(
  message: any,
  parsed: ParsedRoomMessage,
  context: MessageContext,
  logger: Logger,
) {
  if (isTextOnlyUrlMessage(parsed)) {
    logger.info("Skipped reimbursement text-only URL message", {
      channelCode: parsed.channel.code,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      text: parsed.normalizedText,
      typeValue: parsed.typeValue,
    });
    return;
  }

  const normalized = normalizeMessage({
    messageExternalId: parsed.messageExternalId,
    channelCode: parsed.channel.code,
    channelExternalId: parsed.channelExternalId,
    channelName: parsed.roomTopic,
    senderExternalId: parsed.senderExternalId,
    senderName: parsed.senderName,
    messageType: parsed.messageType,
    textContent: parsed.normalizedText,
    eventReceivedAt: parsed.eventReceivedAt,
    attachments: parsed.attachments,
  });
  const saveResult = saveRawMessage(normalized);

  if (isTextOnlyMessage(parsed) && context.lossMergeWindowSeconds > 0) {
    const currentTime = new Date(parsed.eventReceivedAt).getTime();
    const sinceIso = new Date(currentTime - context.lossMergeWindowSeconds * 1000).toISOString();
    const recentImageReport = findRecentPrimaryImageReimbursementReport({
      beforeIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      sinceIso,
    });

    if (recentImageReport) {
      const updatedReport = attachRemarkToReimbursementReport({
        reimbursementReportId: recentImageReport.id,
        rawMessageId: saveResult.rawMessageId,
        note: parsed.normalizedText,
      });
      const savedExtraction = saveScenarioExtraction({
        rawMessageId: saveResult.rawMessageId,
        scenarioCode: "reimbursement",
        extractorCode: "remark-link-v1",
        status: "extracted",
        confidence: updatedReport.confidence,
        needsReview: updatedReport.needsReview,
        resultJson: {
          eventType: "reimbursement_report_remark",
          rawMessageId: saveResult.rawMessageId,
          reimbursementReportId: updatedReport.id,
          note: parsed.normalizedText,
        },
      });

      logger.info("Received reimbursement room message", {
        attachmentsCount: parsed.attachments.length,
        channelCode: parsed.channel.code,
        inserted: saveResult.inserted,
        rawMessageId: saveResult.rawMessageId,
        reimbursementReportId: updatedReport.id,
        roomTopic: parsed.roomTopic,
        scenarioStatus: savedExtraction.status,
        senderName: parsed.senderName,
        text: parsed.normalizedText,
        typeValue: parsed.typeValue,
      });

      await sendDebugNotification(message, context, logger, parsed.channel, [
        "[wechat-claw] 已收到群消息",
        `逻辑频道: ${parsed.channel.code}`,
        `场景: 报账`,
        `群聊: ${parsed.roomTopic}`,
        `发送人: ${parsed.senderName}`,
        `消息类型: ${parsed.messageType}`,
        `内容: ${parsed.normalizedText}`,
        `附件数: ${parsed.attachments.length}`,
        `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
        `报账处理: 备注合并 / report=${updatedReport.id}`,
      ]);
      return;
    }
  }

  const extraction = await extractReimbursementReport(
    {
      rawMessageId: saveResult.rawMessageId,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      reporter: parsed.senderName,
      textContent: parsed.normalizedText,
      sentAt: parsed.eventReceivedAt,
      timeZone: context.timeZone ?? "Asia/Shanghai",
      attachments: parsed.attachments,
    },
    {
      provider: context.reimbursementExtractionProvider,
      model: context.reimbursementExtractionModel,
      apiKey: context.reimbursementExtractionApiKey,
      baseUrl:
        context.reimbursementExtractionBaseUrl ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  );
  const report = saveReimbursementReport({
    channelCode: parsed.channel.code,
    channelName: parsed.roomTopic,
    reporter: parsed.senderName,
    amount: extraction.resultJson.amount,
    currency: extraction.resultJson.currency,
    expenseCategory: extraction.resultJson.expenseCategory,
    voucherDate: extraction.resultJson.voucherDate,
    voucherDateSource: extraction.resultJson.voucherDateSource,
    note: extraction.resultJson.note,
    evidenceType: extraction.resultJson.evidenceType,
    merchant: extraction.resultJson.merchant,
    documentNo: extraction.resultJson.documentNo,
    voucherType: extraction.resultJson.voucherType,
    ocrText: extraction.resultJson.ocrText,
    confidence: extraction.confidence,
    needsReview: extraction.needsReview,
    primaryRawMessageId: saveResult.rawMessageId,
  });
  const savedExtraction = saveScenarioExtraction({
    rawMessageId: saveResult.rawMessageId,
    scenarioCode: extraction.scenarioCode,
    extractorCode: extraction.extractorCode,
    status: extraction.status,
    confidence: extraction.confidence,
    needsReview: extraction.needsReview,
    resultJson: {
      ...extraction.resultJson,
      reimbursementReportId: report.id,
    },
  });

  logger.info("Received reimbursement room message", {
    amount: report.amount,
    attachmentsCount: parsed.attachments.length,
    channelCode: parsed.channel.code,
    inserted: saveResult.inserted,
    rawMessageId: saveResult.rawMessageId,
    reimbursementReportId: report.id,
    roomTopic: parsed.roomTopic,
    scenarioStatus: savedExtraction.status,
    senderName: parsed.senderName,
    text: parsed.normalizedText,
    typeValue: parsed.typeValue,
  });

  await sendDebugNotification(message, context, logger, parsed.channel, [
    "[wechat-claw] 已收到群消息",
    `逻辑频道: ${parsed.channel.code}`,
    `场景: 报账`,
    `群聊: ${parsed.roomTopic}`,
    `发送人: ${parsed.senderName}`,
    `消息类型: ${parsed.messageType}`,
    `内容: ${parsed.normalizedText}`,
    `附件数: ${parsed.attachments.length}`,
    `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
    `报账处理: ${savedExtraction.status} / amount=${report.amount ?? "待复核"} / review=${savedExtraction.needsReview ? "是" : "否"}`,
  ]);
}

async function sendDebugNotification(
  message: any,
  context: MessageContext,
  logger: Logger,
  channel: ChannelConfig,
  lines: string[],
) {
  if (!context.debugContactName) {
    return;
  }

  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  if (!bot) {
    logger.warn("Wechaty instance unavailable for delivery target notification", {
      channelCode: channel.code,
    });
    return;
  }

  const deliveryResult = await sendTextToTarget(
    bot,
    {
      type: "contact_name",
      value: context.debugContactName,
    },
    [
      ...lines,
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

function shouldSkipTextOnlyMessage(input: {
  attachments: unknown[];
  channelCode?: string;
  channelName: string;
  eventReceivedAt: string;
  mergeWindowSeconds: number;
  normalizedText: string;
  senderExternalId?: string;
  senderName: string;
}) {
  if (input.attachments.length > 0 || input.normalizedText === "(非文本消息)") {
    return false;
  }

  if (input.mergeWindowSeconds <= 0) {
    return true;
  }

  const currentTime = new Date(input.eventReceivedAt).getTime();
  const sinceIso = new Date(currentTime - input.mergeWindowSeconds * 1000).toISOString();
  const hasRecentImageContext = hasRecentImageMessage({
    beforeIso: input.eventReceivedAt,
    channelCode: input.channelCode,
    channelName: input.channelName,
    senderExternalId: input.senderExternalId,
    senderName: input.senderName,
    sinceIso,
  });

  return !hasRecentImageContext;
}

function isTextOnlyMessage(input: ParsedRoomMessage) {
  return input.attachments.length === 0 && input.normalizedText !== "(非文本消息)";
}

function isTextOnlyUrlMessage(input: ParsedRoomMessage) {
  return isTextOnlyMessage(input) && containsUrl(input.normalizedText);
}

function containsUrl(text: string) {
  return /(https?:\/\/|www\.|[a-z0-9.-]+\.(?:com|cn|net|org|io|top|shop|xyz|me)(?:\/|\b))/i.test(text);
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
