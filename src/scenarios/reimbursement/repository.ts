import { getDatabase } from "../../core/storage/database.js";
import type {
  ReimbursementEvidenceType,
  ReimbursementExpenseCategory,
  ReimbursementReportDetail,
  ReimbursementReportInput,
  ReimbursementReportRecord,
  ReimbursementReportSourceDetail,
  ReimbursementReportSourceRecord,
  ReimbursementSourceRole,
  ReimbursementVoucherDateSource,
} from "./types.js";

export interface RecentPrimaryImageReportLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
}

export interface ForwardTextOnlyReportLookupInput {
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  afterIso: string;
  untilIso: string;
}

export interface RecentImageRawMessageLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
}

export interface NextImageRawMessageLookupInput {
  afterIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  untilIso: string;
}

export interface ImageRawMessageMatch {
  rawMessageId: number;
  eventReceivedAt: string;
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
      needs_review
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.expenseCategory,
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
    );
    const createdReportId = Number(result.lastInsertRowid);

    insertSource.run(createdReportId, input.primaryRawMessageId, "primary");
    return createdReportId;
  })();

  return selectReportById(reportId);
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
          AND rm.event_received_at > ?
          AND rm.event_received_at < ?
          AND rr.evidence_type = 'text'
        ORDER BY rm.event_received_at ASC, rr.id DESC
        LIMIT 1
      `,
    )
    .get(channelValue, senderValue, input.afterIso, input.untilIso) as
    | { id: number }
    | undefined;

  return row ? selectReportById(row.id) : null;
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
          AND rm.event_received_at < ?
        ORDER BY rm.event_received_at DESC, rm.id DESC
        LIMIT 1
      `,
    )
    .get(channelValue, senderValue, input.sinceIso, input.beforeIso) as ImageRawMessageMatch | undefined;

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
          AND rm.event_received_at > ?
          AND rm.event_received_at < ?
        ORDER BY rm.event_received_at ASC, rm.id ASC
        LIMIT 1
      `,
    )
    .get(channelValue, senderValue, input.afterIso, input.untilIso) as ImageRawMessageMatch | undefined;

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

export function attachRemarkToReimbursementReport(input: {
  reimbursementReportId: number;
  rawMessageId: number;
  note: string;
}): ReimbursementReportRecord {
  const db = getDatabase();

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
          note = CASE
            WHEN note = '' THEN ?
            WHEN ? = '' THEN note
            WHEN note = ? THEN note
            ELSE note || '；' || ?
          END,
          evidence_type = 'image+text',
          updated_at = datetime('now')
        WHERE id = ?
      `,
    ).run(input.note, input.note, input.note, input.note, input.reimbursementReportId);
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
}): ReimbursementReportRecord {
  const db = getDatabase();
  const existing = selectReportById(input.reimbursementReportId);
  const mergedNote = mergeReportNotes(existing.note, input.note);
  const mergedAmount = input.amount ?? existing.amount;
  const mergedCurrency = input.amount !== null ? input.currency : existing.currency;
  const mergedExpenseCategory =
    existing.expenseCategory === "food" || input.expenseCategory === "food" ? "food" : "other";
  const mergedVoucherDate = input.voucherDateSource === "model" ? input.voucherDate : existing.voucherDate;
  const mergedVoucherDateSource =
    input.voucherDateSource === "model" ? input.voucherDateSource : existing.voucherDateSource;

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
      existing.needsReview || input.needsReview ? 1 : 0,
      input.reimbursementReportId,
    );
  })();

  return selectReportById(input.reimbursementReportId);
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

function mergeReportNotes(left: string, right: string) {
  if (!left) {
    return right;
  }

  if (!right || left === right) {
    return left;
  }

  return `${left}；${right}`;
}
