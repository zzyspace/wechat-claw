import fs from "node:fs";

import { getDatabase } from "../../core/storage/database.js";
import { addDaysToDateString, getUtcRangeForZonedDate, getZonedDateParts, zonedDateTimeToUtc } from "../../core/runtime/timezone.js";
import {
  DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY,
  getReimbursementExpenseCategoryLabel,
  mergeReimbursementExpenseCategory,
} from "./categories.js";
import type {
  AdminReimbursementListAttachmentPreview,
  AdminReimbursementDetail,
  AdminReimbursementListItem,
  AdminReimbursementReportSourceDetail,
  ReimbursementEvidenceType,
  ReimbursementExpenseCategory,
  ReimbursementReportDetail,
  ReimbursementReceiptDeliveryRecord,
  ReimbursementReceiptTargetType,
  ReimbursementReportInput,
  ReimbursementReportRecord,
  ReimbursementSourceAttachmentRecord,
  ReimbursementReportSourceDetail,
  ReimbursementReportSourceRecord,
  ReimbursementSourceRole,
  ReimbursementVoucherDateSource,
} from "./types.js";

const DEFAULT_REIMBURSEMENT_TIME_ZONE = "Asia/Shanghai";

export interface RecentPrimaryImageReportLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
}

export interface RecentTextOnlyReportLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
  sinceRawMessageId?: number;
  currentRawMessageId?: number;
}

export interface ForwardTextOnlyReportMatch {
  report: ReimbursementReportRecord;
  rawMessageId: number;
  eventReceivedAt: string;
}

export interface ForwardTextOnlyReportLookupInput {
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  afterIso: string;
  untilIso: string;
  currentRawMessageId?: number;
}

export interface RecentImageRawMessageLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
  currentRawMessageId?: number;
}

export interface NextImageRawMessageLookupInput {
  afterIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  untilIso: string;
  currentRawMessageId?: number;
}

export interface ImageRawMessageMatch {
  rawMessageId: number;
  eventReceivedAt: string;
}

export interface RecentRemarkTextSourceLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
  sinceRawMessageId?: number;
  currentRawMessageId?: number;
}

export interface RemarkTextSourceMatch {
  reimbursementReportId: number;
  rawMessageId: number;
  eventReceivedAt: string;
  textContent: string;
}

function resolveMonthlyLedgerCreatedAtOverride(input: {
  note: string;
  timeZone?: string;
  referenceDateTime?: string;
}) {
  const match = input.note.match(/(\d{1,2})月账/);

  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  const referenceDate = input.referenceDateTime ? new Date(input.referenceDateTime) : new Date();
  if (!Number.isFinite(referenceDate.getTime())) {
    return null;
  }

  const timeZone = input.timeZone ?? DEFAULT_REIMBURSEMENT_TIME_ZONE;
  const anchorDate = new Date(referenceDate.getTime() - 15 * 24 * 60 * 60 * 1000);
  const anchorYear = getZonedDateParts(anchorDate, timeZone).year;
  const lastDay = new Date(Date.UTC(anchorYear, month, 0)).getUTCDate();
  const utcDate = zonedDateTimeToUtc(anchorYear, month, lastDay, 0, 0, 0, timeZone);

  return utcDate.toISOString().slice(0, 19).replace("T", " ");
}

function mapReportRow(row: {
  id: number;
  channelCode?: string | null;
  channelName: string;
  reporter: string;
  amount: number | null;
  currency: string;
  expenseCategory: string;
  voucherDate: string;
  voucherDateSource: string;
  note: string;
  evidenceType: string;
  merchant: string | null;
  documentNo: string | null;
  voucherType: string | null;
  ocrText: string | null;
  confidence: number;
  needsReview: number;
  createdAt: string;
  updatedAt: string;
}): ReimbursementReportRecord {
  return {
    id: row.id,
    channelCode: row.channelCode ?? undefined,
    channelName: row.channelName,
    reporter: row.reporter,
    amount: row.amount,
    currency: row.currency,
    expenseCategory: row.expenseCategory as ReimbursementExpenseCategory,
    voucherDate: row.voucherDate,
    voucherDateSource: row.voucherDateSource as ReimbursementVoucherDateSource,
    note: row.note,
    evidenceType: row.evidenceType as ReimbursementEvidenceType,
    merchant: row.merchant,
    documentNo: row.documentNo,
    voucherType: row.voucherType,
    ocrText: row.ocrText,
    confidence: row.confidence,
    needsReview: Boolean(row.needsReview),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReceiptDeliveryRow(row: {
  id: number;
  reimbursementReportId: number;
  channelCode?: string | null;
  targetType: string;
  targetValue: string;
  receiptText: string;
  sentAt: string;
  rawMessageId?: number | null;
  createdAt: string;
  updatedAt: string;
}): ReimbursementReceiptDeliveryRecord {
  return {
    id: row.id,
    reimbursementReportId: row.reimbursementReportId,
    channelCode: row.channelCode ?? undefined,
    targetType: row.targetType as ReimbursementReceiptTargetType,
    targetValue: row.targetValue,
    receiptText: row.receiptText,
    sentAt: row.sentAt,
    rawMessageId: row.rawMessageId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeSourceText(text: string) {
  const normalized = text === "(非文本消息)" ? "" : text.trim();
  return normalized;
}

function escapeLikePattern(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function formatUtcDateForDatabase(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function selectReportById(id: number): ReimbursementReportRecord {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          channel_code as channelCode,
          channel_name as channelName,
          reporter,
          amount,
          currency,
          expense_category as expenseCategory,
          voucher_date as voucherDate,
          voucher_date_source as voucherDateSource,
          note,
          evidence_type as evidenceType,
          merchant,
          document_no as documentNo,
          voucher_type as voucherType,
          ocr_text as ocrText,
          confidence,
          needs_review as needsReview,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_reports
        WHERE id = ?
      `,
    )
    .get(id) as Parameters<typeof mapReportRow>[0] | undefined;

  if (!row) {
    throw new Error(`Reimbursement report not found: ${id}`);
  }

  return mapReportRow(row);
}

function findReportById(id: number): ReimbursementReportRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          channel_code as channelCode,
          channel_name as channelName,
          reporter,
          amount,
          currency,
          expense_category as expenseCategory,
          voucher_date as voucherDate,
          voucher_date_source as voucherDateSource,
          note,
          evidence_type as evidenceType,
          merchant,
          document_no as documentNo,
          voucher_type as voucherType,
          ocr_text as ocrText,
          confidence,
          needs_review as needsReview,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_reports
        WHERE id = ?
      `,
    )
    .get(id) as Parameters<typeof mapReportRow>[0] | undefined;

  return row ? mapReportRow(row) : null;
}

function selectReceiptDeliveryById(id: number): ReimbursementReceiptDeliveryRecord {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          reimbursement_report_id as reimbursementReportId,
          channel_code as channelCode,
          target_type as targetType,
          target_value as targetValue,
          receipt_text as receiptText,
          sent_at as sentAt,
          raw_message_id as rawMessageId,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_receipt_deliveries
        WHERE id = ?
      `,
    )
    .get(id) as Parameters<typeof mapReceiptDeliveryRow>[0] | undefined;

  if (!row) {
    throw new Error(`Reimbursement receipt delivery not found: ${id}`);
  }

  return mapReceiptDeliveryRow(row);
}

export function getReimbursementReportByRawMessageId(
  rawMessageId: number,
): ReimbursementReportRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT reimbursement_report_id as reimbursementReportId
        FROM reimbursement_report_sources
        WHERE raw_message_id = ?
      `,
    )
    .get(rawMessageId) as { reimbursementReportId: number } | undefined;

  return row ? selectReportById(row.reimbursementReportId) : null;
}

export function saveReimbursementReport(input: ReimbursementReportInput): ReimbursementReportRecord {
  const existing = getReimbursementReportByRawMessageId(input.primaryRawMessageId);

  if (existing) {
    return existing;
  }

  const db = getDatabase();
  const createdAtOverride = resolveMonthlyLedgerCreatedAtOverride({
    note: input.note,
    timeZone: input.timeZone,
    referenceDateTime: input.referenceDateTime,
  });
  const insertReport = db.prepare(`
    INSERT INTO reimbursement_reports (
      channel_code,
      channel_name,
      reporter,
      amount,
      currency,
      expense_category,
      voucher_date,
      voucher_date_source,
      note,
      evidence_type,
      merchant,
      document_no,
      voucher_type,
      ocr_text,
      confidence,
      needs_review,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `);
  const insertSource = db.prepare(`
    INSERT INTO reimbursement_report_sources (
      reimbursement_report_id,
      raw_message_id,
      role
    ) VALUES (?, ?, ?)
  `);

  const reportId = db.transaction(() => {
    const result = insertReport.run(
      input.channelCode ?? null,
      input.channelName,
      input.reporter,
      input.amount,
      input.currency,
      input.expenseCategory || DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY,
      input.voucherDate,
      input.voucherDateSource,
      input.note,
      input.evidenceType,
      input.merchant,
      input.documentNo,
      input.voucherType,
      input.ocrText,
      input.confidence,
      input.needsReview ? 1 : 0,
      createdAtOverride,
    );
    const createdReportId = Number(result.lastInsertRowid);

    insertSource.run(createdReportId, input.primaryRawMessageId, "primary");
    return createdReportId;
  })();

  return selectReportById(reportId);
}

export function saveReimbursementReceiptDelivery(input: {
  reimbursementReportId: number;
  channelCode?: string;
  targetType: ReimbursementReceiptTargetType;
  targetValue: string;
  receiptText: string;
  sentAt: string;
  rawMessageId?: number;
}): ReimbursementReceiptDeliveryRecord {
  const db = getDatabase();
  const existingReport = findReportById(input.reimbursementReportId);

  if (!existingReport) {
    throw new Error(`Reimbursement report not found: ${input.reimbursementReportId}`);
  }

  const rawMessageId = input.rawMessageId ?? null;
  if (rawMessageId !== null) {
    const existingByRawMessage = db
      .prepare(
        `
          SELECT id
          FROM reimbursement_receipt_deliveries
          WHERE raw_message_id = ?
        `,
      )
      .get(rawMessageId) as { id: number } | undefined;

    if (existingByRawMessage) {
      return selectReceiptDeliveryById(existingByRawMessage.id);
    }
  }

  const result = db
    .prepare(
      `
        INSERT INTO reimbursement_receipt_deliveries (
          reimbursement_report_id,
          channel_code,
          target_type,
          target_value,
          receipt_text,
          sent_at,
          raw_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.reimbursementReportId,
      input.channelCode ?? null,
      input.targetType,
      input.targetValue,
      input.receiptText,
      input.sentAt,
      rawMessageId,
    );

  return selectReceiptDeliveryById(Number(result.lastInsertRowid));
}

export function attachRawMessageToRecentReimbursementReceiptDelivery(input: {
  targetType: ReimbursementReceiptTargetType;
  targetValue: string;
  receiptText: string;
  rawMessageId: number;
  sentAt: string;
  matchWindowSeconds?: number;
}): ReimbursementReceiptDeliveryRecord | null {
  const db = getDatabase();
  const existingByRawMessage = db
    .prepare(
      `
        SELECT id
        FROM reimbursement_receipt_deliveries
        WHERE raw_message_id = ?
      `,
    )
    .get(input.rawMessageId) as { id: number } | undefined;

  if (existingByRawMessage) {
    return selectReceiptDeliveryById(existingByRawMessage.id);
  }

  const matchWindowSeconds = input.matchWindowSeconds ?? 90;
  const sinceIso = new Date(new Date(input.sentAt).getTime() - matchWindowSeconds * 1000).toISOString();
  const row = db
    .prepare(
      `
        SELECT id
        FROM reimbursement_receipt_deliveries
        WHERE target_type = ?
          AND target_value = ?
          AND receipt_text = ?
          AND raw_message_id IS NULL
          AND sent_at >= ?
          AND sent_at <= ?
        ORDER BY sent_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(
      input.targetType,
      input.targetValue,
      input.receiptText,
      sinceIso,
      input.sentAt,
    ) as { id: number } | undefined;

  if (!row) {
    return null;
  }

  db.prepare(
    `
      UPDATE reimbursement_receipt_deliveries
      SET
        raw_message_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `,
  ).run(input.rawMessageId, row.id);

  return selectReceiptDeliveryById(row.id);
}

export function findReimbursementReportByReceiptMessageExternalId(
  messageExternalId: string,
): ReimbursementReportRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT rrd.reimbursement_report_id as reimbursementReportId
        FROM reimbursement_receipt_deliveries rrd
        INNER JOIN raw_messages rm ON rm.id = rrd.raw_message_id
        INNER JOIN reimbursement_reports rr ON rr.id = rrd.reimbursement_report_id
        WHERE rm.message_external_id = ?
        ORDER BY rrd.id DESC
        LIMIT 1
      `,
    )
    .get(messageExternalId) as { reimbursementReportId: number } | undefined;

  return row ? selectReportById(row.reimbursementReportId) : null;
}

export function findLatestReimbursementReportByReceiptText(input: {
  targetType: ReimbursementReceiptTargetType;
  targetValue: string;
  receiptText: string;
  beforeIso: string;
  reporter?: string;
}): ReimbursementReportRecord | null {
  const db = getDatabase();
  const reporterWhereSql = input.reporter ? "AND rr.reporter = ?" : "";
  const row = db
    .prepare(
      `
        SELECT rrd.reimbursement_report_id as reimbursementReportId
        FROM reimbursement_receipt_deliveries rrd
        INNER JOIN reimbursement_reports rr ON rr.id = rrd.reimbursement_report_id
        LEFT JOIN raw_messages rm ON rm.id = rrd.raw_message_id
        WHERE rrd.target_type = ?
          AND rrd.target_value = ?
          AND rrd.receipt_text = ?
          AND COALESCE(rm.event_received_at, rrd.sent_at) < ?
          ${reporterWhereSql}
        ORDER BY
          CASE WHEN rrd.raw_message_id IS NULL THEN 1 ELSE 0 END ASC,
          COALESCE(rm.event_received_at, rrd.sent_at) DESC,
          rrd.id DESC
        LIMIT 1
      `,
    )
    .get(
      ...[
        input.targetType,
        input.targetValue,
        input.receiptText,
        input.beforeIso,
        ...(input.reporter ? [input.reporter] : []),
      ],
    ) as
    | { reimbursementReportId: number }
    | undefined;

  return row ? selectReportById(row.reimbursementReportId) : null;
}

export function updateReimbursementReportAmount(input: {
  reimbursementReportId: number;
  amount: number;
}): ReimbursementReportRecord {
  const existing = selectReportById(input.reimbursementReportId);
  const db = getDatabase();

  db.prepare(
    `
      UPDATE reimbursement_reports
      SET
        amount = ?,
        needs_review = 0,
        updated_at = datetime('now')
      WHERE id = ?
    `,
  ).run(input.amount, existing.id);

  return selectReportById(existing.id);
}

export function updateReimbursementReportExpenseCategory(input: {
  reimbursementReportId: number;
  expenseCategory: ReimbursementExpenseCategory;
}): ReimbursementReportRecord {
  const existing = selectReportById(input.reimbursementReportId);
  const db = getDatabase();

  db.prepare(
    `
      UPDATE reimbursement_reports
      SET
        expense_category = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `,
  ).run(input.expenseCategory || DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY, existing.id);

  return selectReportById(existing.id);
}

export function deleteReimbursementReport(reimbursementReportId: number): boolean {
  const existing = findReportById(reimbursementReportId);

  if (!existing) {
    return false;
  }

  const db = getDatabase();
  db.transaction(() => {
    db.prepare(
      `
        DELETE FROM reimbursement_receipt_deliveries
        WHERE reimbursement_report_id = ?
      `,
    ).run(reimbursementReportId);
    db.prepare(
      `
        DELETE FROM reimbursement_report_sources
        WHERE reimbursement_report_id = ?
      `,
    ).run(reimbursementReportId);
    db.prepare(
      `
        DELETE FROM reimbursement_reports
        WHERE id = ?
      `,
    ).run(reimbursementReportId);
  })();

  return true;
}

export function findRecentPrimaryImageReimbursementReport(
  input: RecentPrimaryImageReportLookupInput,
): ReimbursementReportRecord | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT rr.id
        FROM reimbursement_reports rr
        INNER JOIN reimbursement_report_sources rrs
          ON rrs.reimbursement_report_id = rr.id AND rrs.role = 'primary'
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND rm.event_received_at >= ?
          AND rm.event_received_at < ?
          AND rr.evidence_type IN ('image', 'image+text')
        ORDER BY rm.event_received_at DESC, rr.id DESC
        LIMIT 1
      `,
    )
    .get(channelValue, senderValue, input.sinceIso, input.beforeIso) as { id: number } | undefined;

  return row ? selectReportById(row.id) : null;
}

export function findForwardTextOnlyReimbursementReport(
  input: ForwardTextOnlyReportLookupInput,
): ReimbursementReportRecord | null {
  const match = findForwardTextOnlyReimbursementReportMatch(input);
  return match?.report ?? null;
}

export function findForwardTextOnlyReimbursementReportMatch(
  input: ForwardTextOnlyReportLookupInput,
): ForwardTextOnlyReportMatch | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT rr.id
             , rm.id as rawMessageId
             , rm.event_received_at as eventReceivedAt
        FROM reimbursement_reports rr
        INNER JOIN reimbursement_report_sources rrs
          ON rrs.reimbursement_report_id = rr.id AND rrs.role = 'primary'
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND (
            rm.event_received_at > ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id > ?)
            )
          )
          AND rm.event_received_at < ?
          AND rr.evidence_type = 'text'
        ORDER BY rm.event_received_at ASC, rm.id ASC, rr.id DESC
        LIMIT 1
      `,
    )
    .get(
      channelValue,
      senderValue,
      input.afterIso,
      input.afterIso,
      input.currentRawMessageId ?? null,
      input.currentRawMessageId ?? null,
      input.untilIso,
    ) as
    | { id: number; rawMessageId: number; eventReceivedAt: string }
    | undefined;

  return row
    ? {
        report: selectReportById(row.id),
        rawMessageId: row.rawMessageId,
        eventReceivedAt: row.eventReceivedAt,
      }
    : null;
}

export function findRecentTextOnlyReimbursementReport(
  input: RecentTextOnlyReportLookupInput,
): ReimbursementReportRecord | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT rr.id
        FROM reimbursement_reports rr
        INNER JOIN reimbursement_report_sources rrs
          ON rrs.reimbursement_report_id = rr.id AND rrs.role = 'primary'
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND (
            rm.event_received_at > ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id > ?)
            )
          )
          AND (
            rm.event_received_at < ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id < ?)
            )
          )
          AND rr.evidence_type = 'text'
        ORDER BY rm.event_received_at DESC, rm.id DESC, rr.id DESC
        LIMIT 1
      `,
    )
    .get(
      channelValue,
      senderValue,
      input.sinceIso,
      input.sinceIso,
      input.sinceRawMessageId ?? null,
      input.sinceRawMessageId ?? null,
      input.beforeIso,
      input.beforeIso,
      input.currentRawMessageId ?? null,
      input.currentRawMessageId ?? null,
    ) as
    | { id: number }
    | undefined;

  return row ? selectReportById(row.id) : null;
}

export function findRecentRemarkTextSource(
  input: RecentRemarkTextSourceLookupInput,
): RemarkTextSourceMatch | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT
          rrs.reimbursement_report_id as reimbursementReportId,
          rm.id as rawMessageId,
          rm.event_received_at as eventReceivedAt,
          rm.text_content as textContent
        FROM reimbursement_report_sources rrs
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND rrs.role = 'remark'
          AND NOT EXISTS (
            SELECT 1
            FROM message_attachments ma
            WHERE ma.raw_message_id = rm.id
          )
          AND rm.text_content != '(非文本消息)'
          AND (
            rm.event_received_at > ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id > ?)
            )
          )
          AND (
            rm.event_received_at < ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id < ?)
            )
          )
        ORDER BY rm.event_received_at DESC, rm.id DESC
        LIMIT 1
      `,
    )
    .get(
      channelValue,
      senderValue,
      input.sinceIso,
      input.sinceIso,
      input.sinceRawMessageId ?? null,
      input.sinceRawMessageId ?? null,
      input.beforeIso,
      input.beforeIso,
      input.currentRawMessageId ?? null,
      input.currentRawMessageId ?? null,
    ) as RemarkTextSourceMatch | undefined;

  return row ?? null;
}

export function findRecentImageRawMessage(
  input: RecentImageRawMessageLookupInput,
): ImageRawMessageMatch | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT
          rm.id as rawMessageId,
          rm.event_received_at as eventReceivedAt
        FROM raw_messages rm
        INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND rm.event_received_at >= ?
          AND (
            rm.event_received_at < ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id < ?)
            )
          )
        ORDER BY rm.event_received_at DESC, rm.id DESC
        LIMIT 1
      `,
    )
    .get(
      channelValue,
      senderValue,
      input.sinceIso,
      input.beforeIso,
      input.beforeIso,
      input.currentRawMessageId ?? null,
      input.currentRawMessageId ?? null,
    ) as ImageRawMessageMatch | undefined;

  return row ?? null;
}

export function findNextImageRawMessage(
  input: NextImageRawMessageLookupInput,
): ImageRawMessageMatch | null {
  const db = getDatabase();
  const senderCondition = input.senderExternalId
    ? "rm.sender_external_id = ?"
    : "rm.sender_name = ?";
  const senderValue = input.senderExternalId ?? input.senderName;
  const channelCondition = input.channelCode ? "rm.channel_code = ?" : "rm.channel_name = ?";
  const channelValue = input.channelCode ?? input.channelName;
  const row = db
    .prepare(
      `
        SELECT
          rm.id as rawMessageId,
          rm.event_received_at as eventReceivedAt
        FROM raw_messages rm
        INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
        WHERE ${channelCondition}
          AND ${senderCondition}
          AND (
            rm.event_received_at > ?
            OR (
              rm.event_received_at = ?
              AND (? IS NULL OR rm.id > ?)
            )
          )
          AND rm.event_received_at < ?
        ORDER BY rm.event_received_at ASC, rm.id ASC
        LIMIT 1
      `,
    )
    .get(
      channelValue,
      senderValue,
      input.afterIso,
      input.afterIso,
      input.currentRawMessageId ?? null,
      input.currentRawMessageId ?? null,
      input.untilIso,
    ) as ImageRawMessageMatch | undefined;

  return row ?? null;
}

export function addReimbursementReportSource(input: {
  reimbursementReportId: number;
  rawMessageId: number;
  role: ReimbursementSourceRole;
}): ReimbursementReportSourceRecord {
  const db = getDatabase();

  db.prepare(
    `
      INSERT OR IGNORE INTO reimbursement_report_sources (
        reimbursement_report_id,
        raw_message_id,
        role
      ) VALUES (?, ?, ?)
    `,
  ).run(input.reimbursementReportId, input.rawMessageId, input.role);

  const row = db
    .prepare(
      `
        SELECT
          id,
          reimbursement_report_id as reimbursementReportId,
          raw_message_id as rawMessageId,
          role,
          created_at as createdAt
        FROM reimbursement_report_sources
        WHERE raw_message_id = ?
      `,
    )
    .get(input.rawMessageId) as
    | {
        id: number;
        reimbursementReportId: number;
        rawMessageId: number;
        role: string;
        createdAt: string;
      }
    | undefined;

  if (!row) {
    throw new Error("Reimbursement report source was not persisted");
  }

  return {
    ...row,
    role: row.role as ReimbursementSourceRole,
  };
}

function refreshReimbursementReportFromSources(input: {
  reimbursementReportId: number;
  timeZone?: string;
  referenceDateTime?: string;
}) {
  const db = getDatabase();
  const existing = selectReportById(input.reimbursementReportId);
  const rows = db
    .prepare(
      `
        SELECT
          rm.text_content as textContent,
          EXISTS (
            SELECT 1
            FROM message_attachments ma
            WHERE ma.raw_message_id = rm.id
          ) as hasAttachment
        FROM reimbursement_report_sources rrs
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE rrs.reimbursement_report_id = ?
        ORDER BY rrs.id ASC
      `,
    )
    .all(input.reimbursementReportId) as Array<{
    textContent: string;
    hasAttachment: number;
  }>;

  let mergedNote = "";
  let hasImage = false;

  for (const row of rows) {
    mergedNote = mergeReportNotes(mergedNote, normalizeSourceText(row.textContent));
    hasImage = hasImage || Boolean(row.hasAttachment);
  }

  const evidenceType: ReimbursementEvidenceType = hasImage
    ? mergedNote
      ? "image+text"
      : "image"
    : "text";
  const createdAtOverride = resolveMonthlyLedgerCreatedAtOverride({
    note: mergedNote,
    timeZone: input.timeZone,
    referenceDateTime: input.referenceDateTime,
  });

  db.prepare(
    `
      UPDATE reimbursement_reports
      SET
        note = ?,
        evidence_type = ?,
        created_at = COALESCE(?, created_at),
        updated_at = datetime('now')
      WHERE id = ?
    `,
  ).run(mergedNote, evidenceType, createdAtOverride, input.reimbursementReportId);

  return existing;
}

export function attachRemarkToReimbursementReport(input: {
  reimbursementReportId: number;
  rawMessageId: number;
  note: string;
  timeZone?: string;
  referenceDateTime?: string;
}): ReimbursementReportRecord {
  const db = getDatabase();
  const existing = selectReportById(input.reimbursementReportId);
  const mergedNote = mergeReportNotes(existing.note, input.note);
  const createdAtOverride = resolveMonthlyLedgerCreatedAtOverride({
    note: mergedNote,
    timeZone: input.timeZone,
    referenceDateTime: input.referenceDateTime,
  });

  db.transaction(() => {
    addReimbursementReportSource({
      reimbursementReportId: input.reimbursementReportId,
      rawMessageId: input.rawMessageId,
      role: "remark",
    });

    db.prepare(
      `
        UPDATE reimbursement_reports
        SET
          note = ?,
          evidence_type = 'image+text',
          created_at = COALESCE(?, created_at),
          updated_at = datetime('now')
        WHERE id = ?
      `,
    ).run(mergedNote, createdAtOverride, input.reimbursementReportId);
  })();

  return selectReportById(input.reimbursementReportId);
}

export function mergePrimaryImageIntoTextOnlyReimbursementReport(input: {
  reimbursementReportId: number;
  imageRawMessageId: number;
  amount: number | null;
  currency: string;
  expenseCategory: ReimbursementExpenseCategory;
  voucherDate: string;
  voucherDateSource: ReimbursementVoucherDateSource;
  note: string;
  merchant: string | null;
  documentNo: string | null;
  voucherType: string | null;
  ocrText: string | null;
  confidence: number;
  needsReview: boolean;
  timeZone?: string;
  referenceDateTime?: string;
}): ReimbursementReportRecord {
  const db = getDatabase();
  const existing = selectReportById(input.reimbursementReportId);
  const mergedNote = mergeReportNotes(existing.note, input.note);
  const mergedAmount = input.amount ?? existing.amount;
  const mergedCurrency = input.amount !== null ? input.currency : existing.currency;
  const mergedExpenseCategory = mergeReimbursementExpenseCategory(
    existing.expenseCategory || DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY,
    input.expenseCategory || DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY,
  );
  const mergedVoucherDate = input.voucherDateSource === "model" ? input.voucherDate : existing.voucherDate;
  const mergedVoucherDateSource =
    input.voucherDateSource === "model" ? input.voucherDateSource : existing.voucherDateSource;
  const mergedNeedsReview = input.amount !== null ? input.needsReview : existing.needsReview || input.needsReview;
  const createdAtOverride = resolveMonthlyLedgerCreatedAtOverride({
    note: mergedNote,
    timeZone: input.timeZone,
    referenceDateTime: input.referenceDateTime,
  });

  db.transaction(() => {
    db.prepare(
      `
        UPDATE reimbursement_report_sources
        SET role = 'remark'
        WHERE reimbursement_report_id = ? AND role = 'primary'
      `,
    ).run(input.reimbursementReportId);

    addReimbursementReportSource({
      reimbursementReportId: input.reimbursementReportId,
      rawMessageId: input.imageRawMessageId,
      role: "primary",
    });

    db.prepare(
      `
        UPDATE reimbursement_reports
        SET
          amount = ?,
          currency = ?,
          expense_category = ?,
          voucher_date = ?,
          voucher_date_source = ?,
          note = ?,
          evidence_type = 'image+text',
          merchant = ?,
          document_no = ?,
          voucher_type = ?,
          ocr_text = ?,
          confidence = ?,
          needs_review = ?,
          created_at = COALESCE(?, created_at),
          updated_at = datetime('now')
        WHERE id = ?
      `,
    ).run(
      mergedAmount,
      mergedCurrency,
      mergedExpenseCategory,
      mergedVoucherDate,
      mergedVoucherDateSource,
      mergedNote,
      input.merchant ?? existing.merchant,
      input.documentNo ?? existing.documentNo,
      input.voucherType ?? existing.voucherType,
      input.ocrText ?? existing.ocrText,
      Math.max(existing.confidence, input.confidence),
      mergedNeedsReview ? 1 : 0,
      createdAtOverride,
      input.reimbursementReportId,
    );
  })();

  return selectReportById(input.reimbursementReportId);
}

export function moveRemarkToReimbursementReport(input: {
  targetReimbursementReportId: number;
  rawMessageId: number;
  timeZone?: string;
  referenceDateTime?: string;
}): {
  sourceReport: ReimbursementReportRecord;
  targetReport: ReimbursementReportRecord;
} {
  const db = getDatabase();
  const source = db
    .prepare(
      `
        SELECT
          reimbursement_report_id as reimbursementReportId,
          role
        FROM reimbursement_report_sources
        WHERE raw_message_id = ?
      `,
    )
    .get(input.rawMessageId) as
    | {
        reimbursementReportId: number;
        role: string;
      }
    | undefined;

  if (!source || source.role !== "remark") {
    throw new Error(`Remark source not found for raw message: ${input.rawMessageId}`);
  }

  if (source.reimbursementReportId === input.targetReimbursementReportId) {
    const report = selectReportById(input.targetReimbursementReportId);
    return {
      sourceReport: report,
      targetReport: report,
    };
  }

  db.transaction(() => {
    db.prepare(
      `
        UPDATE reimbursement_report_sources
        SET reimbursement_report_id = ?
        WHERE raw_message_id = ?
      `,
    ).run(input.targetReimbursementReportId, input.rawMessageId);

    refreshReimbursementReportFromSources({
      reimbursementReportId: source.reimbursementReportId,
      timeZone: input.timeZone,
      referenceDateTime: input.referenceDateTime,
    });
    refreshReimbursementReportFromSources({
      reimbursementReportId: input.targetReimbursementReportId,
      timeZone: input.timeZone,
      referenceDateTime: input.referenceDateTime,
    });
  })();

  return {
    sourceReport: selectReportById(source.reimbursementReportId),
    targetReport: selectReportById(input.targetReimbursementReportId),
  };
}

export function listRecentReimbursementReports(limit = 10): ReimbursementReportRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          channel_code as channelCode,
          channel_name as channelName,
          reporter,
          amount,
          currency,
          expense_category as expenseCategory,
          voucher_date as voucherDate,
          voucher_date_source as voucherDateSource,
          note,
          evidence_type as evidenceType,
          merchant,
          document_no as documentNo,
          voucher_type as voucherType,
          ocr_text as ocrText,
          confidence,
          needs_review as needsReview,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_reports
        ORDER BY id DESC
        LIMIT ?
      `,
    )
    .all(limit) as Parameters<typeof mapReportRow>[0][];

  return rows.map(mapReportRow);
}

function listSourcesByReportIds(reportIds: number[]): Map<number, ReimbursementReportSourceDetail[]> {
  const grouped = new Map<number, ReimbursementReportSourceDetail[]>();

  if (reportIds.length === 0) {
    return grouped;
  }

  const db = getDatabase();
  const placeholders = reportIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          rrs.id,
          rrs.reimbursement_report_id as reimbursementReportId,
          rrs.raw_message_id as rawMessageId,
          rrs.role,
          rrs.created_at as createdAt,
          rm.event_received_at as eventReceivedAt,
          rm.message_external_id as messageExternalId,
          rm.sender_name as senderName,
          rm.text_content as textContent
        FROM reimbursement_report_sources rrs
        INNER JOIN raw_messages rm ON rm.id = rrs.raw_message_id
        WHERE rrs.reimbursement_report_id IN (${placeholders})
        ORDER BY rrs.reimbursement_report_id ASC, rrs.id ASC
      `,
    )
    .all(...reportIds) as Array<{
    id: number;
    reimbursementReportId: number;
    rawMessageId: number;
    role: string;
    createdAt: string;
    eventReceivedAt: string;
    messageExternalId: string;
    senderName: string;
    textContent: string;
  }>;

  for (const row of rows) {
    const source: ReimbursementReportSourceDetail = {
      id: row.id,
      reimbursementReportId: row.reimbursementReportId,
      rawMessageId: row.rawMessageId,
      role: row.role as ReimbursementSourceRole,
      createdAt: row.createdAt,
      eventReceivedAt: row.eventReceivedAt,
      messageExternalId: row.messageExternalId,
      senderName: row.senderName,
      textContent: row.textContent,
    };
    const list = grouped.get(row.reimbursementReportId) ?? [];
    list.push(source);
    grouped.set(row.reimbursementReportId, list);
  }

  return grouped;
}

function listAttachmentsByRawMessageIds(
  rawMessageIds: number[],
): Map<number, ReimbursementSourceAttachmentRecord[]> {
  const grouped = new Map<number, ReimbursementSourceAttachmentRecord[]>();

  if (rawMessageIds.length === 0) {
    return grouped;
  }

  const db = getDatabase();
  const placeholders = rawMessageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          id,
          raw_message_id as rawMessageId,
          attachment_type as type,
          local_path as localPath,
          sha256,
          mime_type as mimeType,
          created_at as createdAt
        FROM message_attachments
        WHERE raw_message_id IN (${placeholders})
        ORDER BY raw_message_id ASC, id ASC
      `,
    )
    .all(...rawMessageIds) as Array<{
    id: number;
    rawMessageId: number;
    type: string;
    localPath: string;
    sha256: string;
    mimeType?: string | null;
    createdAt: string;
  }>;

  for (const row of rows) {
    const attachment: ReimbursementSourceAttachmentRecord = {
      id: row.id,
      rawMessageId: row.rawMessageId,
      type: row.type,
      localPath: row.localPath,
      sha256: row.sha256,
      mimeType: row.mimeType ?? undefined,
      createdAt: row.createdAt,
      exists: fs.existsSync(row.localPath),
    };
    const list = grouped.get(row.rawMessageId) ?? [];
    list.push(attachment);
    grouped.set(row.rawMessageId, list);
  }

  return grouped;
}

function listAdminSourcesByReportIds(
  reportIds: number[],
): Map<number, AdminReimbursementReportSourceDetail[]> {
  const sourcesByReportId = listSourcesByReportIds(reportIds);
  const rawMessageIds = Array.from(sourcesByReportId.values())
    .flat()
    .map((source) => source.rawMessageId);
  const attachmentsByRawMessageId = listAttachmentsByRawMessageIds(rawMessageIds);
  const grouped = new Map<number, AdminReimbursementReportSourceDetail[]>();

  for (const [reportId, sources] of sourcesByReportId.entries()) {
    grouped.set(
      reportId,
      sources.map((source) => ({
        ...source,
        attachments: attachmentsByRawMessageId.get(source.rawMessageId) ?? [],
      })),
    );
  }

  return grouped;
}

function listAdminBillAttachmentsByReportIds(
  reportIds: number[],
): Map<number, AdminReimbursementListAttachmentPreview> {
  const grouped = new Map<number, AdminReimbursementListAttachmentPreview>();

  if (reportIds.length === 0) {
    return grouped;
  }

  const db = getDatabase();
  const placeholders = reportIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          rrs.reimbursement_report_id as reimbursementReportId,
          ma.id,
          ma.attachment_type as type,
          ma.local_path as localPath,
          ma.mime_type as mimeType
        FROM reimbursement_report_sources rrs
        INNER JOIN message_attachments ma ON ma.raw_message_id = rrs.raw_message_id
        WHERE rrs.reimbursement_report_id IN (${placeholders})
          AND rrs.role = 'primary'
          AND (
            ma.attachment_type = 'image'
            OR IFNULL(ma.mime_type, '') LIKE 'image/%'
          )
        ORDER BY rrs.reimbursement_report_id ASC, ma.id ASC
      `,
    )
    .all(...reportIds) as Array<{
    reimbursementReportId: number;
    id: number;
    type: string;
    localPath: string;
    mimeType?: string | null;
  }>;

  for (const row of rows) {
    if (grouped.has(row.reimbursementReportId)) {
      continue;
    }

    grouped.set(row.reimbursementReportId, {
      id: row.id,
      type: row.type,
      mimeType: row.mimeType ?? undefined,
      exists: fs.existsSync(row.localPath),
    });
  }

  return grouped;
}

function listReceiptDeliveriesByReportIds(
  reportIds: number[],
): Map<number, ReimbursementReceiptDeliveryRecord[]> {
  const grouped = new Map<number, ReimbursementReceiptDeliveryRecord[]>();

  if (reportIds.length === 0) {
    return grouped;
  }

  const db = getDatabase();
  const placeholders = reportIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          id,
          reimbursement_report_id as reimbursementReportId,
          channel_code as channelCode,
          target_type as targetType,
          target_value as targetValue,
          receipt_text as receiptText,
          sent_at as sentAt,
          raw_message_id as rawMessageId,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_receipt_deliveries
        WHERE reimbursement_report_id IN (${placeholders})
        ORDER BY reimbursement_report_id ASC, id ASC
      `,
    )
    .all(...reportIds) as Parameters<typeof mapReceiptDeliveryRow>[0][];

  for (const row of rows) {
    const delivery = mapReceiptDeliveryRow(row);
    const list = grouped.get(delivery.reimbursementReportId) ?? [];
    list.push(delivery);
    grouped.set(delivery.reimbursementReportId, list);
  }

  return grouped;
}

export function listReimbursementReportDetails(options?: {
  channelCode?: string;
  limit?: number;
}): ReimbursementReportDetail[] {
  const db = getDatabase();
  const hasLimit = Number.isFinite(options?.limit) && Number(options?.limit) > 0;
  const baseSql = `
    SELECT
      id,
      channel_code as channelCode,
      channel_name as channelName,
      reporter,
      amount,
      currency,
      expense_category as expenseCategory,
      voucher_date as voucherDate,
      voucher_date_source as voucherDateSource,
      note,
      evidence_type as evidenceType,
      merchant,
      document_no as documentNo,
      voucher_type as voucherType,
      ocr_text as ocrText,
      confidence,
      needs_review as needsReview,
      created_at as createdAt,
      updated_at as updatedAt
    FROM reimbursement_reports
  `;
  const whereSql = options?.channelCode ? "WHERE channel_code = ?" : "";
  const orderSql = "ORDER BY id DESC";
  const limitSql = hasLimit ? "LIMIT ?" : "";
  const statement = db.prepare([baseSql, whereSql, orderSql, limitSql].filter(Boolean).join(" "));
  const params: Array<string | number> = [];

  if (options?.channelCode) {
    params.push(options.channelCode);
  }

  if (hasLimit) {
    params.push(Number(options?.limit));
  }

  const rows = statement.all(...params) as Parameters<typeof mapReportRow>[0][];
  const reports = rows.map(mapReportRow);
  const sourcesByReportId = listSourcesByReportIds(reports.map((report) => report.id));

  return reports.map((report) => ({
    ...report,
    sources: sourcesByReportId.get(report.id) ?? [],
  }));
}

export function listAdminReimbursementReports(options?: {
  search?: string;
  channelCode?: string;
  reporter?: string;
  expenseCategory?: ReimbursementExpenseCategory;
  needsReview?: boolean;
  createdDateFrom?: string;
  createdDateTo?: string;
  timeZone?: string;
  limit?: number;
  offset?: number;
}): {
  total: number;
  limit: number;
  offset: number;
  items: AdminReimbursementListItem[];
} {
  const db = getDatabase();
  const limit =
    Number.isFinite(options?.limit) && Number(options?.limit) > 0 ? Math.min(Number(options?.limit), 1000) : 50;
  const offset =
    Number.isFinite(options?.offset) && Number(options?.offset) >= 0 ? Math.max(Number(options?.offset), 0) : 0;
  const clauses: string[] = [];
  const params: Record<string, number | string> = {};
  const search = options?.search?.trim() ?? "";

  if (options?.channelCode) {
    clauses.push("channel_code = @channelCode");
    params.channelCode = options.channelCode;
  }

  if (options?.reporter) {
    clauses.push("reporter LIKE @reporter ESCAPE '\\'");
    params.reporter = `%${escapeLikePattern(options.reporter)}%`;
  }

  if (options?.expenseCategory) {
    clauses.push("expense_category = @expenseCategory");
    params.expenseCategory = options.expenseCategory;
  }

  if (typeof options?.needsReview === "boolean") {
    clauses.push("needs_review = @needsReview");
    params.needsReview = options.needsReview ? 1 : 0;
  }

  if (options?.createdDateFrom) {
    const range = getUtcRangeForZonedDate(options.createdDateFrom, options.timeZone ?? DEFAULT_REIMBURSEMENT_TIME_ZONE);
    clauses.push("created_at >= @createdAtFrom");
    params.createdAtFrom = formatUtcDateForDatabase(new Date(range.startInclusiveIso));
  }

  if (options?.createdDateTo) {
    const endExclusiveDate = addDaysToDateString(options.createdDateTo, 1);
    const range = getUtcRangeForZonedDate(endExclusiveDate, options.timeZone ?? DEFAULT_REIMBURSEMENT_TIME_ZONE);
    clauses.push("created_at < @createdAtToExclusive");
    params.createdAtToExclusive = formatUtcDateForDatabase(new Date(range.startInclusiveIso));
  }

  if (search) {
    if (/^\d+$/.test(search)) {
      clauses.push("id = @searchId");
      params.searchId = Number(search);
    } else {
      clauses.push(
        `(
          channel_name LIKE @search ESCAPE '\\'
          OR reporter LIKE @search ESCAPE '\\'
          OR IFNULL(merchant, '') LIKE @search ESCAPE '\\'
          OR IFNULL(document_no, '') LIKE @search ESCAPE '\\'
          OR IFNULL(note, '') LIKE @search ESCAPE '\\'
          OR IFNULL(ocr_text, '') LIKE @search ESCAPE '\\'
        )`,
      );
      params.search = `%${escapeLikePattern(search)}%`;
    }
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          id,
          channel_code as channelCode,
          channel_name as channelName,
          reporter,
          amount,
          currency,
          expense_category as expenseCategory,
          voucher_date as voucherDate,
          voucher_date_source as voucherDateSource,
          note,
          evidence_type as evidenceType,
          merchant,
          document_no as documentNo,
          voucher_type as voucherType,
          ocr_text as ocrText,
          confidence,
          needs_review as needsReview,
          created_at as createdAt,
          updated_at as updatedAt
        FROM reimbursement_reports
        ${whereSql}
        ORDER BY id DESC
        LIMIT @limit OFFSET @offset
      `,
    )
    .all({
      ...params,
      limit,
      offset,
    }) as Parameters<typeof mapReportRow>[0][];
  const total = db
    .prepare(`SELECT COUNT(*) as count FROM reimbursement_reports ${whereSql}`)
    .get(params) as { count: number };
  const reports = rows.map((row) => mapReportRow(row));
  const billAttachmentsByReportId = listAdminBillAttachmentsByReportIds(reports.map((report) => report.id));

  return {
    total: total.count,
    limit,
    offset,
    items: reports.map((report) => {
      return {
        ...report,
        expenseCategoryLabel: getReimbursementExpenseCategoryLabel(report.expenseCategory),
        billAttachment: billAttachmentsByReportId.get(report.id),
      };
    }),
  };
}

export function getAdminReimbursementReportDetail(reportId: number): AdminReimbursementDetail | null {
  const report = findReportById(reportId);

  if (!report) {
    return null;
  }

  return {
    ...report,
    expenseCategoryLabel: getReimbursementExpenseCategoryLabel(report.expenseCategory),
    sources: listAdminSourcesByReportIds([reportId]).get(reportId) ?? [],
    receiptDeliveries: listReceiptDeliveriesByReportIds([reportId]).get(reportId) ?? [],
  };
}

export function findAdminReimbursementAttachment(
  attachmentId: number,
): ReimbursementSourceAttachmentRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          ma.id,
          ma.raw_message_id as rawMessageId,
          ma.attachment_type as type,
          ma.local_path as localPath,
          ma.sha256,
          ma.mime_type as mimeType,
          ma.created_at as createdAt
        FROM message_attachments ma
        INNER JOIN reimbursement_report_sources rrs
          ON rrs.raw_message_id = ma.raw_message_id
        WHERE ma.id = ?
        LIMIT 1
      `,
    )
    .get(attachmentId) as {
    id: number;
    rawMessageId: number;
    type: string;
    localPath: string;
    sha256: string;
    mimeType?: string | null;
    createdAt: string;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    rawMessageId: row.rawMessageId,
    type: row.type,
    localPath: row.localPath,
    sha256: row.sha256,
    mimeType: row.mimeType ?? undefined,
    createdAt: row.createdAt,
    exists: fs.existsSync(row.localPath),
  };
}

function mergeReportNotes(left: string, right: string) {
  if (!left) {
    return right;
  }

  if (!right || left === right) {
    return left;
  }

  return `${left}；${right}`;
}
