import Database from "better-sqlite3";

import { ensureStateDir, getDatabaseFilePath } from "../runtime/state-paths.js";

let database: Database.Database | null = null;

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_external_id TEXT NOT NULL UNIQUE,
      channel_code TEXT,
      channel_external_id TEXT,
      channel_name TEXT NOT NULL,
      sender_external_id TEXT,
      sender_name TEXT NOT NULL,
      message_type TEXT NOT NULL,
      text_content TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      event_received_at TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL UNIQUE,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_message_id INTEGER NOT NULL,
      attachment_type TEXT NOT NULL,
      local_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mime_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_raw_messages_channel_name
      ON raw_messages(channel_name);

    CREATE INDEX IF NOT EXISTS idx_raw_messages_sent_at
      ON raw_messages(sent_at);

    CREATE INDEX IF NOT EXISTS idx_message_attachments_raw_message_id
      ON message_attachments(raw_message_id);

    CREATE TABLE IF NOT EXISTS scenario_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_message_id INTEGER NOT NULL,
      scenario_code TEXT NOT NULL,
      extractor_code TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id) ON DELETE CASCADE,
      UNIQUE(raw_message_id, scenario_code)
    );

    CREATE INDEX IF NOT EXISTS idx_scenario_extractions_raw_message_id
      ON scenario_extractions(raw_message_id);

    CREATE TABLE IF NOT EXISTS summary_send_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_code TEXT NOT NULL,
      channel_code TEXT NOT NULL,
      target_date TEXT NOT NULL,
      summary_type TEXT NOT NULL DEFAULT 'daily',
      requested_by TEXT NOT NULL DEFAULT 'cli',
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_summary_send_requests_status_id
      ON summary_send_requests(status, id);

    CREATE TABLE IF NOT EXISTS reimbursement_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_code TEXT,
      channel_name TEXT NOT NULL,
      reporter TEXT NOT NULL,
      amount REAL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      expense_category TEXT NOT NULL,
      voucher_date TEXT NOT NULL,
      voucher_date_source TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      evidence_type TEXT NOT NULL,
      merchant TEXT,
      document_no TEXT,
      voucher_type TEXT,
      ocr_text TEXT,
      confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reimbursement_report_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_report_id INTEGER NOT NULL,
      raw_message_id INTEGER NOT NULL UNIQUE,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(reimbursement_report_id) REFERENCES reimbursement_reports(id) ON DELETE CASCADE,
      FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reimbursement_reports_channel_date
      ON reimbursement_reports(channel_code, voucher_date);

    CREATE INDEX IF NOT EXISTS idx_reimbursement_reports_reporter_date
      ON reimbursement_reports(reporter, voucher_date);

    CREATE INDEX IF NOT EXISTS idx_reimbursement_report_sources_report_id
      ON reimbursement_report_sources(reimbursement_report_id);

    CREATE TABLE IF NOT EXISTS reimbursement_receipt_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_report_id INTEGER NOT NULL,
      channel_code TEXT,
      target_type TEXT NOT NULL,
      target_value TEXT NOT NULL,
      receipt_text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      raw_message_id INTEGER UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(reimbursement_report_id) REFERENCES reimbursement_reports(id) ON DELETE CASCADE,
      FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reimbursement_receipt_deliveries_report_id
      ON reimbursement_receipt_deliveries(reimbursement_report_id);

    CREATE INDEX IF NOT EXISTS idx_reimbursement_receipt_deliveries_target_text_sent_at
      ON reimbursement_receipt_deliveries(target_type, target_value, receipt_text, sent_at);
  `);

  const columns = db.prepare(`PRAGMA table_info(raw_messages)`).all() as Array<{ name: string }>;
  const hasEventReceivedAt = columns.some((column) => column.name === "event_received_at");
  const hasChannelCode = columns.some((column) => column.name === "channel_code");
  const summaryRequestColumns = db.prepare(`PRAGMA table_info(summary_send_requests)`).all() as Array<{ name: string }>;
  const hasSummaryType = summaryRequestColumns.some((column) => column.name === "summary_type");

  if (!hasEventReceivedAt) {
    db.exec(`
      ALTER TABLE raw_messages ADD COLUMN event_received_at TEXT NOT NULL DEFAULT '';
      UPDATE raw_messages
      SET event_received_at = COALESCE(NULLIF(sent_at, ''), ingested_at)
      WHERE event_received_at = '';
    `);
  }

  if (!hasChannelCode) {
    db.exec(`
      ALTER TABLE raw_messages ADD COLUMN channel_code TEXT;
    `);
  }

  if (!hasSummaryType) {
    db.exec(`
      ALTER TABLE summary_send_requests ADD COLUMN summary_type TEXT NOT NULL DEFAULT 'daily';
      UPDATE summary_send_requests
      SET summary_type = 'daily'
      WHERE summary_type IS NULL OR summary_type = '';
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_raw_messages_event_received_at
      ON raw_messages(event_received_at);

    CREATE INDEX IF NOT EXISTS idx_raw_messages_channel_code_event_received_at
      ON raw_messages(channel_code, event_received_at);
  `);
}

export function getDatabase() {
  if (database) {
    return database;
  }

  ensureStateDir();
  const databasePath = getDatabaseFilePath();
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  migrate(database);
  return database;
}

export function getDatabasePath() {
  return getDatabaseFilePath();
}
