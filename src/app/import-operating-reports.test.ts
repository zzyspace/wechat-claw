import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateOperatingImport, applyOperatingImport, planOperatingImport } from "./import-operating-reports.js";
import { getDatabase } from "../core/storage/database.js";

process.env.WECHATY_STATE_DIR=fs.mkdtempSync(path.join(os.tmpdir(),"operating-import-test-"));
process.env.WECHATY_CHANNELS_JSON="[]";
const row={store:"fuzzy",month:"2026-08",currency:"CNY",values:{incomeCents:10000,operatingIncomeCents:null,historicalExpenseCents:6000,historicalFoodCents:4000,dividendCents:3000,allocations:[{name:"A",amountCents:2000},{name:"B",amountCents:1000}],note:"",revision:0}};
test("import validates exact periods, costs and dividend reconciliation",()=>{
  assert.equal(validateOperatingImport([row])[0].values.operatingIncomeCents,10000);
  for(const invalid of [[row,row],[{...row,month:"2026-06~2026-07"}],[{...row,month:"2026-09"}],[{...row,store:"other"}],[{...row,values:{...row.values,historicalFoodCents:7000}}],[{...row,values:{...row.values,dividendCents:4000}}]])assert.throws(()=>validateOperatingImport(invalid));
});
test("import is atomic, idempotent and refuses to overwrite existing data",()=>{
  const db=getDatabase(),entries=validateOperatingImport([row]);
  assert.deepEqual(planOperatingImport(db,entries),{insert:1,unchanged:0,total:1});
  assert.deepEqual(applyOperatingImport(entries,"test"),{insert:1,unchanged:0,total:1});
  assert.deepEqual(applyOperatingImport(entries,"test"),{insert:0,unchanged:1,total:1});
  const before=db.prepare("SELECT * FROM monthly_operating_reports").all();
  assert.throws(()=>applyOperatingImport(validateOperatingImport([{...row,values:{...row.values,incomeCents:11000}}]),"test"));
  assert.deepEqual(db.prepare("SELECT * FROM monthly_operating_reports").all(),before);
  db.exec("CREATE TRIGGER test_abort_import BEFORE INSERT ON monthly_operating_reports WHEN NEW.store_id='peanut' BEGIN SELECT RAISE(ABORT,'simulated second insert failure'); END");
  assert.throws(()=>applyOperatingImport(validateOperatingImport([{...row,month:"2026-07"},{...row,store:"peanut"}]),"test"));
  assert.deepEqual(db.prepare("SELECT * FROM monthly_operating_reports").all(),before,"first insert must roll back on later failure");
  db.exec("DROP TRIGGER test_abort_import");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reimbursement_reports").get() && (db.prepare("SELECT COUNT(*) AS count FROM reimbursement_reports").get() as {count:number}).count,0);
});
