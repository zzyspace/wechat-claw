import { getDatabase } from "../../core/storage/database.js";
import { aggregateMonthlyRecords, monthlyCategoryTotals, monthlyTotals, MONTHLY_SUMMARY_CATEGORIES, MonthlyReportValidationError, type MonthlyRecord } from "./monthly-report.js";
import { getReimbursementExpenseCategoryLabel } from "./categories.js";

export interface OperatingInput {
  /** Total income; distinct from operating revenue. */
  incomeCents: number | null;
  operatingIncomeCents: number | null;
  dividendCents: number | null;
  allocations: Array<{ name: string; amountCents: number }>;
  note: string;
  revision: number;
}
export interface OperatingRecord extends OperatingInput { updatedAt: string }
export class OperatingConflictError extends Error {}
export function safeOperatingSum(a: number, b: number) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new MonthlyReportValidationError("金额超出安全精度范围。");
  return sum;
}
export function parseOperatingInput(body: unknown): OperatingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MonthlyReportValidationError("请提交有效的经营数据。");
  const input = body as Record<string, unknown>;
  const keys = ["incomeCents", "operatingIncomeCents", "dividendCents", "allocations", "note", "revision"];
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !(key in input))) throw new MonthlyReportValidationError("经营数据字段无效。");
  const amount = (value: unknown, label: string, nullable = true): number | null => {
    if (nullable && value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new MonthlyReportValidationError(`${label}须为非负整数分。`);
    return value;
  };
  const incomeCents = amount(input.incomeCents, "总收入"), dividendCents = amount(input.dividendCents, "总分红");
  if (!Array.isArray(input.allocations) || input.allocations.length > 20) throw new MonthlyReportValidationError("最多支持 20 项分红。");
  const operatingIncomeCents = amount(input.operatingIncomeCents, "营业收入");
  const names = new Set<string>();
  const allocations = input.allocations.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["name", "amountCents"].includes(key)) || typeof value.name !== "string") throw new MonthlyReportValidationError("分红明细无效。");
    const name = value.name.trim();
    if (!name || name.length > 100 || names.has(name)) throw new MonthlyReportValidationError("分红名称不能为空、重复或超过 100 字。");
    names.add(name);
    return { name, amountCents: amount(value.amountCents, "分红金额", false)! };
  });
  const allocated = allocations.reduce((sum, item) => safeOperatingSum(sum, item.amountCents), 0);
  if (allocations.length && dividendCents === null || dividendCents !== null && allocated > dividendCents) throw new MonthlyReportValidationError("请填写总分红，且明细合计不能超过总分红。");
  if (typeof input.note !== "string" || input.note.length > 2000) throw new MonthlyReportValidationError("备注最多 2000 字。");
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER) throw new MonthlyReportValidationError("数据版本无效，请刷新页面。");
  return { incomeCents, operatingIncomeCents, dividendCents, allocations, note: input.note.trim(), revision: input.revision };
}
export function readOperatingRecord(store: string, month: string, currency: string): OperatingRecord | null {
  const row = getDatabase().prepare(`SELECT income_cents AS incomeCents, operating_income_cents AS operatingIncomeCents, dividend_cents AS dividendCents, allocations_json AS allocationsJson,
    note, revision, updated_at AS updatedAt FROM monthly_operating_reports WHERE store_id=? AND month=? AND currency=?`).get(store, month, currency) as (Omit<OperatingRecord, "allocations"> & { allocationsJson: string }) | undefined;
  if (!row) return null;
  const { allocationsJson, ...fields } = row;
  return { ...fields, allocations: JSON.parse(allocationsJson) };
}
export function operatingCurrencies(store: string, month: string): string[] {
  return (getDatabase().prepare("SELECT currency FROM monthly_operating_reports WHERE store_id=? AND month=? ORDER BY currency").all(store, month) as Array<{currency: string}>).map(row => row.currency);
}
export function saveOperatingRecord(store: string, month: string, currency: string, input: OperatingInput, actor: string): OperatingRecord {
  return getDatabase().transaction(() => {
    const current = readOperatingRecord(store, month, currency);
    if ((current?.revision ?? 0) !== input.revision) throw new OperatingConflictError("该月经营数据已被更新，请重新打开编辑后再保存。");
    const updatedAt = new Date().toISOString();
    getDatabase().prepare(`INSERT INTO monthly_operating_reports(store_id,month,currency,income_cents,operating_income_cents,dividend_cents,allocations_json,note,revision,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,month,currency) DO UPDATE SET income_cents=excluded.income_cents,operating_income_cents=excluded.operating_income_cents,dividend_cents=excluded.dividend_cents,
      allocations_json=excluded.allocations_json,note=excluded.note,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(store, month, currency, input.incomeCents, input.operatingIncomeCents, input.dividendCents, JSON.stringify(input.allocations), input.note, input.revision + 1, actor, updatedAt);
    return { ...input, revision: input.revision + 1, updatedAt };
  }).immediate();
}
export function operatingSummary(records: MonthlyRecord[], currency: string, finance: OperatingRecord | null, partial: boolean) {
  const totals = monthlyTotals(aggregateMonthlyRecords(records));
  const total = totals.find(total => total.currency === currency) ?? { currency, amountCents: 0, recordCount: 0, missingAmountCount: 0 };
  const categoryTotals = monthlyCategoryTotals(records);
  const categories = MONTHLY_SUMMARY_CATEGORIES.map(code => categoryTotals.find(c => c.currency === currency && c.code === code) ?? {
    code, label: getReimbursementExpenseCategoryLabel(code), currency, amountCents: 0, recordCount: 0, missingAmountCount: 0,
  });
  const unknownCurrencyCount = totals.find(total => total.currency === "未标注币种")?.recordCount ?? 0;
  const costComplete = !partial && total.missingAmountCount === 0 && unknownCurrencyCount === 0;
  const visibleFinance = partial ? null : finance;
  const income = visibleFinance?.incomeCents ?? null;
  const profitCents = costComplete && income !== null ? safeOperatingSum(income, -total.amountCents) : null;
  const ratio = (cents: number | null) => income !== null && income > 0 && cents !== null ? cents / income * 100 : null;
  const allocatedCents = (visibleFinance?.allocations ?? []).reduce((sum, item) => safeOperatingSum(sum, item.amountCents), 0);
  return { total, categories, finance: visibleFinance, costComplete, unknownCurrencyCount, profitCents,
    costRate: costComplete ? ratio(total.amountCents) : null, profitRate: ratio(profitCents),
    allocatedCents, unallocatedCents: visibleFinance?.dividendCents === null || !visibleFinance ? null : visibleFinance.dividendCents - allocatedCents,
    currencies: totals.map(total => total.currency),
  };
}
export function operatingCsv(report: ReturnType<typeof operatingSummary>, storeName: string, month: string, currency: string) {
  const amount = (value: number | null | undefined) => {
    if (value == null) return "";
    const cents = BigInt(Math.abs(value));
    return `${value < 0 ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  };
  const rows: unknown[][] = [["门店", "月份", "币种", "项目", "金额", "状态"],
    [storeName, month, currency, "总收入", amount(report.finance?.incomeCents), report.finance?.incomeCents == null ? "待录入或无整店权限" : "已录入"],
    [storeName, month, currency, "营业收入", amount(report.finance?.operatingIncomeCents), report.finance?.operatingIncomeCents == null ? "待录入或无整店权限" : "已录入"],
    [storeName, month, currency, "总支出", report.total.recordCount && report.total.recordCount === report.total.missingAmountCount ? "" : amount(report.total.amountCents), report.costComplete ? "完整" : "仅可见或已知金额"],
    ...report.categories.map(c => [storeName, month, currency, c.label, c.recordCount && c.recordCount === c.missingAmountCount ? "" : amount(c.amountCents), c.missingAmountCount ? `${c.missingAmountCount} 笔待确认` : "已知金额"]),
    [storeName, month, currency, "盈利", amount(report.profitCents), report.profitCents === null ? "待录入或待确认" : "总收入减总支出"],
    [storeName, month, currency, "总分红", amount(report.finance?.dividendCents), report.finance?.dividendCents == null ? "待录入或无整店权限" : "已录入"],
    ...(report.finance?.allocations ?? []).map(item => [storeName, month, currency, item.name, amount(item.amountCents), "分红明细"]),
    [storeName, month, currency, "待分配分红", amount(report.unallocatedCents), ""],
    [storeName, month, currency, "备注", "", report.finance?.note ?? ""],
    [storeName, month, currency, "统计提示", "", `${report.unknownCurrencyCount} 笔币种待确认；六类成本与报账月报同源，按创建月份统计`]];
  return "\ufeff" + rows.map(row => row.map((value, index) => {
    let text = String(value ?? "");
    if (!(index === 4 && /^-?\d+(?:\.\d+)?$/.test(text)) && /^[\s]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
}
