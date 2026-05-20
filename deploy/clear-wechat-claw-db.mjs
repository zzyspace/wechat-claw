#!/usr/bin/env node

import Database from "better-sqlite3";

function usage() {
  console.error(`Usage:
  node deploy/clear-wechat-claw-db.mjs counts --db-path <path>
  node deploy/clear-wechat-claw-db.mjs clear --db-path <path> [--backup-path <path>]`);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  let dbPath = "";
  let backupPath = "";

  if (action !== "counts" && action !== "clear") {
    usage();
    process.exit(1);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--db-path") {
      dbPath = rest[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--backup-path") {
      backupPath = rest[index + 1] ?? "";
      index += 1;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }

  if (!dbPath) {
    console.error("Missing required argument: --db-path");
    usage();
    process.exit(1);
  }

  return { action, dbPath, backupPath };
}

function printCounts(db) {
  const rows = db.prepare(`
    SELECT 'raw_messages' AS table_name, COUNT(*) AS row_count FROM raw_messages
    UNION ALL
    SELECT 'message_attachments', COUNT(*) FROM message_attachments
    UNION ALL
    SELECT 'scenario_extractions', COUNT(*) FROM scenario_extractions
    UNION ALL
    SELECT 'summary_send_requests', COUNT(*) FROM summary_send_requests;
  `).all();

  for (const row of rows) {
    console.log(`${row.table_name}|${row.row_count}`);
  }
}

async function clearDatabase(db, backupPath) {
  console.log("[clear-db] Row counts before clear");
  printCounts(db);

  if (backupPath) {
    console.log("[clear-db] Creating SQLite backup");
    await db.backup(backupPath);
  }

  console.log("[clear-db] Clearing SQLite tables");
  db.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM scenario_extractions;
    DELETE FROM message_attachments;
    DELETE FROM raw_messages;
    DELETE FROM summary_send_requests;
    COMMIT;
  `);

  const hasSequenceTable = db.prepare(`
    SELECT COUNT(*) AS row_count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'sqlite_sequence';
  `).get();

  if (hasSequenceTable?.row_count === 1) {
    console.log("[clear-db] Resetting AUTOINCREMENT counters");
    db.prepare(`
      DELETE FROM sqlite_sequence
      WHERE name IN ('raw_messages', 'message_attachments', 'scenario_extractions', 'summary_send_requests');
    `).run();
  }

  console.log("[clear-db] Checkpointing WAL and compacting database");
  db.exec(`
    PRAGMA wal_checkpoint(TRUNCATE);
    VACUUM;
  `);

  console.log("[clear-db] Row counts after clear");
  printCounts(db);
}

const { action, dbPath, backupPath } = parseArgs(process.argv.slice(2));
const db = new Database(dbPath, { fileMustExist: true });

try {
  if (action === "counts") {
    printCounts(db);
  } else {
    await clearDatabase(db, backupPath);
  }
} finally {
  db.close();
}
