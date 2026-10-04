import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateDatabase } from "./database.js";

test("operating revenue migration preserves the total and leaves the new revenue unset", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE monthly_operating_reports (
    store_id TEXT, month TEXT, currency TEXT, income_cents INTEGER, dividend_cents INTEGER,
    allocations_json TEXT, note TEXT, revision INTEGER, updated_by TEXT, updated_at TEXT,
    PRIMARY KEY (store_id, month, currency));
    INSERT INTO monthly_operating_reports VALUES('fuzzy','2026-09','CNY',30000000,5000000,'[]','original',3,'fixture','before');`);
  migrateDatabase(db);
  migrateDatabase(db);
  assert.deepEqual(db.prepare("SELECT income_cents,operating_income_cents,revision,note FROM monthly_operating_reports").get(),
    { income_cents: 30000000, operating_income_cents: null, revision: 3, note: "original" });
  db.close();
});

test("migrateDatabase adds reimbursement submitter audit columns to existing databases", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE reimbursement_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_code TEXT,
      channel_name TEXT NOT NULL,
      reporter TEXT NOT NULL,
      voucher_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  for (const column of ["submitted_by_account_id", "submitted_by_username", "submitted_by_display_name", "submitted_by_role"]) {
    assert.equal(reportColumns.has(column), true);
    assert.equal(taskColumns.has(column), true);
  }
  const indexes = db.prepare("PRAGMA index_list(reimbursement_reports)").all() as Array<{ name: string }>;
  assert.equal(indexes.some((index) => index.name === "idx_reimbursement_reports_submitter_channel"), true);
  assert.equal(indexes.some((index) => index.name === "idx_reimbursement_reports_channel_created_at"), true);
  migrateDatabase(db); // Index creation is safe to repeat on existing databases.
  db.close();
});
