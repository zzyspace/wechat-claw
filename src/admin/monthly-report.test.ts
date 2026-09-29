import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "./app.js";
import { getDatabase } from "../core/storage/database.js";

const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"monthly-report-test-"));
process.env.WECHATY_STATE_DIR=stateDir;
process.env.WECHATY_TIMEZONE="Asia/Shanghai";
process.env.WECHATY_PUPPET="wechaty-puppet-wechat";
process.env.WECHATY_CHANNELS_JSON='[]';

test("monthly page, API, details, export and assets enforce explicit permission and row scope", async t => {
  let revoked=false;
  const gateway=createServer((request,response)=>{
    const who=request.headers.cookie?.replace("fixture=","");
    if(!["all","owner","reader","no-attachments"].includes(who||"")){response.writeHead(401).end();return;}
    const permissions=["report:view"];
    if(who!=="reader"&&!revoked)permissions.push("report:monthly:view");
    if(who!=="no-attachments")permissions.push("attachment:view");
    const accountId=who==="owner"?"owner":`user-${who}`;
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify({success:true,account:{accountId,username:accountId,enabled:true,version:1},access:{accountId,app:"expense",role:who==="reader"?"admin":"partner",enabled:true,version:1,permissions,config:{viewScope:who==="owner"?{ownership:"self",stores:["fuzzy"],channels:["reimbursement_fuzzy_manager"]}:{ownership:"any",stores:"all",channels:"all"},submitScope:{stores:[],channels:[]}}}}));
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
  const owned=seed({channel:"reimbursement_fuzzy_manager",reporter:"李晨晨",category:"manager_reimbursement",amount:5});
  seed({channel:"reimbursement_fuzzy_manager",reporter:"张志延",category:"manager_reimbursement",owner:"other",amount:7});
  seed({channel:"reimbursement_fuzzy_manager",reporter:"张志延",category:"manager_reimbursement",owner:null,amount:9});
  seed({reporter:"邓振国",note:"门锁维修",category:"other",amount:null});
  seed({currency:"USD",amount:8});
  const message=Number(db.prepare("INSERT INTO raw_messages(message_external_id,channel_name,sender_name,message_type,text_content,sent_at,dedupe_key) VALUES('monthly-image','fixture','owner','image','','2026-09-01','monthly-image')").run().lastInsertRowid);
  const imagePath=path.join(stateDir,"attachment.svg");fs.writeFileSync(imagePath,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const attachment=Number(db.prepare("INSERT INTO message_attachments(raw_message_id,attachment_type,local_path,sha256,mime_type) VALUES(?,'image',?,'fixture','image/svg+xml')").run(message,imagePath).lastInsertRowid);
  db.prepare("INSERT INTO reimbursement_report_sources(reimbursement_report_id,raw_message_id,role) VALUES(?,?,'primary')").run(owned,message);
  const query="?month=2026-09&store=fuzzy",api="/expense/api/monthly-reports";
  for(const route of ["/expense/monthly","/expense/monthly/","/expense/monthly/app.js","/expense/monthly/styles.css",api+query,api+"/options",api+"/details"+query,api+"/export"+query]){
    assert.equal((await request("reader",route)).status,403,route);
    assert.equal((await request("none",route)).status,401,route);
  }
  const page=await request("all","/expense/monthly");assert.equal(page.status,200);assert.match(page.headers.get("content-security-policy")||"",/script-src 'self'/);assert.doesNotMatch(await page.text(),/示例|react|unpkg/);
  assert.equal((await request("all","/expense/monthly/app.js")).status,200);
  const options=await (await request("owner",api+"/options")).json();assert.equal(options.stores.length,1);assert.equal(options.stores[0].partial,true);
  const summary=await (await request("all",api+query)).json();
  const kuailv=summary.groups.find((g:any)=>g.projectId==="kuailv"&&g.currency==="CNY");assert.equal(kuailv.recordCount,1007);assert.equal(kuailv.amountCents,101000);
  assert.equal(summary.totals.find((x:any)=>x.currency==="CNY").amountCents,103100);assert.equal(summary.totals.find((x:any)=>x.currency==="CNY").missingAmountCount,1);
  assert.equal(summary.totals.find((x:any)=>x.currency==="USD").amountCents,800);
  assert.doesNotMatch(JSON.stringify(summary),/submittedBy|ocrText|localPath/);
  const owner=await (await request("owner",api+query)).json();assert.equal(owner.groups.length,1);assert.equal(owner.groups[0].reporter,"张志延");assert.equal(owner.groups[0].recordCount,1);assert.equal(owner.groups[0].amountCents,500);
  assert.equal((await request("owner",api+"?month=2026-09&store=peanut")).status,404);
  assert.equal((await request("owner",api+"/export?month=2026-09&store=peanut")).status,404);
  const selection="&projectId=manager&reporter="+encodeURIComponent("张志延")+"&currency=CNY";
  const details=await (await request("owner",api+"/details"+query+selection)).json();assert.equal(details.total,1);assert.equal(details.items[0].reporter,"李晨晨");assert.equal(details.items[0].billAttachment.id,attachment);assert.doesNotMatch(JSON.stringify(details.items),/ocrText|localPath|submittedBy|amount/);
  const noAttachments=await (await request("no-attachments",api+"/details"+query+selection)).json();assert.equal(noAttachments.canAttachment,false);assert(noAttachments.items.every((r:any)=>!("billAttachment" in r)));
  assert.equal((await request("no-attachments",`/expense/api/attachments/${attachment}/content`)).status,403);
  assert.equal((await request("owner",`/expense/api/attachments/${attachment}/content`)).status,200);
  const secondPage=await (await request("all",api+"/details"+query+"&projectId=kuailv&reporter="+encodeURIComponent("张志延")+"&currency=CNY&offset=1000&limit=50")).json();assert.equal(secondPage.total,1007);assert.equal(secondPage.items.length,7);
  const csv=await request("owner",api+"/export"+query);assert.equal(csv.status,200);const content=await csv.text();assert.match(content,/店长报账/);assert.match(content,/"5.00"/);assert.doesNotMatch(content,/"7.00"|"9.00"/);
  for(const route of [api+"?month=2026-13&store=fuzzy",api+"?month[]=2026-09&store=fuzzy",api+"/details"+query+selection+"&limit=0",api+"/details"+query+selection+"&offset=-1"])assert.equal((await request("all",route)).status,400);
  const session=await (await request("reader","/expense/api/session")).json();assert.equal(session.permissions.canMonthlyReport,false);
  assert.equal((await (await request("all","/expense/api/session")).json()).permissions.canMonthlyReport,true);
  revoked=true;
  assert.equal((await request("all",api+query)).status,403);assert.equal((await request("all",api+"/export"+query)).status,403);assert.equal((await request("all","/expense/monthly")).status,403);
});
