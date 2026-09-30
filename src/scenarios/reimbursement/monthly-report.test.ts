import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateMonthlyRecords, classifyMonthlyRecord, monthRange, monthlyCsv, monthlyStoresForScope, monthlyTotals, type MonthlyRecord } from "./monthly-report.js";
const row = (overrides: Partial<MonthlyRecord> = {}): MonthlyRecord => ({ id: 1, channelCode: "reimbursement_fuzzy", reporter: "张志延", expenseCategory: "food", amount: 10, currency: "CNY", note: "", ocrText: "", createdAt: "2026-09-01 00:00:00", ...overrides });
test("project rules use OCR or notes and resolve overlapping matches without duplicates", () => {
  for (const text of ["澳美佳", "安之乐", "知其味", "恰沐阳"]) {
    assert.equal(classifyMonthlyRecord(row({ ocrText: `${text}食品配送` })).projectId, "aomeijia");
    assert.equal(classifyMonthlyRecord(row({ note: `支付${text}货款` })).projectId, "aomeijia");
  }
  assert.equal(classifyMonthlyRecord(row({ note: "墨赞采购" })).projectId, "mozan");
  assert.equal(classifyMonthlyRecord(row({ ocrText: "快驴 墨赞" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row({ note: "宿舍房租", expenseCategory: "rent" })).projectId, "dorm-rent");
  assert.equal(classifyMonthlyRecord(row({ note: "快驴 宿舍房租" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row()).projectId, "other-food");
  assert.equal(classifyMonthlyRecord(row({ expenseCategory: "other" })).projectId, "other");

});
test("Qiamuyang merges into the existing supplier project and preserves higher priority rules", () => {
  const groups = aggregateMonthlyRecords([
    row({ id: 1, ocrText: "澳美佳配送", amount: 10 }),
    row({ id: 2, ocrText: "恰沐阳食品配送", amount: 20 }),
    row({ id: 3, note: "恰沐阳货款", amount: 30 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].projectId, "aomeijia");
  assert.equal(groups[0].project, "澳美佳 / 安之乐 / 知其味");
  assert.equal(groups[0].recordCount, 3);
  assert.equal(groups[0].amountCents, 6000);
  assert.equal(classifyMonthlyRecord(row({ note: "快驴 恰沐阳" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row({ note: "恰沐阳", channelCode: "reimbursement_fuzzy_manager" })).projectId, "manager");
  assert.equal(classifyMonthlyRecord(row({ ocrText: "恰沐阳", expenseCategory: "flower" })).projectId, "flower");
});
test("Jinhui and Jingzhou match OCR or notes and follow the requested project order", () => {
  for (const [name, projectId] of [["金辉", "jinhui"], ["景洲", "jingzhou"]]) {
    assert.equal(classifyMonthlyRecord(row({ ocrText: `${name}食品配送` })).projectId, projectId);
    assert.equal(classifyMonthlyRecord(row({ note: `支付${name}货款`, ocrText: null })).projectId, projectId);
    assert.equal(classifyMonthlyRecord(row({ note: name, channelCode: "reimbursement_fuzzy_manager" })).projectId, "manager");
    assert.equal(classifyMonthlyRecord(row({ ocrText: name, expenseCategory: "flower" })).projectId, "flower");
  }
  assert.equal(classifyMonthlyRecord(row({ note: "快驴 金辉" })).projectId, "kuailv");
  assert.equal(classifyMonthlyRecord(row({ ocrText: "金辉 澳美佳" })).projectId, "jinhui");
  assert.equal(classifyMonthlyRecord(row({ note: "澳美佳 景洲" })).projectId, "aomeijia");
  assert.equal(classifyMonthlyRecord(row({ note: "景洲 墨赞" })).projectId, "jingzhou");
  const groups = aggregateMonthlyRecords(["墨赞", "景洲", "澳美佳", "金辉", "快驴"].map((note, index) => row({ id: index + 1, note })));
  assert.deepEqual(groups.map(group => group.project), ["快驴", "金辉", "澳美佳 / 安之乐 / 知其味", "景洲", "墨赞"]);
  assert.equal(monthlyTotals(groups)[0].amountCents, 5000);
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


test("manager grouping depends only on exact source channels and takes precedence", () => {
  for (const channelCode of ["reimbursement_fuzzy_manager", "reimbursement_peanut_manager", "reimbursement_fuzzy_qz_manager"]) {
    for (const fields of [{ expenseCategory: "food", note: "快驴" }, { expenseCategory: "rent", note: "宿舍房租" }, { expenseCategory: "other", note: "", ocrText: null }]) {
      const record = row({ ...fields, channelCode, reporter: "李晨晨" });
      assert.deepEqual(classifyMonthlyRecord(record), { projectId: "manager", reporter: "张志延" });
      assert.equal(record.reporter, "李晨晨");
    }
  }
  for (const channelCode of ["reimbursement_fuzzy", "reimbursement_peanut", "reimbursement_fuzzyqz", "unknown_manager", null]) {
    assert.equal(classifyMonthlyRecord(row({ channelCode, expenseCategory: "manager_reimbursement", note: "店长报账", ocrText: "店长报账群" })).projectId, "other");
    assert.equal(classifyMonthlyRecord(row({ channelCode, note: "店长报账 快驴" })).projectId, "kuailv");
  }
});

test("rent, utilities and salary fall back to category after named project matching", () => {
  for (const [expenseCategory, projectId] of [["rent", "rent"], ["utilities", "utilities"], ["salary", "salary"]]) {
    assert.equal(classifyMonthlyRecord(row({ expenseCategory, note: "", ocrText: null })).projectId, projectId);
    assert.equal(classifyMonthlyRecord(row({ expenseCategory, note: "快驴" })).projectId, "kuailv");
  }
  assert.equal(classifyMonthlyRecord(row({ expenseCategory: "rent", note: "宿舍房租" })).projectId, "dorm-rent");
  for (const expenseCategory of ["constructor", "__proto__", "unknown"]) assert.equal(classifyMonthlyRecord(row({ expenseCategory })).projectId, "other");
  const groups = aggregateMonthlyRecords([
    row({ id: 1, channelCode: "reimbursement_fuzzy_manager", amount: 20, reporter: "李晨晨" }),
    row({ id: 2, channelCode: "reimbursement_fuzzy_manager", amount: 30, reporter: "邓振国", expenseCategory: "salary" }),
    row({ id: 3, expenseCategory: "rent", amount: 40 }),
  ]);
  assert.deepEqual(groups.map(g => [g.projectId, g.reporter, g.amountCents, g.recordCount]), [["manager", "张志延", 5000, 2], ["rent", "张志延", 4000, 1]]);
});

test("flowers use category only, after manager source and before keyword matches", () => {
  for (const note of ["", "快驴", "工资", "宿舍房租"]) assert.equal(classifyMonthlyRecord(row({expenseCategory:"flower",note})).projectId,"flower");
  assert.equal(classifyMonthlyRecord(row({expenseCategory:"other",note:"花卉",ocrText:"鲜花"})).projectId,"other");
  assert.equal(classifyMonthlyRecord(row({expenseCategory:"food",note:"花卉"})).projectId,"other-food");
  assert.deepEqual(classifyMonthlyRecord(row({expenseCategory:"flower",channelCode:"reimbursement_fuzzy_manager",reporter:"李晨晨"})),{projectId:"manager",reporter:"张志延"});
  const groups=aggregateMonthlyRecords([row({expenseCategory:"other",amount:3}),row({expenseCategory:"planned_expense",amount:4}),row({expenseCategory:"flower",amount:5}),row({expenseCategory:"salary",amount:6})]);
  assert.deepEqual(groups.map(g=>g.projectId),["salary","flower","other"]);
  assert.equal(groups[2].recordCount,2);assert.equal(groups[2].amountCents,700);
  assert.equal(monthlyTotals(groups)[0].projectCount,3);
  assert.ok(monthlyCsv(groups).includes('"花卉"'));assert.ok(monthlyCsv(groups).includes('"其他"'));assert.ok(!monthlyCsv(groups).includes('待归类'));
});
