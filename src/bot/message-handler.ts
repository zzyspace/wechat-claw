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
  attachRawMessageToRecentReimbursementReceiptDelivery,
  attachRemarkToReimbursementReport,
  deleteReimbursementReport,
  findForwardTextOnlyReimbursementReportMatch,
  findLatestReimbursementReportByReceiptText,
  findNextImageRawMessage,
  findRecentImageRawMessage,
  findRecentRemarkTextSource,
  findRecentTextOnlyReimbursementReport,
  findReimbursementReportByReceiptMessageExternalId,
  getReimbursementReportByRawMessageId,
  mergePrimaryImageIntoTextOnlyReimbursementReport,
  moveRemarkToReimbursementReport,
  saveReimbursementReceiptDelivery,
  saveReimbursementReport,
  updateReimbursementReportAmount,
} from "../scenarios/reimbursement/repository.js";
import { resolveMessageSentAt } from "./cold-start-filter.js";
import { countSuccessfulDeliveries, sendTextToTarget, sendTextToTargets } from "./delivery-contact.js";
const REIMBURSEMENT_RECEIPT_PENDING_TEXT = "此次报账待核验";
const REIMBURSEMENT_COMMAND_PROCESSED_TEXT = "已处理";
const REIMBURSEMENT_COMMAND_NOT_FOUND_TEXT = "未找到对应报账";
const REIMBURSEMENT_COMMAND_UNSUPPORTED_TEXT = "不支持的指令";
const REIMBURSEMENT_RECEIPT_COMMAND_EXTRACTOR_CODE = "receipt-command-v1";
const REIMBURSEMENT_RECEIPT_SELF_MATCH_WINDOW_SECONDS = 90;

export interface MessageContext {
  channels: ChannelConfig[];
  debugContactName?: string;
  timeZone?: string;
  lossMergeWindowSeconds: number;
  reimbursementBackwardTextMergeWindowSeconds: number;
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
  messageSentAt?: string;
  messageType: string;
  normalizedText: string;
  roomTopic: string;
  senderExternalId?: string;
  senderName: string;
  typeValue: unknown;
}

interface ParsedReimbursementReceiptReply {
  commandText: string;
  quotedMessageExternalId?: string;
  quotedText: string;
}

type ReimbursementReceiptCommand =
  | { kind: "delete" }
  | { amount: number; kind: "set_amount" };

export async function handleMessage(message: any, context: MessageContext, logger: Logger) {
  const room = typeof message.room === "function" ? await message.room() : null;
  const talker = typeof message.talker === "function" ? await message.talker() : null;
  const senderName = await resolveSenderName(room, talker);
  const text = typeof message.text === "function" ? message.text() : "";
  const typeValue = typeof message.type === "function" ? message.type() : "unknown";
  const normalizedText = normalizeMessageText(text, typeValue);
  const messageId = typeof message.id === "function" ? message.id() : message.id || cryptoRandomId();
  const dateValue = readMessageDate(message);
  const ageValue = readMessageAge(message);
  const resolvedSentAt = resolveMessageSentAt(message, new Date());
  const messageSentAt = resolvedSentAt?.toISOString();
  const eventReceivedAt = new Date().toISOString();
  const roomTopic = room && typeof room.topic === "function" ? await room.topic() : "";
  const channel = roomTopic
    ? (matchChannelByRoomTopic(context.channels, roomTopic) ?? undefined)
    : undefined;
  const senderExternalId = talker && typeof talker.id === "function" ? talker.id() : undefined;

  if (message.self && typeof message.self === "function" && message.self()) {
    await handleSelfMessage(
      message,
      {
        channel,
        channelExternalId: room && typeof room.id === "function" ? room.id() : undefined,
        eventReceivedAt,
        messageExternalId: String(messageId),
        messageSentAt,
        messageType: String(typeValue),
        normalizedText,
        roomTopic,
        senderExternalId,
        senderName,
        typeValue,
      },
      logger,
    );
    return;
  }

  if (!room || !channel) {
    return;
  }

  const attachments: StoredAttachment[] = [];

  if (channel.scenario === "reimbursement") {
    logger.info("Resolved reimbursement message time", {
      ageValue: ageValue ?? "(empty)",
      channelCode: channel.code,
      eventReceivedAt,
      messageDate: dateValue ?? "(empty)",
      messageExternalId: String(messageId),
      messageType: String(typeValue),
      messageSentAt: messageSentAt ?? "(empty)",
      roomTopic,
      senderName,
      text: normalizedText,
    });
  }

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

  const parsed: ParsedRoomMessage = {
    attachments,
    channel,
    channelExternalId: typeof room.id === "function" ? room.id() : undefined,
    eventReceivedAt,
    messageExternalId: String(messageId),
    messageType: String(typeValue),
    messageSentAt,
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

async function handleSelfMessage(
  message: any,
  parsed: {
    channel?: ChannelConfig;
    channelExternalId?: string;
    eventReceivedAt: string;
    messageExternalId: string;
    messageSentAt?: string;
    messageType: string;
    normalizedText: string;
    roomTopic: string;
    senderExternalId?: string;
    senderName: string;
    typeValue: unknown;
  },
  logger: Logger,
) {
  if (!parsed.roomTopic || !isReimbursementReceiptText(parsed.normalizedText)) {
    return;
  }

  const normalized = normalizeMessage({
    messageExternalId: parsed.messageExternalId,
    channelCode: parsed.channel?.code,
    channelExternalId: parsed.channelExternalId,
    channelName: parsed.roomTopic,
    senderExternalId: parsed.senderExternalId,
    senderName: parsed.senderName,
    messageType: parsed.messageType,
    textContent: parsed.normalizedText,
    messageSentAt: parsed.messageSentAt,
    eventReceivedAt: parsed.eventReceivedAt,
    attachments: [],
  });
  const saveResult = saveRawMessage(normalized);
  const receiptDelivery = attachRawMessageToRecentReimbursementReceiptDelivery({
    targetType: "room_topic",
    targetValue: parsed.roomTopic,
    receiptText: parsed.normalizedText,
    rawMessageId: saveResult.rawMessageId,
    sentAt: parsed.eventReceivedAt,
    matchWindowSeconds: REIMBURSEMENT_RECEIPT_SELF_MATCH_WINDOW_SECONDS,
  });

  logger.info("Processed self reimbursement receipt message", {
    channelCode: parsed.channel?.code,
    inserted: saveResult.inserted,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    receiptDeliveryId: receiptDelivery?.id,
    reimbursementReportId: receiptDelivery?.reimbursementReportId,
    roomTopic: parsed.roomTopic,
    text: parsed.normalizedText,
    typeValue: parsed.typeValue,
  });
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
    messageSentAt: parsed.messageSentAt,
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

  const receiptReply = await extractReimbursementReceiptReply(
    message,
    parsed.messageExternalId,
    parsed.normalizedText,
    logger,
  );

  if (receiptReply && isReimbursementReceiptText(receiptReply.quotedText)) {
    await handleReimbursementReceiptReplyCommand(message, parsed, context, logger, receiptReply);
    return;
  }

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
    messageSentAt: parsed.messageSentAt,
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
  let forwardTextUntilIso: string | undefined;
  let recentTextReport = null;
  let recentRemarkTextSource = null;

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
    forwardTextUntilIso = untilIso;
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
    const forwardTextMatch = findForwardTextOnlyReimbursementReportMatch({
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      currentRawMessageId: saveResult.rawMessageId,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      untilIso,
    });
    const preferredImageUntilIso = new Date(
      new Date(forwardTextMatch?.eventReceivedAt ?? parsed.eventReceivedAt).getTime() +
        context.reimbursementBackwardTextMergeWindowSeconds * 1000,
    ).toISOString();
    const competingImageRawMessage =
      forwardTextMatch && context.reimbursementBackwardTextMergeWindowSeconds > 0
        ? findNextImageRawMessage({
            afterIso: forwardTextMatch.eventReceivedAt,
            channelCode: parsed.channel.code,
            channelName: parsed.roomTopic,
            currentRawMessageId: forwardTextMatch.rawMessageId,
            senderExternalId: parsed.senderExternalId,
            senderName: parsed.senderName,
            untilIso: preferredImageUntilIso,
          })
        : null;

    forwardTextReport = competingImageRawMessage ? null : (forwardTextMatch?.report ?? null);

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
        competingImageRawMessageId: competingImageRawMessage?.rawMessageId,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    }

    if (!forwardTextReport) {
      const backwardMergeWindowSeconds = Math.min(
        context.lossMergeWindowSeconds,
        context.reimbursementBackwardTextMergeWindowSeconds,
      );

      if (backwardMergeWindowSeconds > 0) {
        const backwardSinceIso = new Date(currentTime - backwardMergeWindowSeconds * 1000).toISOString();
        const previousImageRawMessage = findRecentImageRawMessage({
          beforeIso: parsed.eventReceivedAt,
          channelCode: parsed.channel.code,
          channelName: parsed.roomTopic,
          currentRawMessageId: saveResult.rawMessageId,
          senderExternalId: parsed.senderExternalId,
          senderName: parsed.senderName,
          sinceIso: backwardSinceIso,
        });
        const sinceIso = previousImageRawMessage?.eventReceivedAt ?? backwardSinceIso;

        logger.info("Checking recent reimbursement text context for image merge", {
          channelCode: parsed.channel.code,
          currentRawMessageId: saveResult.rawMessageId,
          messageExternalId: parsed.messageExternalId,
          previousImageRawMessageId: previousImageRawMessage?.rawMessageId,
          roomTopic: parsed.roomTopic,
          senderName: parsed.senderName,
          sinceIso,
          untilIso: parsed.eventReceivedAt,
        });
        recentTextReport = findRecentTextOnlyReimbursementReport({
          beforeIso: parsed.eventReceivedAt,
          channelCode: parsed.channel.code,
          channelName: parsed.roomTopic,
          currentRawMessageId: saveResult.rawMessageId,
          senderExternalId: parsed.senderExternalId,
          senderName: parsed.senderName,
          sinceIso,
          sinceRawMessageId: previousImageRawMessage?.rawMessageId,
        });

        if (recentTextReport) {
          logger.info("Matched recent reimbursement text context for image merge", {
            channelCode: parsed.channel.code,
            matchedReportId: recentTextReport.id,
            messageExternalId: parsed.messageExternalId,
            rawMessageId: saveResult.rawMessageId,
            roomTopic: parsed.roomTopic,
            senderName: parsed.senderName,
          });
        } else {
          logger.info("No recent reimbursement text context matched for image merge", {
            channelCode: parsed.channel.code,
            messageExternalId: parsed.messageExternalId,
            rawMessageId: saveResult.rawMessageId,
            roomTopic: parsed.roomTopic,
            senderName: parsed.senderName,
          });

          recentRemarkTextSource = findRecentRemarkTextSource({
            beforeIso: parsed.eventReceivedAt,
            channelCode: parsed.channel.code,
            channelName: parsed.roomTopic,
            currentRawMessageId: saveResult.rawMessageId,
            senderExternalId: parsed.senderExternalId,
            senderName: parsed.senderName,
            sinceIso,
            sinceRawMessageId: previousImageRawMessage?.rawMessageId,
          });

          if (recentRemarkTextSource) {
            logger.info("Matched recent reimbursement remark context for image merge", {
              channelCode: parsed.channel.code,
              matchedReportId: recentRemarkTextSource.reimbursementReportId,
              messageExternalId: parsed.messageExternalId,
              rawMessageId: saveResult.rawMessageId,
              recentRemarkRawMessageId: recentRemarkTextSource.rawMessageId,
              roomTopic: parsed.roomTopic,
              senderName: parsed.senderName,
            });
          } else {
            logger.info("No recent reimbursement remark context matched for image merge", {
              channelCode: parsed.channel.code,
              messageExternalId: parsed.messageExternalId,
              rawMessageId: saveResult.rawMessageId,
              roomTopic: parsed.roomTopic,
              senderName: parsed.senderName,
            });
          }
        }
      }
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
          timeZone: context.timeZone ?? "Asia/Shanghai",
          referenceDateTime: parsed.eventReceivedAt,
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

  if (
    parsed.attachments.length > 0 &&
    context.lossMergeWindowSeconds > 0 &&
    !forwardTextReport &&
    forwardTextUntilIso
  ) {
    logger.info("Rechecking forward reimbursement text context after extraction", {
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      messageExternalId: parsed.messageExternalId,
      rawMessageId: saveResult.rawMessageId,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      untilIso: forwardTextUntilIso,
    });
    const forwardTextMatch = findForwardTextOnlyReimbursementReportMatch({
      afterIso: parsed.eventReceivedAt,
      channelCode: parsed.channel.code,
      channelName: parsed.roomTopic,
      currentRawMessageId: saveResult.rawMessageId,
      senderExternalId: parsed.senderExternalId,
      senderName: parsed.senderName,
      untilIso: forwardTextUntilIso,
    });
    const preferredImageUntilIso = new Date(
      new Date(forwardTextMatch?.eventReceivedAt ?? parsed.eventReceivedAt).getTime() +
        context.reimbursementBackwardTextMergeWindowSeconds * 1000,
    ).toISOString();
    const competingImageRawMessage =
      forwardTextMatch && context.reimbursementBackwardTextMergeWindowSeconds > 0
        ? findNextImageRawMessage({
            afterIso: forwardTextMatch.eventReceivedAt,
            channelCode: parsed.channel.code,
            channelName: parsed.roomTopic,
            currentRawMessageId: forwardTextMatch.rawMessageId,
            senderExternalId: parsed.senderExternalId,
            senderName: parsed.senderName,
            untilIso: preferredImageUntilIso,
          })
        : null;
    forwardTextReport = competingImageRawMessage ? null : (forwardTextMatch?.report ?? null);

    if (forwardTextReport) {
      logger.info("Matched forward reimbursement text context after extraction", {
        channelCode: parsed.channel.code,
        matchedReportId: forwardTextReport.id,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    } else {
      logger.info("No forward reimbursement text context matched after extraction", {
        channelCode: parsed.channel.code,
        competingImageRawMessageId: competingImageRawMessage?.rawMessageId,
        messageExternalId: parsed.messageExternalId,
        rawMessageId: saveResult.rawMessageId,
        roomTopic: parsed.roomTopic,
        senderName: parsed.senderName,
      });
    }
  }

  logger.info("Persisting reimbursement report", {
    amount: extraction.resultJson.amount,
    channelCode: parsed.channel.code,
    evidenceType: extraction.resultJson.evidenceType,
    expenseCategory: extraction.resultJson.expenseCategory,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    senderName: parsed.senderName,
  });
  const mergeTargetReport = forwardTextReport ?? recentTextReport;
  let report = mergeTargetReport
    ? mergePrimaryImageIntoTextOnlyReimbursementReport({
        reimbursementReportId: mergeTargetReport.id,
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
        timeZone: context.timeZone ?? "Asia/Shanghai",
        referenceDateTime: parsed.eventReceivedAt,
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
        timeZone: context.timeZone ?? "Asia/Shanghai",
        referenceDateTime: parsed.eventReceivedAt,
      });

  if (recentRemarkTextSource && !mergeTargetReport) {
    const reassignment = moveRemarkToReimbursementReport({
      targetReimbursementReportId: report.id,
      rawMessageId: recentRemarkTextSource.rawMessageId,
      timeZone: context.timeZone ?? "Asia/Shanghai",
      referenceDateTime: parsed.eventReceivedAt,
    });
    report = reassignment.targetReport;
    saveScenarioExtraction({
      rawMessageId: recentRemarkTextSource.rawMessageId,
      scenarioCode: "reimbursement",
      extractorCode: "remark-link-v1",
      status: "extracted",
      confidence: report.confidence,
      needsReview: report.needsReview,
      resultJson: {
        eventType: "reimbursement_report_remark",
        rawMessageId: recentRemarkTextSource.rawMessageId,
        reimbursementReportId: report.id,
        note: recentRemarkTextSource.textContent,
      },
    });
    logger.info("Reassigned reimbursement remark context to newer image report", {
      channelCode: parsed.channel.code,
      messageExternalId: parsed.messageExternalId,
      rawMessageId: saveResult.rawMessageId,
      recentRemarkRawMessageId: recentRemarkTextSource.rawMessageId,
      reimbursementReportId: report.id,
      senderName: parsed.senderName,
      sourceReimbursementReportId: reassignment.sourceReport.id,
    });
  }
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
    mergedFromRecentTextReport: Boolean(recentTextReport),
    mergedFromRecentRemarkTextSource: Boolean(recentRemarkTextSource),
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

  if (parsed.attachments.length > 0 && saveResult.inserted) {
    await sendReimbursementReceiptNotification(message, logger, parsed.channel, report);
  }

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

async function handleReimbursementReceiptReplyCommand(
  message: any,
  parsed: ParsedRoomMessage,
  context: MessageContext,
  logger: Logger,
  receiptReply: ParsedReimbursementReceiptReply,
) {
  const normalized = normalizeMessage({
    messageExternalId: parsed.messageExternalId,
    channelCode: parsed.channel.code,
    channelExternalId: parsed.channelExternalId,
    channelName: parsed.roomTopic,
    senderExternalId: parsed.senderExternalId,
    senderName: parsed.senderName,
    messageType: parsed.messageType,
    textContent: receiptReply.commandText,
    messageSentAt: parsed.messageSentAt,
    eventReceivedAt: parsed.eventReceivedAt,
    attachments: parsed.attachments,
  });
  const saveResult = saveRawMessage(normalized);
  const command = parseReimbursementReceiptCommand(receiptReply.commandText);
  const matchedReport =
    (receiptReply.quotedMessageExternalId
      ? findReimbursementReportByReceiptMessageExternalId(receiptReply.quotedMessageExternalId)
      : null) ??
    findLatestReimbursementReportByReceiptText({
      targetType: "room_topic",
      targetValue: parsed.roomTopic,
      receiptText: receiptReply.quotedText,
      beforeIso: parsed.eventReceivedAt,
      reporter: parsed.senderName,
    }) ??
    findLatestReimbursementReportByReceiptText({
      targetType: "room_topic",
      targetValue: parsed.roomTopic,
      receiptText: receiptReply.quotedText,
      beforeIso: parsed.eventReceivedAt,
    });

  logger.info("Persisted reimbursement receipt command raw message", {
    channelCode: parsed.channel.code,
    commandText: receiptReply.commandText,
    inserted: saveResult.inserted,
    matchedReportId: matchedReport?.id,
    messageExternalId: parsed.messageExternalId,
    quotedMessageExternalId: receiptReply.quotedMessageExternalId,
    quotedText: receiptReply.quotedText,
    rawMessageId: saveResult.rawMessageId,
    roomTopic: parsed.roomTopic,
    senderName: parsed.senderName,
  });

  if (!command) {
    const savedExtraction = saveScenarioExtraction({
      rawMessageId: saveResult.rawMessageId,
      scenarioCode: "reimbursement",
      extractorCode: REIMBURSEMENT_RECEIPT_COMMAND_EXTRACTOR_CODE,
      status: "ignored",
      confidence: 1,
      needsReview: false,
      resultJson: {
        commandText: receiptReply.commandText,
        eventType: "reimbursement_receipt_command",
        quotedMessageExternalId: receiptReply.quotedMessageExternalId ?? null,
        quotedText: receiptReply.quotedText,
        status: "unsupported_command",
      },
    });

    logger.info("Ignored unsupported reimbursement receipt command", {
      channelCode: parsed.channel.code,
      extractionId: savedExtraction.id,
      messageExternalId: parsed.messageExternalId,
      rawMessageId: saveResult.rawMessageId,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      text: receiptReply.commandText,
    });

    await sendReimbursementCommandResponse(
      message,
      logger,
      parsed.channel,
      parsed.roomTopic,
      REIMBURSEMENT_COMMAND_UNSUPPORTED_TEXT,
    );

    await sendDebugNotification(message, context, logger, parsed.channel, [
      "[wechat-claw] 已收到群消息",
      `逻辑频道: ${parsed.channel.code}`,
      `场景: 报账`,
      `群聊: ${parsed.roomTopic}`,
      `发送人: ${parsed.senderName}`,
      `消息类型: ${parsed.messageType}`,
      `内容: ${receiptReply.commandText}`,
      `附件数: ${parsed.attachments.length}`,
      `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
      `报账指令: ignored / unsupported / quote=${receiptReply.quotedText}`,
    ]);
    return;
  }

  if (!matchedReport) {
    const savedExtraction = saveScenarioExtraction({
      rawMessageId: saveResult.rawMessageId,
      scenarioCode: "reimbursement",
      extractorCode: REIMBURSEMENT_RECEIPT_COMMAND_EXTRACTOR_CODE,
      status: "ignored",
      confidence: 1,
      needsReview: false,
      resultJson: {
        command: command.kind,
        commandText: receiptReply.commandText,
        eventType: "reimbursement_receipt_command",
        quotedMessageExternalId: receiptReply.quotedMessageExternalId ?? null,
        quotedText: receiptReply.quotedText,
        status: "receipt_not_found",
      },
    });

    logger.warn("Failed to match reimbursement receipt command to a report", {
      channelCode: parsed.channel.code,
      commandKind: command.kind,
      extractionId: savedExtraction.id,
      messageExternalId: parsed.messageExternalId,
      rawMessageId: saveResult.rawMessageId,
      roomTopic: parsed.roomTopic,
      senderName: parsed.senderName,
      text: receiptReply.commandText,
    });

    await sendReimbursementCommandResponse(
      message,
      logger,
      parsed.channel,
      parsed.roomTopic,
      REIMBURSEMENT_COMMAND_NOT_FOUND_TEXT,
    );

    await sendDebugNotification(message, context, logger, parsed.channel, [
      "[wechat-claw] 已收到群消息",
      `逻辑频道: ${parsed.channel.code}`,
      `场景: 报账`,
      `群聊: ${parsed.roomTopic}`,
      `发送人: ${parsed.senderName}`,
      `消息类型: ${parsed.messageType}`,
      `内容: ${receiptReply.commandText}`,
      `附件数: ${parsed.attachments.length}`,
      `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
      `报账指令: ignored / receipt_not_found / quote=${receiptReply.quotedText}`,
    ]);
    return;
  }

  if (command.kind === "delete") {
    deleteReimbursementReport(matchedReport.id);
  } else {
    updateReimbursementReportAmount({
      reimbursementReportId: matchedReport.id,
      amount: command.amount,
    });
  }

  const savedExtraction = saveScenarioExtraction({
    rawMessageId: saveResult.rawMessageId,
    scenarioCode: "reimbursement",
    extractorCode: REIMBURSEMENT_RECEIPT_COMMAND_EXTRACTOR_CODE,
    status: "extracted",
    confidence: 1,
    needsReview: false,
    resultJson: {
      amount: command.kind === "set_amount" ? command.amount : null,
      command: command.kind,
      commandText: receiptReply.commandText,
      eventType: "reimbursement_receipt_command",
      quotedMessageExternalId: receiptReply.quotedMessageExternalId ?? null,
      quotedText: receiptReply.quotedText,
      reimbursementReportId: matchedReport.id,
    },
  });

  logger.info("Executed reimbursement receipt command", {
    channelCode: parsed.channel.code,
    commandKind: command.kind,
    extractionId: savedExtraction.id,
    matchedReportId: matchedReport.id,
    messageExternalId: parsed.messageExternalId,
    rawMessageId: saveResult.rawMessageId,
    roomTopic: parsed.roomTopic,
    senderName: parsed.senderName,
  });

  await sendReimbursementCommandResponse(
    message,
    logger,
    parsed.channel,
    parsed.roomTopic,
    REIMBURSEMENT_COMMAND_PROCESSED_TEXT,
  );

  await sendDebugNotification(message, context, logger, parsed.channel, [
    "[wechat-claw] 已收到群消息",
    `逻辑频道: ${parsed.channel.code}`,
    `场景: 报账`,
    `群聊: ${parsed.roomTopic}`,
    `发送人: ${parsed.senderName}`,
    `消息类型: ${parsed.messageType}`,
    `内容: ${receiptReply.commandText}`,
    `附件数: ${parsed.attachments.length}`,
    `入库: ${saveResult.inserted ? "新消息" : "已去重"}`,
    `报账指令: ${command.kind} / report=${matchedReport.id}${command.kind === "set_amount" ? ` / amount=${command.amount}` : ""}`,
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

async function sendReimbursementReceiptNotification(
  message: any,
  logger: Logger,
  channel: ChannelConfig,
  report: { amount: number | null; channelCode?: string; id: number },
) {
  if (channel.deliveryTargets.length === 0) {
    logger.info("Skipped reimbursement receipt notification", {
      channelCode: channel.code,
      reason: "no_delivery_targets",
    });
    return;
  }

  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  if (!bot) {
    logger.warn("Wechaty instance unavailable for reimbursement receipt notification", {
      channelCode: channel.code,
    });
    return;
  }

  const receiptText = buildReimbursementReceiptText(report.amount);
  const deliveryResults = await sendTextToTargets(
    bot,
    channel.deliveryTargets,
    receiptText,
    logger,
  );
  const deliveredTargets = countSuccessfulDeliveries(deliveryResults);

  if (deliveredTargets === 0) {
    logger.warn("Failed to deliver reimbursement receipt to any target", {
      channelCode: channel.code,
      receiptText,
      totalTargets: deliveryResults.length,
    });
    return;
  }

  const sentAt = new Date().toISOString();
  for (const deliveryResult of deliveryResults) {
    if (!deliveryResult.delivered) {
      continue;
    }

    saveReimbursementReceiptDelivery({
      reimbursementReportId: report.id,
      channelCode: report.channelCode ?? channel.code,
      targetType: deliveryResult.target.type,
      targetValue: deliveryResult.target.value,
      receiptText,
      sentAt,
    });
  }

  logger.info("Sent reimbursement receipt notifications", {
    channelCode: channel.code,
    deliveredTargets,
    receiptText,
    totalTargets: deliveryResults.length,
  });
}

async function sendReimbursementCommandResponse(
  message: any,
  logger: Logger,
  channel: ChannelConfig,
  roomTopic: string,
  text: string,
) {
  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  if (!bot) {
    logger.warn("Wechaty instance unavailable for reimbursement command response", {
      channelCode: channel.code,
      roomTopic,
      text,
    });
    return;
  }

  const deliveryResult = await sendTextToTarget(
    bot,
    {
      type: "room_topic",
      value: roomTopic,
    },
    text,
    logger,
  );

  logger.info("Sent reimbursement command response", {
    channelCode: channel.code,
    delivered: deliveryResult.delivered,
    roomTopic,
    text,
  });
}

async function extractReimbursementReceiptReply(
  message: any,
  messageExternalId: string,
  normalizedText: string,
  logger: Logger,
): Promise<ParsedReimbursementReceiptReply | null> {
  const rawPayload = await readMessageRawPayload(message, messageExternalId, logger);
  const fromRawPayload = parseReimbursementReceiptReplyFromRawPayload(rawPayload);

  if (fromRawPayload) {
    return fromRawPayload;
  }

  return parseReimbursementReceiptReplyFromText(normalizedText);
}

async function readMessageRawPayload(message: any, messageExternalId: string, logger: Logger) {
  const bot = typeof message.wechaty === "function" ? message.wechaty() : message.wechaty;
  const puppet = bot?.puppet;

  if (!puppet || typeof puppet.messageRawPayload !== "function") {
    return null;
  }

  try {
    return await puppet.messageRawPayload(messageExternalId);
  } catch (error) {
    logger.warn("Failed to read raw payload for reimbursement message", {
      message: error instanceof Error ? error.message : String(error),
      messageExternalId,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

function parseReimbursementReceiptReplyFromRawPayload(
  rawPayload: Record<string, unknown> | null,
): ParsedReimbursementReceiptReply | null {
  if (!rawPayload) {
    return null;
  }

  if (Number(rawPayload.MsgType) !== 49 || Number(rawPayload.AppMsgType) !== 57) {
    return null;
  }

  const xml = typeof rawPayload.Content === "string" ? rawPayload.Content : "";
  if (!xml) {
    return null;
  }

  const commandText = extractXmlTagValue(xml, "title");
  const referXml = extractXmlTagValue(xml, "refermsg", {
    decodeEntities: false,
  });
  const quotedText = referXml ? extractXmlTagValue(referXml, "content") : null;
  const quotedMessageExternalId = referXml ? extractXmlTagValue(referXml, "svrid") : null;

  if (!commandText || !quotedText) {
    return null;
  }

  return {
    commandText: sanitizeReplyText(commandText),
    quotedMessageExternalId: quotedMessageExternalId?.trim() || undefined,
    quotedText: sanitizeReplyText(quotedText),
  };
}

function parseReimbursementReceiptReplyFromText(text: string): ParsedReimbursementReceiptReply | null {
  const normalized = normalizeReplyStructureText(text);
  const divider = "\n- - - - - - - - - - - - - - -\n";
  const dividerIndex = normalized.indexOf(divider);

  if (dividerIndex < 0) {
    return null;
  }

  const quotedPart = normalized.slice(0, dividerIndex).trim();
  const commandText = normalized.slice(dividerIndex + divider.length).trim();
  const quotedText = extractQuotedReplyText(quotedPart);

  if (!quotedText || !commandText) {
    return null;
  }

  return {
    commandText: sanitizeReplyText(commandText),
    quotedText: sanitizeReplyText(quotedText),
  };
}

function extractQuotedReplyText(quotedPart: string) {
  if (!quotedPart.startsWith("「") || !quotedPart.endsWith("」")) {
    return null;
  }

  const inner = quotedPart.slice(1, -1);
  const colonIndex = inner.indexOf("：");
  const asciiColonIndex = inner.indexOf(":");
  const splitIndex =
    colonIndex >= 0 && asciiColonIndex >= 0
      ? Math.min(colonIndex, asciiColonIndex)
      : Math.max(colonIndex, asciiColonIndex);

  if (splitIndex < 0) {
    return inner.trim();
  }

  return inner.slice(splitIndex + 1).trim();
}

function extractXmlTagValue(
  xml: string,
  tagName: string,
  options?: {
    decodeEntities?: boolean;
  },
) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i"));

  if (!match?.[1]) {
    return null;
  }

  const rawValue = unwrapCdata(match[1].trim());
  return options?.decodeEntities === false ? rawValue : decodeXmlEntities(rawValue);
}

function unwrapCdata(value: string) {
  const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return match?.[1] ?? value;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sanitizeReplyText(text: string) {
  return decodeXmlEntities(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function normalizeReplyStructureText(text: string) {
  return decodeXmlEntities(text)
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

function parseReimbursementReceiptCommand(text: string): ReimbursementReceiptCommand | null {
  const normalized = text.trim();

  if (normalized.toLowerCase() === "delete") {
    return { kind: "delete" };
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return {
      amount: Number(normalized),
      kind: "set_amount",
    };
  }

  return null;
}

function cryptoRandomId() {
  return `generated_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildReimbursementReceiptText(amount: number | null) {
  if (amount === null) {
    return REIMBURSEMENT_RECEIPT_PENDING_TEXT;
  }

  return `报账${formatReimbursementReceiptAmount(amount)}元已录入`;
}

function isReimbursementReceiptText(text: string) {
  return text === REIMBURSEMENT_RECEIPT_PENDING_TEXT || /^报账\d+(?:\.\d+)?元已录入$/.test(text);
}

function formatReimbursementReceiptAmount(amount: number) {
  return amount.toFixed(2).replace(/\.?0+$/, "");
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

function readMessageDate(message: any) {
  if (!message || typeof message.date !== "function") {
    return undefined;
  }

  try {
    const value = message.date();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

function readMessageAge(message: any) {
  if (!message || typeof message.age !== "function") {
    return undefined;
  }

  try {
    const value = message.age();
    return Number.isFinite(Number(value)) ? Number(value) : String(value);
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
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
