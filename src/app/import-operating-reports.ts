import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { getDatabase } from "../core/storage/database.js";
import { MONTHLY_STORES, monthRange } from "../scenarios/reimbursement/monthly-report.js";
import { OPERATING_LIVE_COST_START_MONTH, parseOperatingInput, readOperatingRecord, safeOperatingSum, saveOperatingRecord, type OperatingInput } from "../scenarios/reimbursement/operating-report.js";

export interface OperatingImportEntry { store: string; month: string; currency: string; values: OperatingInput }
export function validateOperatingImport(document: unknown): OperatingImportEntry[] {
  if (!Array.isArray(document) || !document.length || document.length > 1000) throw new Error("导入文件须包含 1–1000 条记录。");
  const keys = new Set<string>();
  return document.map(row => {
    if (!row || typeof row !== "object" || Object.keys(row).some(key => !["store", "month", "currency", "values"].includes(key)) ||
      !MONTHLY_STORES.some(store => store.id === row.store) || row.currency !== "CNY" || typeof row.month !== "string") throw new Error("导入记录的门店、月份或币种无效。");
    monthRange(row.month, "Asia/Shanghai");
    const key = `${row.store}/${row.month}/${row.currency}`;
    if (keys.has(key)) throw new Error(`重复记录：${key}`);
    keys.add(key);
    const values = parseOperatingInput(row.values);
    if (values.revision !== 0 || values.incomeCents === null || values.dividendCents === null) throw new Error(`导入需要完整金额及初始版本：${key}`);
    if (row.month < OPERATING_LIVE_COST_START_MONTH && values.historicalExpenseCents == null) throw new Error(`历史成本缺失：${key}`);
    if (row.month >= OPERATING_LIVE_COST_START_MONTH && (values.historicalExpenseCents != null || values.historicalFoodCents != null)) throw new Error(`9 月起使用实时成本，不导入历史成本覆盖值：${key}`);
    if (values.allocations.reduce((sum, item) => safeOperatingSum(sum, item.amountCents), 0) !== values.dividendCents) throw new Error(`分红合计不一致：${key}`);
    return { store: row.store, month: row.month, currency: row.currency, values };
  });
}
function comparable(values: OperatingInput) {
  return JSON.stringify([values.incomeCents, values.operatingIncomeCents, values.historicalExpenseCents ?? null, values.historicalFoodCents ?? null,
    values.dividendCents, values.allocations, values.note]);
}
function sameRaw(raw: any, values: OperatingInput) {
  return comparable({ incomeCents: raw.income_cents, operatingIncomeCents: raw.operating_income_cents ?? null, historicalExpenseCents: raw.historical_expense_cents ?? null,
    historicalFoodCents: raw.historical_food_cents ?? null, dividendCents: raw.dividend_cents, allocations: JSON.parse(raw.allocations_json), note: raw.note, revision: raw.revision }) === comparable(values);
}
export function planOperatingImport(db: Database.Database, entries: OperatingImportEntry[]) {
  let insert = 0, unchanged = 0;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monthly_operating_reports'").get();
  for (const entry of entries) {
    const current = exists ? db.prepare("SELECT * FROM monthly_operating_reports WHERE store_id=? AND month=? AND currency=?").get(entry.store, entry.month, entry.currency) : null;
    if (!current) insert++;
    else if (sameRaw(current, entry.values)) unchanged++;
    else throw new Error(`已有记录与导入内容不同，未覆盖：${entry.store}/${entry.month}/${entry.currency}`);
  }
  return { insert, unchanged, total: entries.length };
}
export function applyOperatingImport(entries: OperatingImportEntry[], actor: string) {
  const db = getDatabase();
  return db.transaction(() => {
    const plan = planOperatingImport(db, entries);
    for (const entry of entries) {
      if (!readOperatingRecord(entry.store, entry.month, entry.currency)) saveOperatingRecord(entry.store, entry.month, entry.currency, entry.values, actor);
    }
    for (const entry of entries) {
      const saved = readOperatingRecord(entry.store, entry.month, entry.currency);
      if (!saved || comparable(saved) !== comparable(entry.values)) throw new Error("导入后逐字段校验失败，事务回滚。");
    }
    return plan;
  }).immediate();
}
function main() {
  const args = process.argv.slice(2), flags = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { apply = true; continue; }
    if (!["--input", "--state-dir", "--expected-sha256", "--expected-count"].includes(args[i]) || !args[i + 1]) throw new Error("参数无效。");
    flags.set(args[i], args[++i]);
  }
  const input = flags.get("--input"), stateDir = flags.get("--state-dir");
  if (!input || !stateDir) throw new Error("必须指定 --input 和 --state-dir；默认只预检。");
  const bytes = fs.readFileSync(input), hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (flags.has("--expected-sha256") && flags.get("--expected-sha256") !== hash) throw new Error("导入文件哈希不匹配。");
  const entries = validateOperatingImport(JSON.parse(bytes.toString("utf8")));
  if (flags.has("--expected-count") && Number(flags.get("--expected-count")) !== entries.length) throw new Error("导入条数不匹配。");
  if (apply && (!flags.has("--expected-sha256") || !flags.has("--expected-count"))) throw new Error("实际导入必须指定核对后的哈希与条数。");
  process.env.WECHATY_STATE_DIR = path.resolve(stateDir);
  if (!apply) {
    const db = new Database(path.join(stateDir, "wechat-claw.sqlite"), { readonly: true, fileMustExist: true });
    try { console.log(JSON.stringify({ mode: "preview", sha256: hash, ...planOperatingImport(db, entries) })); } finally { db.close(); }
  } else console.log(JSON.stringify({ mode: "applied", sha256: hash, ...applyOperatingImport(entries, `manual-import:${hash.slice(0,16)}`) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
