import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateMonthlyRecords, classifyMonthlyRecord, monthRange, monthlyCsv, monthlyStoresForScope, monthlyTotals, type MonthlyRecord } from "./monthly-report.js";
const row = (overrides: Partial<MonthlyRecord> = {}): MonthlyRecord => ({ id: 1, reporter: "张志延", expenseCategory: "food", amount: 10, currency: "CNY", note: "", ocrText: "", createdAt: "2026-09-01 00:00:00", ...overrides });
test("project rules use OCR or notes and resolve overlapping matches without duplicates", () => {
  for (const text of ["澳美佳", "安之乐", "知其味"]) assert.equal(classifyMonthlyRecord(row({ ocrText: text })).projectId, "aomeijia");
  assert.equal(classifyMonthlyRecord(row({ note: "墨赞采购" })).projectId, "mozan");
  assert.equal(classifyMonthlyRecord(row({ ocrText: "快驴 墨赞" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row({ note: "宿舍房租", expenseCategory: "rent" })).projectId, "dorm-rent");
  assert.equal(classifyMonthlyRecord(row({ note: "快驴 宿舍房租" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row()).projectId, "other-food");
  assert.equal(classifyMonthlyRecord(row({ expenseCategory: "other" })).projectId, "unclassified");
  for (const record of [row({ reporter:"李晨晨", expenseCategory:"manager_reimbursement", note:"快驴" }), row({ reporter:"邓振国", ocrText:"店长报账 宿舍房租" })]) {
    assert.deepEqual(classifyMonthlyRecord(record), { projectId:"manager", reporter:"张志延" });
    assert.notEqual(record.reporter, "张志延");
  }
});
test("reporter order precedes project order, categories merge and currencies never mix", () => {
  const records = [row({ reporter:"邓振国", note:"快驴" }), row({ note:"工资", expenseCategory:"salary" }), row({ reporter:"李晨晨", note:"澳美佳" }), row({ note:"快驴", amount:0.1 }), row({ note:"快驴", expenseCategory:"other", amount:0.2 }), row({ reporter:"其他", note:"快驴" }), row({ note:"快驴", currency:"USD", amount:8 })];
  const groups=aggregateMonthlyRecords(records);
  assert.deepEqual(groups.map(g=>[g.reporter,g.projectId,g.currency]), [["张志延","kuailv","CNY"],["张志延","kuailv","USD"],["张志延","salary","CNY"],["李晨晨","aomeijia","CNY"],["邓振国","kuailv","CNY"],["其他","kuailv","CNY"]]);
  assert.equal(groups[0].amountCents,30);assert.equal(groups[0].categories.length,2);
  assert.deepEqual(monthlyTotals(groups).map(t=>[t.currency,t.amountCents,t.recordCount]),[["CNY",4030,6],["USD",800,1]]);
});
test("missing amounts remain visible, negative corrections count and unsafe totals fail", () => {
  const groups=aggregateMonthlyRecords([row({amount:null}),row({amount:-1.25}),row({amount:0})]);
  assert.equal(groups[0].missingAmountCount,1);assert.equal(groups[0].recordCount,3);assert.equal(groups[0].amountCents,-125);
  const invalid=aggregateMonthlyRecords([row({amount:Infinity}),row({amount:Number.MAX_SAFE_INTEGER})]);assert.equal(invalid[0].missingAmountCount,2);
  assert.throws(()=>aggregateMonthlyRecords([row({amount:8e13}),row({amount:8e13})]),/安全精度/);
});
test("month boundaries use Shanghai time and reject malformed months", () => {
  assert.deepEqual(monthRange("2026-09","Asia/Shanghai"),{from:"2026-08-31 16:00:00",to:"2026-09-30 16:00:00"});
  assert.deepEqual(monthRange("2024-02","Asia/Shanghai"),{from:"2024-01-31 16:00:00",to:"2024-02-29 16:00:00"});
  assert.equal(monthRange("2026-12","Asia/Shanghai").to,"2026-12-31 16:00:00");
  for(const month of ["2026-00","2026-13","2026-9","2026-09' OR 1=1",""])assert.throws(()=>monthRange(month,"Asia/Shanghai"));
});
test("store options intersect scope and CSV protects spreadsheet formulas", () => {
  assert.deepEqual(monthlyStoresForScope({allowedChannelCodes:[]}),[]);
  const stores=monthlyStoresForScope({allowedChannelCodes:["reimbursement_fuzzy_manager"],submittedByAccountId:"owner"});assert.equal(stores.length,1);assert.equal(stores[0].partial,true);
  const csv=monthlyCsv(aggregateMonthlyRecords([row({reporter:'=HYPERLINK("bad")',amount:null}),row({reporter:" +formula",note:"快驴"})]));
  assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes("'+formula"));assert.ok(csv.includes('"金额待确认笔数"'));
});

test("CSV keeps negative corrections numeric and missing currency cannot enter a known total", () => {
  const csv=monthlyCsv(aggregateMonthlyRecords([row({amount:-1.25,reporter:"-formula"})]));
  assert.ok(csv.includes('"-1.25"'));assert.ok(csv.includes("'-formula"));
  const unknown=aggregateMonthlyRecords([row({currency:"",amount:50})]);assert.equal(unknown[0].missingAmountCount,1);assert.equal(unknown[0].amountCents,0);
});
