import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "./app.js";
import { getDatabase } from "../core/storage/database.js";
import { operatingCsv, operatingSummary, parseOperatingInput } from "../scenarios/reimbursement/operating-report.js";
import type { MonthlyRecord } from "../scenarios/reimbursement/monthly-report.js";

process.env.WECHATY_STATE_DIR=fs.mkdtempSync(path.join(os.tmpdir(),"operating-report-test-"));
process.env.WECHATY_TIMEZONE="Asia/Shanghai";
process.env.WECHATY_PUPPET="wechaty-puppet-wechat";
process.env.WECHATY_CHANNELS_JSON="[]";

test("operating amounts distinguish unset and zero, reject unsafe or inconsistent allocations", () => {
  const valid={operatingIncomeCents:null,incomeCents:null,dividendCents:null,allocations:[],note:"",revision:0};
  assert.equal(parseOperatingInput(valid).incomeCents,null);
  assert.equal(parseOperatingInput({...valid,incomeCents:0,dividendCents:0}).incomeCents,0);
  for(const patch of [{operatingIncomeCents:-1},{operatingIncomeCents:1.1},{operatingIncomeCents:"1"},{incomeCents:-1},{incomeCents:1.1},{incomeCents:"100"},{incomeCents:Infinity},{incomeCents:Number.MAX_SAFE_INTEGER+1},{revision:-1},{extra:true},{note:"x".repeat(2001)},
    {allocations:[{name:"A",amountCents:1}]},{dividendCents:10,allocations:[{name:"A",amountCents:11}]},{dividendCents:10,allocations:[{name:"A",amountCents:1},{name:" A ",amountCents:1}]},
    {dividendCents:10,allocations:[{name:"",amountCents:1}]},{dividendCents:10,allocations:[{name:"A",amountCents:-1}]},{dividendCents:Number.MAX_SAFE_INTEGER,allocations:[{name:"A",amountCents:Number.MAX_SAFE_INTEGER},{name:"B",amountCents:1}]}])assert.throws(()=>parseOperatingInput({...valid,...patch}));
});
test("profit is suppressed for incomplete costs or partial access and is safe for refunds and zero revenue", () => {
  const record:MonthlyRecord={id:1,channelCode:"reimbursement_fuzzy",reporter:"A",expenseCategory:"food",amount:5,currency:"CNY",note:"工资",ocrText:null,createdAt:"2026-09-01"};
  const finance={operatingIncomeCents:700,incomeCents:1000,dividendCents:0,allocations:[],note:"private",revision:1,updatedAt:"now"};
  assert.equal(operatingSummary([record],"CNY",finance,false).profitCents,500);
  assert.equal(operatingSummary([record],"CNY",{...finance,incomeCents:0},false).profitCents,-500);
  assert.equal(operatingSummary([record],"CNY",{...finance,incomeCents:0},false).costRate,null);
  assert.equal(operatingSummary([{...record,amount:null}],"CNY",finance,false).profitCents,null);
  assert.equal(operatingSummary([record,{...record,currency:""}],"CNY",finance,false).profitCents,null);
  const partial=operatingSummary([record],"CNY",finance,true);assert.equal(partial.finance,null);assert.equal(partial.profitCents,null);
  assert.equal(operatingSummary([{...record,amount:-5}],"CNY",finance,false).profitCents,1500);
  assert.equal(operatingSummary([record,{...record,currency:"USD",amount:999}],"CNY",finance,false).profitCents,500);
  assert.throws(()=>operatingSummary([{...record,amount:-1}],"CNY",{...finance,incomeCents:Number.MAX_SAFE_INTEGER},false));
  const precise=operatingSummary([],"CNY",{...finance,incomeCents:Number.MAX_SAFE_INTEGER-1},false);
  assert.match(operatingCsv(precise,"Fuzzy","2026-09","CNY"),/90071992547409\.90/);
});
test("cost source changes only at September 2026 and historical totals never leak to partial scopes", () => {
  const record:MonthlyRecord={id:1,channelCode:"reimbursement_fuzzy",reporter:"A",expenseCategory:"salary",amount:9,currency:"CNY",note:"",ocrText:null,createdAt:"2026-08-01"};
  const finance={incomeCents:2000,operatingIncomeCents:1800,historicalExpenseCents:1200,historicalFoodCents:700,dividendCents:500,allocations:[],note:"",revision:1,updatedAt:"now"};
  const historical=operatingSummary([record],"CNY",finance,false,"2026-08");
  assert.equal(historical.costSource,"historical");assert.equal(historical.total.amountCents,1200);assert.equal(historical.profitCents,800);
  assert.deepEqual(historical.categories.map(c=>[c.code,c.amountCents]),[["food",700],["other",500]]);
  assert.match(operatingCsv(historical,"Fuzzy","2026-08","CNY"),/历史成本/);
  const live=operatingSummary([record],"CNY",finance,false,"2026-09");
  assert.equal(live.costSource,"monthly");assert.equal(live.total.amountCents,900);assert.equal(live.categories.length,6);
  assert.equal(live.profitCents,1100);
  const missing=operatingSummary([record],"CNY",null,false,"2025-09");
  assert.equal(missing.costComplete,false);assert.equal(missing.profitCents,null);assert.equal(missing.total.amountCents,0);
  const partial=operatingSummary([record],"CNY",finance,true,"2026-08");
  assert.equal(partial.finance,null);assert.equal(partial.total.amountCents,0);assert.equal(partial.profitCents,null);
  const {updatedAt: _updatedAt,...input}=finance;
  const fallback=parseOperatingInput({...input,operatingIncomeCents:null,revision:0});
  assert.equal(fallback.operatingIncomeCents,2000);
  assert.throws(()=>parseOperatingInput({...input,historicalFoodCents:1300}));
  assert.throws(()=>parseOperatingInput({...input,historicalFoodCents:null}));
});
test("operating report persists manual inputs and reuses monthly costs without widening permissions", async t => {
  let revoked=false,operatingRevoked=false;
  const gateway=createServer((request,response)=>{
    const who=request.headers.cookie?.replace("fixture=","");
    if(!["edit","view","partial","reader","other-store","report-editor"].includes(who||"")){response.writeHead(401).end();return;}
    const permissions=["report:view",...(who!=="reader"&&!revoked?["report:monthly:view"]:[]),...(!operatingRevoked&&!revoked&&["edit","partial","other-store"].includes(who||"")?["report:operating:edit"]:[]),...(who==="report-editor"?["report:edit"]:[])];
    const partial=who==="partial";
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify({success:true,account:{accountId:who,username:who,enabled:true,version:1},access:{accountId:who,app:"expense",role:who==="edit"?"admin":"partner",enabled:true,version:1,permissions,config:{viewScope:{ownership:partial?"self":"any",stores:partial?["fuzzy"]:who==="other-store"?["peanut"]:"all",channels:partial?["reimbursement_fuzzy_manager"]:"all"},submitScope:{stores:[],channels:[]}}}}));
  });
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");const ga=gateway.address();assert(ga&&typeof ga!=="string");t.after(()=>new Promise<void>(resolve=>gateway.close(()=>resolve())));
  const app=createApp({gatewayAuth:{mode:"unified",url:`http://127.0.0.1:${ga.port}`,token:"operating-report-fixture-internal-token-001"}}),server=app.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const request=(who:string,route:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:body===undefined?"GET":"PUT",headers:{Cookie:`fixture=${who}`,...(body===undefined?{}:{"Content-Type":"application/json"}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const api="/expense/api/monthly-reports/operating",query="?month=2026-09&store=fuzzy&currency=CNY",page="/expense/monthly/operating";
  for(const route of [page,page+"/",page+"/app.js",page+"/styles.css",api+query,api+"/export"+query]){
    assert.equal((await request("reader",route)).status,403);assert.equal((await request("none",route)).status,401);
    const allowed=await request("view",route);assert.equal(allowed.status,200);assert.equal(allowed.headers.get("Cache-Control"),"no-store");
  }
  const pageResponse=await request("view",page);assert.match(pageResponse.headers.get("Content-Security-Policy")||"",/style-src 'self'/);assert.doesNotMatch(await pageResponse.text(),/react|unpkg|界面预览/);
  assert.doesNotMatch(await (await request("edit","/expense")).text(),/href="\/expense\/monthly\/operating/); // Entry placement remains undecided.
  const db=getDatabase();
  const insert=db.prepare(`INSERT INTO reimbursement_reports(channel_code,channel_name,reporter,amount,currency,expense_category,voucher_date,voucher_date_source,note,evidence_type,confidence,needs_review,submitted_by_account_id,created_at) VALUES(@channel,'fixture','A',@amount,@currency,@category,'2026-09-01','model',@note,'text',1,0,@owner,@created)`);
  const seed=(patch:Record<string,unknown>={})=>insert.run({channel:"reimbursement_fuzzy",amount:100,currency:"CNY",category:"food",note:"",owner:"edit",created:"2026-09-05 00:00:00",...patch});
  for(const [category,amount] of [["food",100],["salary",20],["rent",30],["utilities",4],["flower",5],["other",6]])seed({category,amount,note:"快驴 工资"});
  seed({channel:"reimbursement_fuzzy_manager",amount:7,owner:"partial"});seed({channel:"reimbursement_fuzzy_manager",category:"manager_reimbursement",amount:8});seed({currency:"USD",amount:9});
  seed({channel:"reimbursement_peanut",amount:8888});seed({created:"2026-08-31 15:59:59",amount:999});
  const before=JSON.stringify(db.prepare("SELECT * FROM reimbursement_reports ORDER BY id").all());
  const initial=await (await request("edit",api+query)).json();assert.equal(initial.finance,null);assert.equal(initial.profitCents,null);assert.equal(initial.canEdit,true);assert.equal(initial.total.amountCents,18000);
  const monthly=await (await request("edit","/expense/api/monthly-reports?month=2026-09&store=fuzzy")).json();assert.deepEqual(initial.categories,monthly.categoryTotals.filter((c:any)=>c.currency==="CNY"));
  assert.deepEqual(initial.categories.map((c:any)=>c.amountCents),[10700,2000,3000,400,500,1400]);
  const body={operatingIncomeCents:80000,incomeCents:100000,dividendCents:50000,allocations:[{name:"LCCZZY",amountCents:40000},{name:"DZG",amountCents:10000}],note:"手工录入",revision:0};
  assert.equal((await request("view",api+query,body)).status,403);assert.equal((await request("report-editor",api+query,body)).status,403);assert.equal((await (await request("report-editor",api+query)).json()).canEdit,false);assert.equal((await request("partial",api+query,body)).status,403);assert.equal((await request("other-store",api+query,body)).status,404);
  assert.equal((await request("edit",api+query,body,{Origin:"https://attacker.invalid"})).status,403);
  assert.equal((await request("edit",api+query,body,{"Sec-Fetch-Site":"cross-site"})).status,403);
  const saved=await request("edit",api+query,body,{Origin:base});assert.equal(saved.status,200);assert.equal((await saved.json()).finance.revision,1);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM reimbursement_reports ORDER BY id").all()),before,"manual inputs do not rewrite any expense records");
  const current=await (await request("view",api+query)).json();assert.equal(current.finance.incomeCents,100000);assert.equal(current.finance.operatingIncomeCents,80000);assert.equal(current.profitCents,82000);assert.equal(current.costRate,18);assert.equal(current.allocatedCents,50000);assert.equal(current.unallocatedCents,0);assert.equal(current.canEdit,false);
  assert.equal((await request("edit",api+query,body)).status,409);
  const concurrent=await Promise.all([request("edit",api+query,{...body,revision:1,note:"first"}),request("edit",api+query,{...body,revision:1,note:"second"})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  const partial=await (await request("partial",api+query)).json();assert.equal(partial.finance,null);assert.equal(partial.profitCents,null);assert.equal(partial.total.amountCents,700);assert.equal(partial.store.partial,true);assert.doesNotMatch(JSON.stringify(partial),/LCCZZY|DZG|updatedBy|手工/);
  const partialCsv=await (await request("partial",api+"/export"+query)).text();assert.doesNotMatch(partialCsv,/LCCZZY|DZG|1000.00/);
  const usd=await (await request("edit",api+query.replace("CNY","USD"))).json();assert.equal(usd.finance,null);assert.equal(usd.total.amountCents,900);
  assert.equal((await (await request("edit",api+query.replace("2026-09","2026-10"))).json()).finance,null);
  assert.equal((await (await request("edit",api+query.replace("fuzzy","peanut"))).json()).finance,null);
  seed({amount:5});const changed=await (await request("view",api+query)).json();assert.equal(changed.total.amountCents,18500);assert.equal(changed.profitCents,81500); // Live, not a saved snapshot.
  seed({amount:null});assert.equal((await (await request("view",api+query)).json()).profitCents,null);
  const emptyQuery="?month=2026-11&store=fuzzy&currency=CNY";
  assert.equal((await request("edit",api+emptyQuery,{...body,incomeCents:0,dividendCents:0,allocations:[]})).status,200);
  const zero=await (await request("view",api+emptyQuery)).json();assert.equal(zero.profitCents,0);assert.equal(zero.costRate,null);assert.equal(zero.finance.dividendCents,0);assert.equal(zero.finance.operatingIncomeCents,80000);
  for(const bad of ["?month[]=2026-09&store=fuzzy","?month=2026-13&store=fuzzy","?month=1899-12&store=fuzzy","?month=2026-09&store=fuzzy&currency[]=CNY","?month=2026-09&store=fuzzy&currency=EUR"])assert.equal((await request("edit",api+bad)).status,400);
  assert.equal((await request("view",api+query.replace("2026-09","2026-08"))).status,400);assert.equal((await request("edit",api+query.replace("2026-09","2026-08"))).status,200);
  const historyQuery=query.replace("2026-09","2026-08");
  assert.equal((await request("edit",api+historyQuery,{...body,operatingIncomeCents:null,historicalExpenseCents:60000,historicalFoodCents:35000})).status,200);
  const history=await (await request("edit",api+historyQuery)).json();
  assert.equal(history.finance.operatingIncomeCents,body.incomeCents);assert.equal(history.total.amountCents,60000);
  assert.deepEqual(history.categories.map((c:any)=>c.code),["food","other"]);assert.equal(history.profitCents,40000);
  const latest=await (await request("edit",api+query)).json();
  assert.equal((await request("edit",api+query,{...body,revision:latest.finance.revision,allocations:[{name:"=1+2",amountCents:40000}],note:"@SUM(A1)"})).status,200);
  const csv=await (await request("view",api+"/export"+query)).text();assert.match(csv,/'=1\+2/);assert.match(csv,/'@SUM/);assert.match(csv,/"总收入","1000.00"/);assert.match(csv,/"营业收入","800.00"/);assert.match(csv,/待分配分红/);assert.match(csv,/100.00/);
  operatingRevoked=true;
  const readOnly=await request("edit",api+query);assert.equal(readOnly.status,200);assert.equal((await readOnly.json()).canEdit,false);
  assert.equal((await request("edit",api+query,body)).status,403,"revoking only operating edit takes effect without removing monthly viewing");
  revoked=true;assert.equal((await request("edit",api+query)).status,403);assert.equal((await request("edit",api+query,body)).status,403);assert.equal((await request("edit",page)).status,403);
});
