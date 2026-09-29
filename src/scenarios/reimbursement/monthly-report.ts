import { getDatabase } from "../../core/storage/database.js";
import { getUtcRangeForZonedDate } from "../../core/runtime/timezone.js";
import { getReimbursementExpenseCategoryLabel } from "./categories.js";
import { listAdminBillAttachmentsByReportIds } from "./repository.js";

export const MONTHLY_REPORT_PERMISSION = "report:monthly:view";
export const MONTHLY_STORES = [
  { id: "fuzzy", name: "Fuzzy", channels: ["reimbursement_fuzzy", "reimbursement_fuzzy_manager"] },
  { id: "peanut", name: "Peanut", channels: ["reimbursement_peanut", "reimbursement_peanut_manager"] },
  { id: "fuzzyqz", name: "Fuzzy泉州店", channels: ["reimbursement_fuzzyqz", "reimbursement_fuzzy_qz_manager"] },
] as const;
export const MONTHLY_REPORTERS = ["张志延", "李晨晨", "邓振国"];
export const MONTHLY_PROJECTS = [
  { id: "kuailv", name: "快驴", keywords: ["快驴"], description: "OCR 或备注包含「快驴」" },
  { id: "aomeijia", name: "澳美佳 / 安之乐 / 知其味", keywords: ["澳美佳", "安之乐", "知其味"], description: "命中任一字样，合并为同一项目" },
  { id: "mozan", name: "墨赞", keywords: ["墨赞"], description: "OCR 或备注包含「墨赞」" },
  { id: "other-food", name: "其他食材", keywords: [], description: "未命中任何指定项目的食材报账" },
  { id: "manager", name: "店长报账", keywords: ["店长报账"], description: "类别为店长报账，或 OCR / 备注包含「店长报账」；统一显示为张志延" },
  { id: "rent", name: "房租", keywords: ["房租"], description: "OCR 或备注包含「房租」，排除宿舍房租" },
  { id: "dorm-rent", name: "宿舍房租", keywords: ["宿舍房租"], description: "OCR 或备注包含「宿舍房租」" },
  { id: "utilities", name: "水电", keywords: ["水电"], description: "OCR 或备注包含「水电」" },
  { id: "salary", name: "工资", keywords: ["工资"], description: "OCR 或备注包含「工资」" },
  { id: "unclassified", name: "待归类", keywords: [], description: "未命中指定项目的非食材记录，金额仍计入总额" },
];
export interface MonthlyRecord {
  id: number; reporter: string; expenseCategory: string; amount: number | null; currency: string;
  note: string; ocrText: string | null; createdAt: string;
}
export interface MonthlyScope { submittedByAccountId?: string; allowedChannelCodes?: string[] }
export interface MonthlyGroup {
  projectId: string; project: string; reporter: string; currency: string;
  categories: Array<{ code: string; label: string }>;
  amountCents: number; recordCount: number; missingAmountCount: number;
}
export class MonthlyReportValidationError extends Error {}

export function monthRange(month: string, timeZone: string) {
  if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new MonthlyReportValidationError("请选择有效月份（1900—2199 年）。");
  const [year, number] = month.split("-").map(Number);
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
  const format = (value: string) => new Date(value).toISOString().slice(0, 19).replace("T", " ");
  return {
    from: format(getUtcRangeForZonedDate(`${month}-01`, timeZone).startInclusiveIso),
    to: format(getUtcRangeForZonedDate(`${next}-01`, timeZone).startInclusiveIso),
  };
}
export function monthlyStoresForScope(scope: MonthlyScope) {
  return MONTHLY_STORES.flatMap(store => {
    const channels = store.channels.filter(channel => !scope.allowedChannelCodes || scope.allowedChannelCodes.includes(channel));
    return channels.length ? [{ id: store.id, name: store.name, channels, partial: Boolean(scope.submittedByAccountId) || channels.length !== store.channels.length }] : [];
  });
}
export function classifyMonthlyRecord(record: MonthlyRecord) {
  const texts = [record.ocrText || "", record.note || ""];
  const includes = (word: string) => texts.some(text => text.includes(word));
  if (record.expenseCategory === "manager_reimbursement" || includes("店长报账")) return { projectId: "manager", reporter: "张志延" };
  const dorm = includes("宿舍房租");
  for (const project of MONTHLY_PROJECTS) {
    if (project.id === "manager" || project.id === "rent" && dorm) continue;
    if (project.keywords.some(includes)) return { projectId: project.id, reporter: record.reporter.trim() || "未知" };
  }
  return { projectId: record.expenseCategory === "food" ? "other-food" : "unclassified", reporter: record.reporter.trim() || "未知" };
}
function currencyOf(record: MonthlyRecord) { return record.currency.trim().toUpperCase() || "未标注币种"; }
function toCents(amount: number | null) {
  if (amount === null || !Number.isFinite(amount)) return null;
  const cents = Math.round((Math.abs(amount) + Number.EPSILON) * 100) * Math.sign(amount);
  return Number.isSafeInteger(cents) ? cents : null;
}
function addCents(a: number, b: number) {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new MonthlyReportValidationError("汇总金额超出安全精度范围，请缩小统计范围。");
  return total;
}
export function aggregateMonthlyRecords(records: MonthlyRecord[]): MonthlyGroup[] {
  const groups = new Map<string, MonthlyGroup>();
  for (const record of records) {
    const { projectId, reporter } = classifyMonthlyRecord(record), currency = currencyOf(record);
    const key = JSON.stringify([reporter, projectId, currency]);
    let group = groups.get(key);
    if (!group) {
      group = { projectId, project: MONTHLY_PROJECTS.find(p => p.id === projectId)!.name, reporter, currency, categories: [], amountCents: 0, recordCount: 0, missingAmountCount: 0 };
      groups.set(key, group);
    }
    const cents = currency === "未标注币种" ? null : toCents(record.amount);
    if (cents === null) group.missingAmountCount++;
    else group.amountCents = addCents(group.amountCents, cents);
    group.recordCount++;
    if (!group.categories.some(c => c.code === record.expenseCategory)) group.categories.push({ code: record.expenseCategory, label: getReimbursementExpenseCategoryLabel(record.expenseCategory) });
  }
  const rank = (reporter: string) => { const n = MONTHLY_REPORTERS.indexOf(reporter); return n < 0 ? MONTHLY_REPORTERS.length : n; };
  return [...groups.values()].sort((a, b) => rank(a.reporter) - rank(b.reporter) || a.reporter.localeCompare(b.reporter, "zh-CN") || MONTHLY_PROJECTS.findIndex(p => p.id === a.projectId) - MONTHLY_PROJECTS.findIndex(p => p.id === b.projectId) || a.currency.localeCompare(b.currency));
}
export function monthlyTotals(groups: MonthlyGroup[]) {
  const totals = new Map<string, { currency: string; amountCents: number; recordCount: number; missingAmountCount: number; groupCount: number; projectCount: number }>();
  for (const group of groups) {
    const total = totals.get(group.currency) || { currency: group.currency, amountCents: 0, recordCount: 0, missingAmountCount: 0, groupCount: 0, projectCount: 0 };
    total.amountCents = addCents(total.amountCents, group.amountCents); total.recordCount += group.recordCount; total.missingAmountCount += group.missingAmountCount; total.groupCount++;
    totals.set(group.currency, total);
  }
  for (const total of totals.values()) total.projectCount = new Set(groups.filter(g => g.currency === total.currency && g.projectId !== "unclassified").map(g => g.projectId)).size;
  return [...totals.values()].sort((a, b) => a.currency === "CNY" ? -1 : b.currency === "CNY" ? 1 : a.currency.localeCompare(b.currency));
}
export function readMonthlyRecords(input: { month: string; store: string; timeZone: string; scope: MonthlyScope }) {
  const store = monthlyStoresForScope(input.scope).find(store => store.id === input.store);
  if (!store) return null;
  const range = monthRange(input.month, input.timeZone);
  const params: Record<string, string> = { from: range.from, to: range.to };
  const channels = store.channels.map((channel, index) => { params[`channel${index}`] = channel; return `@channel${index}`; });
  if (input.scope.submittedByAccountId) params.owner = input.scope.submittedByAccountId;
  // Scope is applied before aggregation; never infer ownership from displayed reporter names.
  const records = getDatabase().prepare(`SELECT id, reporter, expense_category AS expenseCategory, amount, currency, note, ocr_text AS ocrText, created_at AS createdAt
    FROM reimbursement_reports WHERE channel_code IN (${channels.join(",")}) AND created_at >= @from AND created_at < @to
    ${input.scope.submittedByAccountId ? "AND submitted_by_account_id = @owner" : ""} ORDER BY created_at ASC, id ASC`).all(params) as MonthlyRecord[];
  return { store, records };
}
export function monthlyDetails(records: MonthlyRecord[], selection: { projectId: string; reporter: string; currency: string; offset: number; limit: number }, canAttachment: boolean) {
  const selected = records.filter(record => {
    const classified = classifyMonthlyRecord(record);
    return classified.projectId === selection.projectId && classified.reporter === selection.reporter && currencyOf(record) === selection.currency;
  });
  const page = selected.slice(selection.offset, selection.offset + selection.limit);
  const attachments = canAttachment ? listAdminBillAttachmentsByReportIds(page.map(record => record.id)) : new Map();
  return { total: selected.length, offset: selection.offset, limit: selection.limit, items: page.map(record => ({
    id: record.id, createdAt: record.createdAt, reporter: record.reporter,
    expenseCategory: record.expenseCategory, expenseCategoryLabel: getReimbursementExpenseCategoryLabel(record.expenseCategory), note: record.note,
    ...(canAttachment ? { billAttachment: attachments.get(record.id) } : {}),
  })) };
}
export function monthlyCsv(groups: MonthlyGroup[]) {
  const quote = (input: unknown, numeric: boolean) => {
    let text = String(input ?? "");
    // A leading apostrophe prevents spreadsheet formulas in user-provided names/categories.
    if (!(numeric && /^-?\d+(?:\.\d+)?$/.test(text)) && /^[\s]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [["项目", "类别", "报账人", "报账笔数", "汇总金额", "币种", "金额待确认笔数"], ...groups.map(g => [g.project, g.categories.map(c => c.label).join(" / "), g.reporter, g.recordCount, g.missingAmountCount === g.recordCount ? "" : (g.amountCents / 100).toFixed(2), g.currency, g.missingAmountCount])];
  for (const total of monthlyTotals(groups)) rows.push(["合计", "", "", total.recordCount, total.missingAmountCount === total.recordCount ? "" : (total.amountCents / 100).toFixed(2), total.currency, total.missingAmountCount]);
  return "\ufeff" + rows.map(row => row.map((value, index) => quote(value, [3, 4, 6].includes(index))).join(",")).join("\r\n");
}
