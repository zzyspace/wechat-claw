import { getDatabase } from "../storage/database.js";

export type SummarySendRequestStatus = "pending" | "processing" | "sent" | "failed";
export type SummarySendRequestType = "daily" | "weekly";

export interface SummarySendRequestRecord {
  channelCode: string;
  createdAt: string;
  errorMessage?: string;
  finishedAt?: string;
  id: number;
  requestedBy: string;
  scenarioCode: string;
  summaryType: SummarySendRequestType;
  startedAt?: string;
  status: SummarySendRequestStatus;
  targetDate: string;
}

export interface CreateSummarySendRequestInput {
  channelCode: string;
  requestedBy: string;
  scenarioCode: string;
  summaryType: SummarySendRequestType;
  targetDate: string;
}

interface SummarySendRequestRow {
  channelCode: string;
  createdAt: string;
  errorMessage: string | null;
  finishedAt: string | null;
  id: number;
  requestedBy: string;
  scenarioCode: string;
  summaryType: SummarySendRequestType;
  startedAt: string | null;
  status: SummarySendRequestStatus;
  targetDate: string;
}

function mapRow(row: SummarySendRequestRow | undefined): SummarySendRequestRecord | null {
  if (!row) {
    return null;
  }

  return {
    channelCode: row.channelCode,
    createdAt: row.createdAt,
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    id: row.id,
    requestedBy: row.requestedBy,
    scenarioCode: row.scenarioCode,
    summaryType: row.summaryType,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    status: row.status,
    targetDate: row.targetDate,
  };
}

function getRequestRowById(id: number): SummarySendRequestRow | undefined {
  const db = getDatabase();

  return db
    .prepare(`
      SELECT
        id,
        scenario_code as scenarioCode,
        channel_code as channelCode,
        target_date as targetDate,
        summary_type as summaryType,
        requested_by as requestedBy,
        status,
        error_message as errorMessage,
        created_at as createdAt,
        started_at as startedAt,
        finished_at as finishedAt
      FROM summary_send_requests
      WHERE id = ?
    `)
    .get(id) as SummarySendRequestRow | undefined;
}

export function createSummarySendRequest(input: CreateSummarySendRequestInput): SummarySendRequestRecord {
  const db = getDatabase();
  const result = db
    .prepare(`
      INSERT INTO summary_send_requests (
        scenario_code,
        channel_code,
        target_date,
        summary_type,
        requested_by,
        status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
    `)
    .run(
      input.scenarioCode,
      input.channelCode,
      input.targetDate,
      input.summaryType,
      input.requestedBy,
    );

  const request = getSummarySendRequestById(Number(result.lastInsertRowid));

  if (!request) {
    throw new Error("Summary send request was not persisted");
  }

  return request;
}

export function getSummarySendRequestById(id: number): SummarySendRequestRecord | null {
  return mapRow(getRequestRowById(id));
}

export function listPendingSummarySendRequests(limit = 10): SummarySendRequestRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(`
      SELECT
        id,
        scenario_code as scenarioCode,
        channel_code as channelCode,
        target_date as targetDate,
        summary_type as summaryType,
        requested_by as requestedBy,
        status,
        error_message as errorMessage,
        created_at as createdAt,
        started_at as startedAt,
        finished_at as finishedAt
      FROM summary_send_requests
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(limit) as SummarySendRequestRow[];

  return rows.map((row) => mapRow(row)).filter((row): row is SummarySendRequestRecord => Boolean(row));
}

export function claimSummarySendRequest(id: number): SummarySendRequestRecord | null {
  const db = getDatabase();
  const result = db
    .prepare(`
      UPDATE summary_send_requests
      SET
        status = 'processing',
        started_at = datetime('now'),
        finished_at = NULL,
        error_message = NULL
      WHERE id = ? AND status = 'pending'
    `)
    .run(id);

  if (result.changes === 0) {
    return null;
  }

  return getSummarySendRequestById(id);
}

export function markSummarySendRequestSent(id: number): SummarySendRequestRecord {
  const db = getDatabase();
  db.prepare(`
    UPDATE summary_send_requests
    SET
      status = 'sent',
      finished_at = datetime('now'),
      error_message = NULL
    WHERE id = ?
  `).run(id);

  const request = getSummarySendRequestById(id);

  if (!request) {
    throw new Error(`Summary send request not found: ${id}`);
  }

  return request;
}

export function markSummarySendRequestFailed(id: number, errorMessage: string): SummarySendRequestRecord {
  const db = getDatabase();
  db.prepare(`
    UPDATE summary_send_requests
    SET
      status = 'failed',
      finished_at = datetime('now'),
      error_message = ?
    WHERE id = ?
  `).run(errorMessage, id);

  const request = getSummarySendRequestById(id);

  if (!request) {
    throw new Error(`Summary send request not found: ${id}`);
  }

  return request;
}
