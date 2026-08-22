import crypto from "node:crypto";

import { getDatabase } from "../../core/storage/database.js";
import type { StoredAttachment } from "../../core/storage/types.js";
import type { ReimbursementAccessPrincipal } from "../../core/config/reimbursement-access.js";

export type BatchImportJobStatus = "queued" | "processing" | "completed";
export type BatchImportItemStatus = "queued" | "processing" | "succeeded" | "failed";

export interface BatchImportTaskItem {
  errorMessage?: string;
  index: number;
  originalName: string;
  reportId?: number;
  status: BatchImportItemStatus;
}

export interface BatchImportTask {
  channelCode: string;
  channelName: string;
  completedCount: number;
  createdAt: string;
  failedCount: number;
  finishedAt?: string;
  id: string;
  items: BatchImportTaskItem[];
  reporter: string;
  submittedByAccountId?: string;
  submittedByUsername?: string;
  submittedByRole?: string;
  sentAt: string;
  startedAt?: string;
  status: BatchImportJobStatus;
  successCount: number;
  timeZone: string;
  totalCount: number;
  updatedAt: string;
}

export interface BatchImportWorkItem {
  attachment: StoredAttachment;
  channelCode: string;
  channelName: string;
  index: number;
  jobId: string;
  note: string;
  originalName: string;
  reporter: string;
  submittedByAccountId?: string;
  submittedByUsername?: string;
  submittedByRole?: string;
  sentAt: string;
  timeZone: string;
}

interface CreateBatchImportTaskInput {
  attachments: StoredAttachment[];
  channelCode: string;
  channelName: string;
  originalNames: string[];
  notes: string[];
  reporter: string;
  sentAt: string;
  submittedBy?: ReimbursementAccessPrincipal;
  timeZone: string;
}

function selectTaskRow(id: string) {
  return getDatabase()
    .prepare(`
      SELECT
        id,
        channel_code as channelCode,
        channel_name as channelName,
        reporter,
        submitted_by_account_id as submittedByAccountId,
        submitted_by_username as submittedByUsername,
        submitted_by_role as submittedByRole,
        sent_at as sentAt,
        time_zone as timeZone,
        status,
        total_count as totalCount,
        completed_count as completedCount,
        success_count as successCount,
        failed_count as failedCount,
        created_at as createdAt,
        started_at as startedAt,
        finished_at as finishedAt,
        updated_at as updatedAt
      FROM reimbursement_batch_import_jobs
      WHERE id = ?
    `)
    .get(id) as
    | Omit<BatchImportTask, "items" | "startedAt" | "finishedAt"> & {
        startedAt: string | null;
        finishedAt: string | null;
      }
    | undefined;
}

export function getBatchImportTask(id: string): BatchImportTask | null {
  const row = selectTaskRow(id);

  if (!row) {
    return null;
  }

  const items = getDatabase()
    .prepare(`
      SELECT
        item_index as 'index',
        original_name as originalName,
        status,
        report_id as reportId,
        error_message as errorMessage
      FROM reimbursement_batch_import_items
      WHERE job_id = ?
      ORDER BY item_index ASC
    `)
    .all(id) as Array<{
      errorMessage: string | null;
      index: number;
      originalName: string;
      reportId: number | null;
      status: BatchImportItemStatus;
    }>;

  return {
    ...row,
    submittedByAccountId: row.submittedByAccountId ?? undefined,
    submittedByUsername: row.submittedByUsername ?? undefined,
    submittedByRole: row.submittedByRole ?? undefined,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    items: items.map((item) => ({
      ...item,
      reportId: item.reportId ?? undefined,
      errorMessage: item.errorMessage ?? undefined,
    })),
  };
}

export function createBatchImportTask(input: CreateBatchImportTaskInput): BatchImportTask {
  if (
    input.attachments.length === 0 ||
    input.originalNames.length !== input.attachments.length ||
    input.notes.length !== input.attachments.length
  ) {
    throw new Error("Batch import task input lengths do not match");
  }

  const db = getDatabase();
  const id = crypto.randomUUID();
  const insertJob = db.prepare(`
    INSERT INTO reimbursement_batch_import_jobs (
      id,
      channel_code,
      channel_name,
      reporter,
      submitted_by_account_id,
      submitted_by_username,
      submitted_by_role,
      sent_at,
      time_zone,
      status,
      total_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO reimbursement_batch_import_items (
      job_id,
      item_index,
      original_name,
      attachment_type,
      local_path,
      sha256,
      mime_type,
      note,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
  `);

  db.transaction(() => {
    insertJob.run(
      id,
      input.channelCode,
      input.channelName,
      input.reporter,
      input.submittedBy?.accountId ?? null,
      input.submittedBy?.username ?? null,
      input.submittedBy?.role ?? null,
      input.sentAt,
      input.timeZone,
      input.attachments.length,
    );
    input.attachments.forEach((attachment, index) => {
      insertItem.run(
        id,
        index,
        input.originalNames[index],
        attachment.type,
        attachment.localPath,
        attachment.sha256,
        attachment.mimeType ?? null,
        input.notes[index],
      );
    });
  })();

  const task = getBatchImportTask(id);
  if (!task) {
    throw new Error("Batch import task was not persisted");
  }
  return task;
}

export function claimNextBatchImportWorkItem(jobId: string): BatchImportWorkItem | null {
  const db = getDatabase();

  return db.transaction(() => {
    const job = selectTaskRow(jobId);

    if (!job || job.status === "completed") {
      return null;
    }

    const item = db
      .prepare(`
        SELECT
          item_index as 'index',
          original_name as originalName,
          attachment_type as attachmentType,
          local_path as localPath,
          sha256,
          mime_type as mimeType,
          note
        FROM reimbursement_batch_import_items
        WHERE job_id = ? AND status = 'queued'
        ORDER BY item_index ASC
        LIMIT 1
      `)
      .get(jobId) as
      | {
          attachmentType: string;
          index: number;
          localPath: string;
          mimeType: string | null;
          note: string;
          originalName: string;
          sha256: string;
        }
      | undefined;

    if (!item) {
      return null;
    }

    db.prepare(`
      UPDATE reimbursement_batch_import_jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(jobId);
    db.prepare(`
      UPDATE reimbursement_batch_import_items
      SET status = 'processing',
          started_at = COALESCE(started_at, datetime('now')),
          error_message = NULL,
          updated_at = datetime('now')
      WHERE job_id = ? AND item_index = ? AND status = 'queued'
    `).run(jobId, item.index);

    return {
      attachment: {
        type: item.attachmentType,
        localPath: item.localPath,
        sha256: item.sha256,
        mimeType: item.mimeType ?? undefined,
      },
      channelCode: job.channelCode,
      channelName: job.channelName,
      index: item.index,
      jobId,
      note: item.note,
      originalName: item.originalName,
      reporter: job.reporter,
      submittedByAccountId: job.submittedByAccountId,
      submittedByUsername: job.submittedByUsername,
      submittedByRole: job.submittedByRole,
      sentAt: job.sentAt,
      timeZone: job.timeZone,
    };
  })();
}

function refreshTaskCounts(jobId: string) {
  const db = getDatabase();
  db.prepare(`
    UPDATE reimbursement_batch_import_jobs
    SET completed_count = (
          SELECT COUNT(*) FROM reimbursement_batch_import_items
          WHERE job_id = ? AND status IN ('succeeded', 'failed')
        ),
        success_count = (
          SELECT COUNT(*) FROM reimbursement_batch_import_items
          WHERE job_id = ? AND status = 'succeeded'
        ),
        failed_count = (
          SELECT COUNT(*) FROM reimbursement_batch_import_items
          WHERE job_id = ? AND status = 'failed'
        ),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(jobId, jobId, jobId, jobId);
}

export function markBatchImportItemSucceeded(jobId: string, index: number, reportId: number) {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      UPDATE reimbursement_batch_import_items
      SET status = 'succeeded',
          report_id = ?,
          error_message = NULL,
          finished_at = datetime('now'),
          updated_at = datetime('now')
      WHERE job_id = ? AND item_index = ?
    `).run(reportId, jobId, index);
    refreshTaskCounts(jobId);
  })();
}

export function markBatchImportItemFailed(jobId: string, index: number, errorMessage: string) {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      UPDATE reimbursement_batch_import_items
      SET status = 'failed',
          error_message = ?,
          finished_at = datetime('now'),
          updated_at = datetime('now')
      WHERE job_id = ? AND item_index = ?
    `).run(errorMessage.slice(0, 1000), jobId, index);
    refreshTaskCounts(jobId);
  })();
}

export function finalizeBatchImportTask(jobId: string): BatchImportTask | null {
  const db = getDatabase();
  db.transaction(() => {
    refreshTaskCounts(jobId);
    db.prepare(`
      UPDATE reimbursement_batch_import_jobs
      SET status = 'completed',
          finished_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM reimbursement_batch_import_items
          WHERE job_id = ? AND status IN ('queued', 'processing')
        )
    `).run(jobId, jobId);
  })();
  return getBatchImportTask(jobId);
}

export function recoverInterruptedBatchImportTasks(): string[] {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`
      UPDATE reimbursement_batch_import_items
      SET status = 'queued',
          updated_at = datetime('now')
      WHERE status = 'processing'
    `).run();
    db.prepare(`
      UPDATE reimbursement_batch_import_jobs
      SET status = 'queued',
          updated_at = datetime('now')
      WHERE status = 'processing'
    `).run();
  })();

  return (db
    .prepare(`
      SELECT id
      FROM reimbursement_batch_import_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
    `)
    .all() as Array<{ id: string }>).map((row) => row.id);
}
