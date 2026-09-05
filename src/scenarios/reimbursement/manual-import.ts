import type { ReimbursementAccessPrincipal } from "../../core/config/reimbursement-access.js";
import crypto from "node:crypto";

import { saveScenarioExtraction, type ScenarioExtractionRecord } from "../../core/scenarios/scenario-extraction-repository.js";
import { normalizeMessage } from "../../core/messages/normalize-message.js";
import { formatZonedDate } from "../../core/runtime/timezone.js";
import { saveRawMessage } from "../../core/storage/raw-message-repository.js";
import { getReimbursementExpenseCategoryLabel } from "./categories.js";
import { saveReimbursementReport } from "./repository.js";
import type { ReimbursementExpenseCategory, ReimbursementReportRecord } from "./types.js";
import type { StoredAttachment } from "../../core/storage/types.js";

const MANUAL_IMPORT_EXTRACTOR_CODE = "manual-import-v1";
const MANUAL_IMPORT_MESSAGE_TYPE = "manual_import";
const MANUAL_IMPORT_FALLBACK_TEXT = "(手工补录)";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export interface ManualReimbursementImportInput {
  submittedBy?: ReimbursementAccessPrincipal;
  amount: number;
  channelCode: string;
  channelName: string;
  expenseCategory: ReimbursementExpenseCategory;
  note?: string;
  reporter: string;
  sentAt: string;
  timeZone?: string;
  attachments?: StoredAttachment[];
}

export interface ManualReimbursementImportResult {
  extraction: ScenarioExtractionRecord;
  rawMessageId: number;
  report: ReimbursementReportRecord;
  textContent: string;
}

function normalizeNote(note: string | undefined) {
  return note?.trim() ?? "";
}

function buildManualImportTextContent(note: string) {
  return note || MANUAL_IMPORT_FALLBACK_TEXT;
}

function buildManualImportExternalId(input: {
  channelCode: string;
  reporter: string;
  sentAt: string;
}) {
  const reporterSlug = input.reporter.trim().replace(/\s+/g, "_").slice(0, 48) || "unknown";
  return `manual-reimbursement:${input.channelCode}:${reporterSlug}:${input.sentAt}:${crypto.randomUUID()}`;
}

export function importManualReimbursementReport(
  input: ManualReimbursementImportInput,
): ManualReimbursementImportResult {
  const normalizedNote = normalizeNote(input.note);
  const attachments = input.attachments ?? [];
  const textContent = buildManualImportTextContent(normalizedNote);
  const messageExternalId = buildManualImportExternalId({
    channelCode: input.channelCode,
    reporter: input.reporter,
    sentAt: input.sentAt,
  });
  const normalizedMessage = normalizeMessage({
    messageExternalId,
    channelCode: input.channelCode,
    channelName: input.channelName,
    senderName: input.reporter,
    messageType: MANUAL_IMPORT_MESSAGE_TYPE,
    textContent,
    messageSentAt: input.sentAt,
    eventReceivedAt: input.sentAt,
    attachments,
  });
  const saveResult = saveRawMessage(normalizedMessage);
  const voucherDate = formatZonedDate(new Date(input.sentAt), input.timeZone ?? DEFAULT_TIME_ZONE);
  const report = saveReimbursementReport({
    channelCode: input.channelCode,
    channelName: input.channelName,
    reporter: input.reporter,
    amount: input.amount,
    currency: "CNY",
    expenseCategory: input.expenseCategory,
    voucherDate,
    voucherDateSource: "message",
    note: normalizedNote,
    evidenceType: attachments.length > 0 ? "image+text" : "text",
    merchant: null,
    documentNo: null,
    voucherType: null,
    ocrText: null,
    confidence: 1,
    needsReview: false,
    primaryRawMessageId: saveResult.rawMessageId,
    submittedByAccountId: input.submittedBy?.accountId,
    submittedByUsername: input.submittedBy?.username,
    submittedByRole: input.submittedBy?.role,
    timeZone: input.timeZone,
    referenceDateTime: input.sentAt,
  });
  const extraction = saveScenarioExtraction({
    rawMessageId: saveResult.rawMessageId,
    scenarioCode: "reimbursement",
    extractorCode: MANUAL_IMPORT_EXTRACTOR_CODE,
    status: "extracted",
    confidence: 1,
    needsReview: false,
    resultJson: {
      eventType: "reimbursement_report",
      rawMessageId: saveResult.rawMessageId,
      reimbursementReportId: report.id,
      channelName: input.channelName,
      reporter: input.reporter,
      reportedAt: input.sentAt,
      amount: input.amount,
      currency: "CNY",
      expenseCategory: input.expenseCategory,
      expenseCategoryLabel: getReimbursementExpenseCategoryLabel(input.expenseCategory),
      voucherDate,
      voucherDateSource: "message",
      note: normalizedNote,
      evidenceType: attachments.length > 0 ? "image+text" : "text",
      merchant: null,
      documentNo: null,
      voucherType: null,
      ocrText: null,
      source: "manual_import",
    },
  });

  return {
    extraction,
    rawMessageId: saveResult.rawMessageId,
    report,
    textContent,
  };
}
