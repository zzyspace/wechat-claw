import crypto from "node:crypto";

import { normalizeMessage } from "../../core/messages/normalize-message.js";
import { saveScenarioExtraction, type ScenarioExtractionRecord } from "../../core/scenarios/scenario-extraction-repository.js";
import { saveRawMessage } from "../../core/storage/raw-message-repository.js";
import type { StoredAttachment } from "../../core/storage/types.js";
import {
  extractReimbursementReport,
  type ReimbursementModelProviderConfig,
} from "./extractor.js";
import { saveReimbursementReport } from "./repository.js";
import type {
  ReimbursementExtractionResult,
  ReimbursementReportRecord,
} from "./types.js";

const BATCH_IMPORT_MESSAGE_TYPE = "batch_import";
const BATCH_IMPORT_FALLBACK_TEXT = "(非文本消息)";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export interface BatchReimbursementImportInput {
  attachments: StoredAttachment[];
  channelCode: string;
  channelName: string;
  modelConfig: ReimbursementModelProviderConfig;
  note?: string;
  reporter: string;
  sentAt: string;
  timeZone?: string;
}

export interface BatchReimbursementImportItemResult {
  attachment: StoredAttachment;
  extraction: ScenarioExtractionRecord;
  rawMessageId: number;
  report: ReimbursementReportRecord;
}

type ReimbursementExtractor = typeof extractReimbursementReport;

function buildBatchImportExternalId(input: {
  channelCode: string;
  index: number;
  reporter: string;
  sentAt: string;
}) {
  const reporterSlug = input.reporter.trim().replace(/\s+/g, "_").slice(0, 48) || "unknown";
  return `batch-reimbursement:${input.channelCode}:${reporterSlug}:${input.sentAt}:${input.index}:${crypto.randomUUID()}`;
}

export async function importBatchReimbursementReports(
  input: BatchReimbursementImportInput,
  extractor: ReimbursementExtractor = extractReimbursementReport,
): Promise<BatchReimbursementImportItemResult[]> {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const note = input.note?.trim() ?? "";
  const textContent = note || BATCH_IMPORT_FALLBACK_TEXT;
  const results: BatchReimbursementImportItemResult[] = [];

  for (const [index, attachment] of input.attachments.entries()) {
    const normalizedMessage = normalizeMessage({
      messageExternalId: buildBatchImportExternalId({
        channelCode: input.channelCode,
        reporter: input.reporter,
        sentAt: input.sentAt,
        index,
      }),
      channelCode: input.channelCode,
      channelName: input.channelName,
      senderName: input.reporter,
      messageType: BATCH_IMPORT_MESSAGE_TYPE,
      textContent,
      messageSentAt: input.sentAt,
      eventReceivedAt: input.sentAt,
      attachments: [attachment],
    });
    const saveResult = saveRawMessage(normalizedMessage);
    const modelExtraction = await extractor(
      {
        rawMessageId: saveResult.rawMessageId,
        channelCode: input.channelCode,
        channelName: input.channelName,
        reporter: input.reporter,
        textContent,
        sentAt: input.sentAt,
        timeZone,
        attachments: [attachment],
      },
      input.modelConfig,
    );
    const resultJson: ReimbursementExtractionResult["resultJson"] = {
      ...modelExtraction.resultJson,
      note,
    };
    const report = saveReimbursementReport({
      channelCode: input.channelCode,
      channelName: input.channelName,
      reporter: input.reporter,
      amount: resultJson.amount,
      currency: resultJson.currency,
      expenseCategory: resultJson.expenseCategory,
      voucherDate: resultJson.voucherDate,
      voucherDateSource: resultJson.voucherDateSource,
      note: resultJson.note,
      evidenceType: resultJson.evidenceType,
      merchant: resultJson.merchant,
      documentNo: resultJson.documentNo,
      voucherType: resultJson.voucherType,
      ocrText: resultJson.ocrText,
      confidence: modelExtraction.confidence,
      needsReview: modelExtraction.needsReview,
      primaryRawMessageId: saveResult.rawMessageId,
      timeZone,
      referenceDateTime: input.sentAt,
    });
    const extraction = saveScenarioExtraction({
      rawMessageId: saveResult.rawMessageId,
      scenarioCode: modelExtraction.scenarioCode,
      extractorCode: modelExtraction.extractorCode,
      status: modelExtraction.status,
      confidence: modelExtraction.confidence,
      needsReview: modelExtraction.needsReview,
      resultJson: {
        ...resultJson,
        reimbursementReportId: report.id,
        source: "batch_import",
      },
    });

    results.push({
      attachment,
      extraction,
      rawMessageId: saveResult.rawMessageId,
      report,
    });
  }

  return results;
}
