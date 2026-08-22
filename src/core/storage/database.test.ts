import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase } from "./database.js";

test("migrateDatabase adds reimbursement submitter audit columns to existing databases", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE reimbursement_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_code TEXT,
      channel_name TEXT NOT NULL,
      reporter TEXT NOT NULL,
      voucher_date TEXT NOT NULL
    );
    CREATE TABLE reimbursement_batch_import_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateDatabase(db);

  const reportColumns = new Set(
    (db.prepare("PRAGMA table_info(reimbursement_reports)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const taskColumns = new Set(
    (db.prepare("PRAGMA table_info(reimbursement_batch_import_jobs)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const column of ["submitted_by_account_id", "submitted_by_username", "submitted_by_role"]) {
    assert.equal(reportColumns.has(column), true);
    assert.equal(taskColumns.has(column), true);
  }
  const indexes = db.prepare("PRAGMA index_list(reimbursement_reports)").all() as Array<{ name: string }>;
  assert.equal(indexes.some((index) => index.name === "idx_reimbursement_reports_submitter_channel"), true);
  db.close();
});
