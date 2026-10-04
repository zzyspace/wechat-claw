import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "./app.js";
import { getDatabase } from "../core/storage/database.js";
import { getMonthlyMonthSelection, MIN_MONTHLY_REPORT_MONTH } from "./monthly-report-routes.js";

const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"monthly-report-test-"));
process.env.WECHATY_STATE_DIR=stateDir;
process.env.WECHATY_TIMEZONE="Asia/Shanghai";
process.env.WECHATY_PUPPET="wechaty-puppet-wechat";
process.env.WECHATY_CHANNELS_JSON='[]';

test("monthly month selection uses the prior month in the application timezone and the first supported month", () => {
  assert.deepEqual(getMonthlyMonthSelection("Asia/Shanghai", new Date("2026-10-03T08:00:00Z")), { minMonth: "2026-09", defaultMonth: "2026-09", currentMonth: "2026-10" });
  assert.deepEqual(getMonthlyMonthSelection("Asia/Shanghai", new Date("2027-01-03T08:00:00Z")), { minMonth: "2026-09", defaultMonth: "2026-12", currentMonth: "2027-01" });
  assert.equal(getMonthlyMonthSelection("Asia/Shanghai", new Date("2026-10-31T15:59:59Z")).defaultMonth, "2026-09");
  assert.equal(getMonthlyMonthSelection("Asia/Shanghai", new Date("2026-10-31T16:00:00Z")).defaultMonth, "2026-10");
  assert.equal(getMonthlyMonthSelection("UTC", new Date("2026-10-31T16:00:00Z")).defaultMonth, "2026-09");
  assert.equal(getMonthlyMonthSelection("Asia/Shanghai", new Date("2026-09-03T08:00:00Z")).defaultMonth, MIN_MONTHLY_REPORT_MONTH);
  assert.equal(getMonthlyMonthSelection("Asia/Shanghai", new Date("2026-08-03T08:00:00Z")).defaultMonth, MIN_MONTHLY_REPORT_MONTH);
});

test("monthly page, API, details, export and assets enforce explicit permission and row scope", async t => {
  let revoked=false;
  const gateway=createServer((request,response)=>{
    const who=request.headers.cookie?.replace("fixture=","");
    if(!["all","owner","reader","no-attachments","admin","scoped-admin"].includes(who||"")){response.writeHead(401).end();return;}
    const permissions=["report:view"];
    if(who!=="reader"&&!revoked)permissions.push("report:monthly:view");
    if(who!=="no-attachments")permissions.push("attachment:view");
    const scoped=who==="owner"||who==="scoped-admin";
    const accountId=scoped?"owner":`user-${who}`;
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify({success:true,account:{accountId,username:accountId,enabled:true,version:1},access:{accountId,app:"expense",role:["reader","admin","scoped-admin"].includes(who||"")?"admin":who==="owner"?"manager":"partner",enabled:true,version:1,permissions,config:{viewScope:scoped?{ownership:"self",stores:["fuzzy"],channels:["reimbursement_fuzzy_manager"]}:{ownership:"any",stores:"all",channels:"all"},submitScope:{stores:[],channels:[]}}}}));
  });
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");t.after(()=>new Promise<void>(resolve=>gateway.close(()=>resolve())));const address=gateway.address();assert(address&&typeof address!=="string");
  const app=createApp({gatewayAuth:{mode:"unified",url:`http://127.0.0.1:${address.port}`,token:"monthly-report-fixture-internal-token-001"}});
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");const bound=server.address();assert(bound&&typeof bound!=="string");const base=`http://127.0.0.1:${bound.port}`;
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const request=(who:string,route:string)=>fetch(base+route,{headers:{Cookie:`fixture=${who}`}});
  const db=getDatabase();
  const insert=db.prepare(`INSERT INTO reimbursement_reports(channel_code,channel_name,reporter,amount,currency,expense_category,voucher_date,voucher_date_source,note,evidence_type,ocr_text,confidence,needs_review,submitted_by_account_id,created_at) VALUES(@channel,'fixture',@reporter,@amount,@currency,@category,'2020-01-01','model',@note,'text',@ocr,1,0,@owner,@created)`);
  const seed=(overrides:Record<string,unknown>={})=>Number(insert.run({channel:"reimbursement_fuzzy",reporter:"张志延",amount:1,currency:"CNY",category:"food",note:"快驴",ocr:"",owner:"owner",created:"2026-09-12 00:00:00",...overrides}).lastInsertRowid);
  db.transaction(()=>{for(let i=0;i<1005;i++)seed();})();
  seed({created:"2026-08-31 15:59:59",amount:999}); // Before local September.
  seed({created:"2026-08-31 16:00:00",amount:2});
  seed({created:"2026-09-30 15:59:59",amount:3});
  seed({created:"2026-09-30 16:00:00",amount:999}); // Local October.
  seed({channel:"reimbursement_peanut",amount:999});
  const owned=seed({channel:"reimbursement_fuzzy_manager",reporter:"李晨晨",category:"food",note:"市场采购",amount:5});
  seed({channel:"reimbursement_fuzzy_manager",reporter:"张志延",category:"manager_reimbursement",owner:"other",amount:7});
  seed({channel:"reimbursement_fuzzy_manager",reporter:"张志延",category:"manager_reimbursement",owner:null,amount:9});
  seed({reporter:"邓振国",note:"门锁维修",category:"other",amount:null});
  seed({currency:"USD",amount:8});
  const message=Number(db.prepare("INSERT INTO raw_messages(message_external_id,channel_name,sender_name,message_type,text_content,sent_at,dedupe_key) VALUES('monthly-image','fixture','owner','image','','2026-09-01','monthly-image')").run().lastInsertRowid);
  const imagePath=path.join(stateDir,"attachment.svg");fs.writeFileSync(imagePath,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const attachment=Number(db.prepare("INSERT INTO message_attachments(raw_message_id,attachment_type,local_path,sha256,mime_type) VALUES(?,'image',?,'fixture','image/svg+xml')").run(message,imagePath).lastInsertRowid);
  db.prepare("INSERT INTO reimbursement_report_sources(reimbursement_report_id,raw_message_id,role) VALUES(?,?,'primary')").run(owned,message);
  const query="?month=2026-09&store=fuzzy",api="/expense/api/monthly-reports";
  for(const route of ["/expense/monthly","/expense/monthly/","/expense/monthly/app.js","/expense/monthly/styles.css","/expense/monthly/report-detail.js","/expense/monthly/report-detail.css",api+query,api+"/options",api+"/details"+query,api+"/export"+query]){
    assert.equal((await request("reader",route)).status,403,route);
    assert.equal((await request("none",route)).status,401,route);
  }
  const page=await request("all","/expense/monthly");assert.equal(page.status,200);assert.match(page.headers.get("content-security-policy")||"",/script-src 'self'/);assert.doesNotMatch(await page.text(),/示例|react|unpkg/);
  assert.equal((await request("all","/expense/monthly/app.js")).status,200);
  const options=await (await request("owner",api+"/options")).json();assert.equal(options.stores.length,1);assert.equal(options.stores[0].partial,true);
  const expectedMonths=getMonthlyMonthSelection("Asia/Shanghai");
  for(const field of ["minMonth","defaultMonth","currentMonth"] as const)assert.equal(options[field],expectedMonths[field]);
  assert.equal(options.timeZone,"Asia/Shanghai");
  for(const month of ["2026-08","2026-07","2025-12"]){
    for(const suffix of ["", "/details", "/export"]){
      const blocked=await request("all",api+suffix+`?month=${month}&store=fuzzy&projectId=kuailv&reporter=`+encodeURIComponent("张志延")+"&currency=CNY");
      assert.equal(blocked.status,400,`${suffix||"summary"}: ${month}`);
      assert.equal((await blocked.json()).error.message,"月度报表仅支持 2026-09 及之后的月份。");
    }
  }
  const summary=await (await request("all",api+query)).json();
  const kuailv=summary.groups.find((g:any)=>g.projectId==="kuailv"&&g.currency==="CNY");assert.equal(kuailv.recordCount,1007);assert.equal(kuailv.amountCents,101000);
  assert.equal(summary.totals.find((x:any)=>x.currency==="CNY").amountCents,103100);assert.equal(summary.totals.find((x:any)=>x.currency==="CNY").missingAmountCount,1);
  assert.equal(summary.totals.find((x:any)=>x.currency==="USD").amountCents,800);
  assert.doesNotMatch(JSON.stringify(summary),/submittedBy|ocrText|localPath/);
  for(const total of summary.totals){
    const categories=summary.categoryTotals.filter((c:any)=>c.currency===total.currency);
    assert.equal(categories.length,6);
    assert.equal(categories.reduce((sum:number,c:any)=>sum+c.amountCents,0),total.amountCents);
  }

  const owner=await (await request("owner",api+query)).json();assert.equal(owner.groups.length,1);assert.equal(owner.groups[0].reporter,"张志延");assert.equal(owner.groups[0].recordCount,1);assert.equal(owner.groups[0].amountCents,500);
  assert.equal(owner.categoryTotals.find((c:any)=>c.code==="food").amountCents,500);
  assert.equal(owner.categoryTotals.reduce((sum:number,c:any)=>sum+c.recordCount,0),1,"category totals enforce the same row scope");
  assert.equal((await request("owner",api+"?month=2026-09&store=peanut")).status,404);
  assert.equal((await request("owner",api+"/export?month=2026-09&store=peanut")).status,404);
  const selection="&projectId=manager&reporter="+encodeURIComponent("张志延")+"&currency=CNY";
  const details=await (await request("owner",api+"/details"+query+selection)).json();assert.equal(details.total,1);assert.equal(details.items[0].reporter,"李晨晨");assert.equal(details.items[0].billAttachment.id,attachment);assert.equal(details.items[0].amount,5);assert.equal(details.items[0].currency,"CNY");assert.doesNotMatch(JSON.stringify(details.items),/ocrText|localPath|submittedBy/);
  const noAttachments=await (await request("no-attachments",api+"/details"+query+selection)).json();assert.equal(noAttachments.canAttachment,false);assert(noAttachments.items.every((r:any)=>!("billAttachment" in r)));
  assert.equal((await request("no-attachments",`/expense/api/attachments/${attachment}/content`)).status,403);
  assert.equal((await request("owner",`/expense/api/attachments/${attachment}/content`)).status,200);
  const secondPage=await (await request("all",api+"/details"+query+"&projectId=kuailv&reporter="+encodeURIComponent("张志延")+"&currency=CNY&offset=1000&limit=50")).json();assert.equal(secondPage.total,1007);assert.equal(secondPage.items.length,7);
  const csv=await request("owner",api+"/export"+query);assert.equal(csv.status,200);const content=await csv.text();assert.match(content,/店长报账/);assert.match(content,/"5.00"/);assert.doesNotMatch(content,/"7.00"|"9.00"/);
  for(const route of [api+"?month=2026-13&store=fuzzy",api+"?month[]=2026-09&store=fuzzy",api+"/details"+query+selection+"&limit=0",api+"/details"+query+selection+"&offset=-1"])assert.equal((await request("all",route)).status,400);
  const session=await (await request("reader","/expense/api/session")).json();assert.equal(session.permissions.canMonthlyReport,false);
  assert.equal((await (await request("all","/expense/api/session")).json()).permissions.canMonthlyReport,true);
  seed({reporter:"李晨晨",category:"manager_reimbursement",note:"店长报账",ocr:"店长报账群",amount:11});
  for (const category of ["rent", "utilities", "salary"]) seed({reporter:"李晨晨",category,note:"",ocr:"",amount:13});
  seed({reporter:"李晨晨",category:"rent",note:"宿舍房租",amount:17});
  const rules=await (await request("all",api+query)).json();
  assert.equal(rules.groups.find((g:any)=>g.projectId==="manager").recordCount,3);
  assert.equal(rules.groups.find((g:any)=>g.projectId==="manager").amountCents,2100);
  assert.equal(rules.groups.find((g:any)=>g.projectId==="other"&&g.reporter==="李晨晨").amountCents,1100);
  for (const projectId of ["rent", "utilities", "salary"]) assert.equal(rules.groups.find((g:any)=>g.projectId===projectId&&g.reporter==="李晨晨").amountCents,1300);
  assert.equal(rules.groups.find((g:any)=>g.projectId==="dorm-rent"&&g.reporter==="李晨晨").amountCents,1700);
  seed({reporter:"李晨晨",category:"flower",note:"快驴",ocr:"工资",amount:19});
  const expanded=await (await request("all",api+query)).json();
  assert.equal(expanded.groups.find((g:any)=>g.projectId==="flower").amountCents,1900);
  assert.equal(expanded.groups.find((g:any)=>g.projectId==="other").project,"其他");
  const flowerDetail=await (await request("all",api+"/details"+query+"&projectId=flower&reporter="+encodeURIComponent("李晨晨")+"&currency=CNY")).json();
  assert.equal(flowerDetail.total,1);assert.equal(flowerDetail.items[0].expenseCategory,"flower");
  const projectOptions=await (await request("all",api+"/options")).json();
  assert.deepEqual(projectOptions.projects.slice(-2).map((p:any)=>p.name),["花卉","其他"]);
  assert.deepEqual(projectOptions.projects.slice(0,5).map((p:any)=>p.name),["快驴","金辉","澳美佳 / 安之乐 / 知其味","景洲","墨赞"]);
  for (const [name, projectId] of [["金辉", "jinhui"], ["景洲", "jingzhou"]]) {
    const ocrId=seed({note:"",ocr:`${name}食品配送`,amount:23});
    const noteId=seed({note:`支付${name}货款`,ocr:"",amount:29});
    const supplierSummary=await (await request("all",api+query)).json();
    const supplier=supplierSummary.groups.find((g:any)=>g.projectId===projectId);
    assert.equal(supplier.project,name);assert.equal(supplier.recordCount,2);assert.equal(supplier.amountCents,5200);
    const supplierDetail=await (await request("all",api+"/details"+query+`&projectId=${projectId}&reporter=`+encodeURIComponent("张志延")+"&currency=CNY")).json();
    assert.equal(supplierDetail.total,2);assert.deepEqual(supplierDetail.items.map((item:any)=>item.id),[ocrId,noteId]);
    const supplierCsv=await (await request("all",api+"/export"+query+"&q="+encodeURIComponent(name))).text();
    assert.ok(supplierCsv.includes(`"${name}"`));assert.ok(supplierCsv.includes('"52.00"'));
  }
  const qiamuyangId=seed({note:"",ocr:"高崎星光工业区内金辉餐料 公户名称：上海恰沐阳国际贸易有限公司",amount:31});
  const conflictSummary=await (await request("all",api+query)).json();
  assert.equal(conflictSummary.groups.find((g:any)=>g.projectId==="aomeijia").amountCents,3100);
  assert.equal(conflictSummary.groups.find((g:any)=>g.projectId==="jinhui").recordCount,2);
  const conflictDetails=await (await request("all",api+"/details"+query+"&projectId=aomeijia&reporter="+encodeURIComponent("张志延")+"&currency=CNY")).json();
  assert.equal(conflictDetails.total,1);assert.equal(conflictDetails.items[0].id,qiamuyangId);
  const conflictCsv=await (await request("all",api+"/export"+query+"&q="+encodeURIComponent("澳美佳"))).text();
  assert.ok(conflictCsv.includes('"31.00"'));
  const salaryId=seed({reporter:"李晨晨",category:"salary",note:"快驴",ocr:"金辉 水电",amount:37});
  seed({reporter:"李晨晨",category:"food",note:"工资",ocr:"工资付款",amount:41});
  const salarySummary=await (await request("all",api+query)).json();
  const salaryGroup=salarySummary.groups.find((g:any)=>g.projectId==="salary"&&g.reporter==="李晨晨");
  assert.equal(salaryGroup.recordCount,2);assert.equal(salaryGroup.amountCents,5000);
  assert.equal(salarySummary.groups.find((g:any)=>g.projectId==="other-food"&&g.reporter==="李晨晨").amountCents,4100);
  const salaryDetails=await (await request("all",api+"/details"+query+"&projectId=salary&reporter="+encodeURIComponent("李晨晨")+"&currency=CNY")).json();
  assert.equal(salaryDetails.total,2);assert(salaryDetails.items.every((item:any)=>item.expenseCategory==="salary"));
  assert(salaryDetails.items.some((item:any)=>item.id===salaryId));
  const salaryCsv=await (await request("all",api+"/export"+query+"&q="+encodeURIComponent("工资"))).text();
  assert.ok(salaryCsv.includes('"50.00"'));assert.ok(!salaryCsv.includes('"41.00"'));
  assert.match(projectOptions.projects.find((p:any)=>p.id==="salary").description,/仅依据 salary 类别/);
  const adminOptions=await (await request("admin",api+"/options")).json();
  assert.equal(adminOptions.minMonth,"1900-01");
  assert.equal(adminOptions.defaultMonth,expectedMonths.defaultMonth);
  for(const who of ["all","owner","no-attachments"]){
    assert.equal((await (await request(who,api+"/options")).json()).minMonth,"2026-09");
    for(const suffix of ["","/details","/export"]){
      assert.equal((await request(who,api+suffix+"?month=2026-08&store=fuzzy")).status,400);
    }
  }
  const historicalQuery="?month=2026-08&store=fuzzy&projectId=kuailv&reporter="+encodeURIComponent("张志延")+"&currency=CNY";
  const historicalSummary=await request("admin",api+historicalQuery);
  assert.equal(historicalSummary.status,200);
  assert.equal((await historicalSummary.json()).totals[0].amountCents,99900);
  const historicalDetails=await request("admin",api+"/details"+historicalQuery);
  assert.equal(historicalDetails.status,200);
  assert.equal((await historicalDetails.json()).total,1);
  const historicalExport=await request("admin",api+"/export"+historicalQuery);
  assert.equal(historicalExport.status,200);
  assert.match(await historicalExport.text(),/"999.00"/);
  for(const suffix of ["","/details","/export"]){
    assert.equal((await request("reader",api+suffix+historicalQuery)).status,403,"admin role still requires monthly permission");
    assert.equal((await request("admin",api+suffix+historicalQuery.replace("2026-08","1899-12"))).status,400);
  }
  seed({channel:"reimbursement_fuzzy_manager",created:"2026-08-10 00:00:00",amount:3});
  seed({channel:"reimbursement_fuzzy_manager",created:"2026-08-10 00:00:00",owner:"other",amount:5});
  const scopedHistorical=await (await request("scoped-admin",api+historicalQuery)).json();
  assert.equal(scopedHistorical.groups.length,1);
  assert.equal(scopedHistorical.totals[0].amountCents,300,"admin history retains ownership and channel scope");
  for(const suffix of ["","/details","/export"]){
    assert.equal((await request("scoped-admin",api+suffix+historicalQuery.replace("store=fuzzy","store=peanut"))).status,404);
  }
  revoked=true;
  assert.equal((await request("admin",api+historicalQuery)).status,403);
  assert.equal((await request("all",api+query)).status,403);assert.equal((await request("all",api+"/export"+query)).status,403);assert.equal((await request("all","/expense/monthly")).status,403);
});
