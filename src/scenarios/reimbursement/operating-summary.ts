import { getDatabase } from "../../core/storage/database.js";
import { monthlyStoresForScope, monthRange, MonthlyReportValidationError, type MonthlyRecord, type MonthlyScope } from "./monthly-report.js";
import { OPERATING_LIVE_COST_START_MONTH, operatingSummary, safeOperatingSum, type OperatingRecord } from "./operating-report.js";

export const OPERATING_SUMMARY_PERMISSION = "report:operating:summary:view";
export interface OperatingSummaryRow {
  month: string; income: number | null; expense: number | null; profit: number | null;
  dividend: number | null; food: number | null; foodRate: number | null; costRate: number | null;
  allocations: Array<{ name: string; amountCents: number }>;
  unallocatedCents: number | null; note: string; costComplete: boolean; costSource: "historical" | "monthly";
  pendingAmountCount: number; unknownCurrencyCount: number;
}
interface SourceRow { publicRow: OperatingSummaryRow; operatingIncome: number | null }
export function nullableSum(values: Array<number | null>): number | null {
  if (!values.length || values.some(value => value === null)) return null;
  return values.reduce<number>((sum, value) => safeOperatingSum(sum, value!), 0);
}
const ratio = (numerator: number | null, denominator: number | null) => numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator * 100 : null;

export function loadOperatingSummarySource(input: { store: string; minMonth: string; timeZone: string; scope: MonthlyScope }) {
  const store = monthlyStoresForScope(input.scope).find(store => store.id === input.store);
  if (!store) return null;
  const db = getDatabase();
  return db.transaction(() => {
  // Historical operating records describe the whole store, so never even read them for a partial scope.
  const finance = store.partial ? [] : db.prepare(`SELECT month,currency,income_cents AS incomeCents,operating_income_cents AS operatingIncomeCents,
    historical_expense_cents AS historicalExpenseCents,historical_food_cents AS historicalFoodCents,dividend_cents AS dividendCents,
    allocations_json AS allocationsJson,note,revision,updated_at AS updatedAt
    FROM monthly_operating_reports WHERE store_id=? AND month>=? AND month<='2199-12' ORDER BY month`)
    .all(store.id, input.minMonth) as Array<OperatingRecord & { month: string; currency: string; allocationsJson: string }>;
  const finances = new Map<string, Map<string, OperatingRecord>>();
  for (const row of finance) {
    const { month, currency, allocationsJson, ...values } = row;
    const currencies = finances.get(month) ?? new Map<string, OperatingRecord>();
    currencies.set(currency, { ...values, allocations: JSON.parse(allocationsJson) });
    finances.set(month, currencies);
  }
  const fromMonth = input.minMonth > OPERATING_LIVE_COST_START_MONTH ? input.minMonth : OPERATING_LIVE_COST_START_MONTH;
  const params: Record<string, string> = { from: monthRange(fromMonth, input.timeZone).from, to: monthRange("2199-12", input.timeZone).to };
  const channels = store.channels.map((channel, i) => { params[`channel${i}`] = channel; return `@channel${i}`; });
  if (input.scope.submittedByAccountId) params.owner = input.scope.submittedByAccountId;
  const records = db.prepare(`SELECT id,channel_code AS channelCode,reporter,expense_category AS expenseCategory,amount,currency,note,ocr_text AS ocrText,created_at AS createdAt
    FROM reimbursement_reports WHERE channel_code IN (${channels.join(",")}) AND created_at>=@from AND created_at<@to
    ${params.owner ? "AND submitted_by_account_id=@owner" : ""} ORDER BY created_at,id`).all(params) as MonthlyRecord[];
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit" });
  const months = new Map<string, MonthlyRecord[]>();
  for (const row of records) {
    const date = new Date(row.createdAt.includes("T") ? row.createdAt : row.createdAt.replace(" ", "T") + "Z");
    if (!Number.isFinite(date.getTime())) throw new MonthlyReportValidationError("存在无法识别的报账创建时间，请先核对。");
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    const month = `${parts.year}-${parts.month}`;
    if (month < fromMonth || month > "2199-12") continue;
    const bucket = months.get(month) ?? []; bucket.push(row); months.set(month, bucket);
  }
  return { store: { id: store.id, name: store.name, partial: store.partial }, finances, months };
  }).deferred();
}
type SummarySource = NonNullable<ReturnType<typeof loadOperatingSummarySource>>;
export function operatingSummaryOptions(source: SummarySource, defaultYear: string) {
  const years = [...new Set([defaultYear, ...[...source.finances.keys(), ...source.months.keys()].map(month => month.slice(0,4))])].sort().reverse();
  const currencies = new Set<string>(["CNY"]);
  for (const items of source.finances.values()) for (const currency of items.keys()) currencies.add(currency);
  for (const items of source.months.values()) for (const row of items) currencies.add(row.currency.trim().toUpperCase() || "未标注币种");
  return { years, currencies: [...currencies].sort((a,b) => a === "CNY" ? -1 : b === "CNY" ? 1 : a.localeCompare(b)) };
}
export function buildOperatingSummary(source: SummarySource, year: string, currency: string) {
  const allMonths = [...new Set([...source.finances.keys(), ...source.months.keys()])].sort().reverse();
  const items: SourceRow[] = [];
  for (const month of allMonths) {
    if (year !== "all" && !month.startsWith(year + "-")) continue;
    const finance = source.finances.get(month)?.get(currency) ?? null;
    const records = source.months.get(month) ?? [];
    const relevant = records.some(row => (row.currency.trim().toUpperCase() || "未标注币种") === currency || !row.currency.trim());
    if (!finance && !relevant) continue;
    const result = operatingSummary(records, currency, finance, source.store.partial, month);
    const totalUnknown = result.total.recordCount > 0 && result.total.missingAmountCount === result.total.recordCount;
    const foodCategory = result.categories.find(category => category.code === "food");
    const food = !foodCategory || foodCategory.missingAmountCount ? null : foodCategory.amountCents;
    const expense = totalUnknown ? null : result.total.amountCents;
    const operatingIncome = finance?.operatingIncomeCents ?? null;
    const publicRow: OperatingSummaryRow = { month, income: finance?.incomeCents ?? null, expense, profit: result.profitCents,
      dividend: finance?.dividendCents ?? null, food, foodRate: result.unknownCurrencyCount ? null : ratio(food, operatingIncome), costRate: result.costRate,
      allocations: finance?.allocations ?? [], unallocatedCents: result.unallocatedCents, note: finance?.note ?? "", costComplete: result.costComplete,
      costSource: result.costSource === "historical" ? "historical" : "monthly", pendingAmountCount: result.total.missingAmountCount, unknownCurrencyCount: result.unknownCurrencyCount };
    items.push({ publicRow, operatingIncome });
  }
  const rows = items.map(item => item.publicRow);
  const allocationNames = [...new Set(rows.flatMap(row => row.allocations.map(item => item.name)))].sort((a,b) => {
    const rank = (name: string) => name === "LCCZZY" ? 0 : name === "DZG" ? 1 : 2;
    return rank(a)-rank(b) || a.localeCompare(b,"zh-CN");
  });
  const income = nullableSum(rows.map(row => row.income)), expense = nullableSum(rows.map(row => row.expense));
  const food = nullableSum(rows.map(row => row.food));
  const costComplete = rows.length > 0 && rows.every(row => row.costComplete);
  const totals = { income, expense, profit: nullableSum(rows.map(row => row.profit)), dividend: nullableSum(rows.map(row => row.dividend)), food,
    foodRate: rows.some(row => row.unknownCurrencyCount) ? null : ratio(food, nullableSum(items.map(item => item.operatingIncome))),
    costRate: costComplete ? ratio(expense,income) : null,
    allocations: allocationNames.map(name => ({ name, amountCents: nullableSum(rows.map(row => row.dividend === null ? null : row.allocations.find(item => item.name === name)?.amountCents ?? 0)) })),
    unallocatedCents: nullableSum(rows.map(row => row.unallocatedCents)), costComplete, rowCount: rows.length,
    missingIncomeMonths: rows.filter(row => row.income === null).length, pendingCostMonths: rows.filter(row => !row.costComplete).length,
    missingDividendMonths: rows.filter(row => row.dividend === null).length };
  return { rows, totals, allocationNames };
}
export function operatingSummaryCsv(data: ReturnType<typeof buildOperatingSummary>, storeName: string, currency: string) {
  const money = (value: number | null) => { if (value === null) return ""; const n=BigInt(Math.abs(value)); return `${value<0?"-":""}${n/100n}.${String(n%100n).padStart(2,"0")}`; };
  const rate = (value: number | null) => value === null ? "" : value.toFixed(2) + "%";
  const columns = ["门店","月份","币种","总收入","总支出","盈利","总分红",...data.allocationNames,"食材成本","食材占比（占营业收入）","总成本率（占总收入）","成本状态","备注"];
  const rows: unknown[][] = [columns];
  for (const row of data.rows) rows.push([storeName,row.month,currency,money(row.income),money(row.expense),money(row.profit),money(row.dividend),
    ...data.allocationNames.map(name=>money(row.dividend===null?null:row.allocations.find(item=>item.name===name)?.amountCents??0)),money(row.food),rate(row.foodRate),rate(row.costRate),
    row.costComplete?"完整":"仅可见或已知金额，待确认",row.note]);
  if (data.rows.length) { const t=data.totals; rows.push([storeName,"合计",currency,money(t.income),money(t.expense),money(t.profit),money(t.dividend),...t.allocations.map(a=>money(a.amountCents)),money(t.food),rate(t.foodRate),rate(t.costRate),t.costComplete?"完整":"仅可见或已知金额，待确认","合计比率按金额重新计算"]); }
  const monetaryEnd = 7 + data.allocationNames.length;
  return "\ufeff"+rows.map((row,index)=>row.map((value,column)=>{let text=String(value??"");const numeric=index>0&&column>=3&&column<=monetaryEnd&&/^-?\d+(\.\d+)?$/.test(text);
    if(!numeric&&/^[\s]*[=+@-]|^[\t\r\n]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}).join(",")).join("\r\n");
}
