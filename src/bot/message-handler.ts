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
  findForwardTextOnlyReimbursementReport,
  findNextImageRawMessage,
  findRecentImageRawMessage,
  getReimbursementReportByRawMessageId,
  mergePrimaryImageIntoTextOnlyReimbursementReport,
  saveReimbursementReport,
} from "../scenarios/reimbursement/repository.js";
import { resolveMessageSentAt } from "./cold-start-filter.js";
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
  const eventReceivedAt = resolveMessageEventTime(message);
  const attachments: StoredAttachment[] = [];

  if (isImageLikeMessage(typeValue, normalizedText)) {
    if (channel.scenario === "reimbursement") {
      logger.info("Detected reimbursement image-like message", {
        channelCode: channel.code,
        messageExternalId: String(messageId),
        roomTopic,
        senderName,
        text: normalizedText,
        typeValue,
      });
    }

    const imageAttachment = await saveImageAttachment(message, {
      rawStorageDir: channel.scenario === "reimbursement" ? getReimbursementRawStorageDir() : undefined,
    });

    if (imageAttachment) {
      attachments.push(imageAttachment);

      if (channel.scenario === "reimbursement") {
        logger.info("Saved reimbursement image attachment", {
          channelCode: channel.code,
          localPath: imageAttachment.localPath,
          messageExternalId: String(messageId),
          mimeType: imageAttachment.mimeType ?? "(empty)",
          roomTopic,
          senderName,
          sha256: imageAttachment.sha256,
        });
      }
    } else if (channel.scenario === "reimbursement") {
      logger.warn("Failed to save reimbursement image attachment", {
        channelCode: channel.code,
        messageExternalId: String(messageId),
        roomTopic,
        senderName,
        typeValue,
      });
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
  logger.info("Started reimbursement message processing", {
    attachmentCount: parsed.attachments.length,
    channelCode: parsed.channel.code,
    messageExternalId: parsed.messageExternalId,
    messageType: parsed.messageType,
    roomTopic: parsed.roomTopic,
    senderName: parsed.senderName,
    text: parsed.normalizedText,
    typeValue: parsed.typeValue,
  });

  if (isTextOnlyUrlMessage(parsed)) {
    logger.info("Skipped reimbursement text-only URL message", {
      channelCode: parsed.channel.code,
      messageExternalId: parsed.messageExternalId,
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
  logger.info("Persisted reimbursement raw message", {
    attachmentCount: parsed.attachments.length,
    channelCode: parsed.channel.code,
    inserted: saveResult.inserted,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    roomTopic: parsed.roomTopic,
    senderName: parsed.senderName,
  });

  let forwardTextReport = null;

  if (parsed.attachments.length > 0 && context.lossMergeWindowSeconds > 0) {
    const currentTime = new Date(parsed.eventReceivedAt).getTime();
    const maxUntilIso = new Date(currentTime + context.lossMergeWindowSeconds * 1000).toISOString();
    const nextImageRawMessage = findNextImageRawMessage({
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      currentRawMessageId: saveResult.rawMessageId,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      untilIso: maxUntilIso,
    });
    const untilIso = nextImageRawMessage?.eventReceivedAt ?? maxUntilIso;
    logger.info("Checking forward reimbursement text context for image merge", {
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      messageExternalId: parsed.messageExternalId,
      nextImageRawMessageId: nextImageRawMessage?.rawMessageId,
      rawMessageId: saveResult.rawMessageId,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      untilIso,
    });
    forwardTextReport = findForwardTextOnlyReimbursementReport({
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      currentRawMessageId: saveResult.rawMessageId,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      untilIso,
    });

    if (forwardTextReport) {
      logger.info("Matched forward reimbursement text context for image merge", {
        channelCode: parsed.channel.code,
        matchedReportId: forwardTextReport.id,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    } else {
      logger.info("No forward reimbursement text context matched for image merge", {
        channelCode: parsed.channel.code,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    }
  }

  if (isTextOnlyMessage(parsed) && context.lossMergeWindowSeconds > 0) {
    const currentTime = new Date(parsed.eventReceivedAt).getTime();
    const sinceIso = new Date(currentTime - context.lossMergeWindowSeconds * 1000).toISOString();
    logger.info("Checking recent reimbursement image raw context for remark merge", {
      channelCode: parsed.channel.code,
      messageExternalId: parsed.messageExternalId,
      rawMessageId: saveResult.rawMessageId,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      sinceIso,
      text: parsed.normalizedText,
    });
    const recentImageRawMessage = findRecentImageRawMessage({
      beforeIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      currentRawMessageId: saveResult.rawMessageId,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      sinceIso,
    });

    if (recentImageRawMessage) {
      const recentImageReport = getReimbursementReportByRawMessageId(recentImageRawMessage.rawMessageId);

      if (!recentImageReport) {
        logger.info("Recent reimbursement image raw message has no persisted report yet", {
          channelCode: parsed.channel.code,
          imageRawMessageId: recentImageRawMessage.rawMessageId,
          messageExternalId: parsed.messageExternalId,
          rawMessageId: saveResult.rawMessageId,
          roomTopic: parsed.roomTopic,
          senderName: parsed.senderName,
        });
      } else {
        logger.info("Matched reimbursement image context for remark merge", {
          channelCode: parsed.channel.code,
          imageRawMessageId: recentImageRawMessage.rawMessageId,
          matchedReportId: recentImageReport.id,
          messageExternalId: parsed.messageExternalId,
          rawMessageId: saveResult.rawMessageId,
          roomTopic: parsed.roomTopic,
          senderName: parsed.senderName,
        });
        const updatedReport = attachRemarkToReimbursementReport({
          reimbursementReportId: recentImageReport.id,
          rawMessageId: saveResult.rawMessageId,
          note: parsed.normalizedText,
        });
        logger.info("Updated reimbursement report with merged remark", {
          amount: updatedReport.amount,
          channelCode: parsed.channel.code,
          evidenceType: updatedReport.evidenceType,
          messageExternalId: parsed.messageExternalId,
          note: updatedReport.note,
          rawMessageId: saveResult.rawMessageId,
          reimbursementReportId: updatedReport.id,
          senderName: parsed.senderName,
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
        logger.info("Persisted reimbursement remark linkage extraction", {
          channelCode: parsed.channel.code,
          extractionId: savedExtraction.id,
          extractorCode: savedExtraction.extractorCode,
          messageExternalId: parsed.messageExternalId,
          rawMessageId: saveResult.rawMessageId,
          reimbursementReportId: updatedReport.id,
          scenarioStatus: savedExtraction.status,
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
    } else {
      logger.info("No reimbursement image raw context matched for remark merge", {
        channelCode: parsed.channel.code,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    }
  }

  logger.info("Starting reimbursement extraction", {
    attachmentCount: parsed.attachments.length,
    channelCode: parsed.channel.code,
    hasApiKey: Boolean(context.reimbursementExtractionApiKey),
    messageExternalId: parsed.messageExternalId,
    model: context.reimbursementExtractionModel ?? "(empty)",
    provider: context.reimbursementExtractionProvider ?? "(empty)",
    rawMessageId: saveResult.rawMessageId,
    roomTopic: parsed.roomTopic,
    senderName: parsed.senderName,
  });
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
    logger,
  );
  logger.info("Completed reimbursement extraction", {
    amount: extraction.resultJson.amount,
    channelCode: parsed.channel.code,
    confidence: extraction.confidence,
    evidenceType: extraction.resultJson.evidenceType,
    expenseCategory: extraction.resultJson.expenseCategory,
    extractorCode: extraction.extractorCode,
    messageExternalId: parsed.messageExternalId,
    needsReview: extraction.needsReview,
    rawMessageId: saveResult.rawMessageId,
    senderName: parsed.senderName,
    voucherDate: extraction.resultJson.voucherDate,
    voucherDateSource: extraction.resultJson.voucherDateSource,
  });
  logger.info("Persisting reimbursement report", {
    amount: extraction.resultJson.amount,
    channelCode: parsed.channel.code,
    evidenceType: extraction.resultJson.evidenceType,
    expenseCategory: extraction.resultJson.expenseCategory,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    senderName: parsed.senderName,
  });
  const report = forwardTextReport
    ? mergePrimaryImageIntoTextOnlyReimbursementReport({
        reimbursementReportId: forwardTextReport.id,
        imageRawMessageId: saveResult.rawMessageId,
        amount: extraction.resultJson.amount,
        currency: extraction.resultJson.currency,
        expenseCategory: extraction.resultJson.expenseCategory,
        voucherDate: extraction.resultJson.voucherDate,
        voucherDateSource: extraction.resultJson.voucherDateSource,
        note: extraction.resultJson.note,
        merchant: extraction.resultJson.merchant,
        documentNo: extraction.resultJson.documentNo,
        voucherType: extraction.resultJson.voucherType,
        ocrText: extraction.resultJson.ocrText,
        confidence: extraction.confidence,
        needsReview: extraction.needsReview,
      })
    : saveReimbursementReport({
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
  logger.info("Persisted reimbursement report", {
    amount: report.amount,
    channelCode: parsed.channel.code,
    confidence: report.confidence,
    evidenceType: report.evidenceType,
    messageExternalId: parsed.messageExternalId,
    needsReview: report.needsReview,
    rawMessageId: saveResult.rawMessageId,
    reimbursementReportId: report.id,
    senderName: parsed.senderName,
    mergedFromForwardTextReport: Boolean(forwardTextReport),
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
  logger.info("Persisted reimbursement scenario extraction", {
    channelCode: parsed.channel.code,
    extractionId: savedExtraction.id,
    extractorCode: savedExtraction.extractorCode,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    reimbursementReportId: report.id,
    scenarioStatus: savedExtraction.status,
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

function resolveMessageEventTime(message: any) {
  const now = new Date();
  return resolveMessageSentAt(message, now)?.toISOString() ?? now.toISOString();
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
