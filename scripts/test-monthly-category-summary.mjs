import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import puppeteer from 'puppeteer';

const root=new URL('../dist/admin/public/monthly/',import.meta.url);
const assets=new Map(await Promise.all(['index.html','app.js','styles.css','report-detail.js','report-detail.css'].map(async name=>[name,await fs.readFile(new URL(name,root))])));
const names=[['food','食材'],['salary','工资'],['rent','房租'],['utilities','水电'],['flower','花卉'],['other','其他']];
let mode='normal';
const server=createServer((request,response)=>{
  const url=new URL(request.url,'http://fixture');
  const json=data=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(data));};
  if(url.pathname==='/expense/api/monthly-reports/options')return json({success:true,currentMonth:'2026-10',defaultMonth:'2026-09',minMonth:'1900-01',timeZone:'Asia/Shanghai',stores:[{id:'fuzzy',name:'Fuzzy',partial:false},{id:'peanut',name:'Peanut',partial:false}],projects:[],reporters:[],canAttachment:false});
  if(url.pathname==='/expense/api/monthly-reports'){
    const factor=url.searchParams.get('store')==='peanut'?2:1;
    const categoryTotals=['CNY','USD'].flatMap(currency=>names.map(([code,label],i)=>({code,label,currency,amountCents:mode==='empty'||mode==='unknown'?0:factor*(mode==='negative'&&i===5?-10000:currency==='USD'?10000:[6800000,2400000,1300000,520000,80000,900000][i]),recordCount:mode==='empty'?0:1,missingAmountCount:mode==='unknown'?1:0})));
    const totals=['CNY','USD'].map(currency=>({currency,amountCents:categoryTotals.filter(c=>c.currency===currency).reduce((sum,c)=>sum+c.amountCents,0),recordCount:mode==='empty'?0:6,missingAmountCount:mode==='unknown'?6:0,groupCount:0,projectCount:0}));
    return json({success:true,month:url.searchParams.get('month'),store:{id:url.searchParams.get('store'),name:'fixture',partial:false},groups:[],totals,categoryTotals});
  }
  const name=url.pathname==='/expense/monthly'?'index.html':url.pathname.slice('/expense/monthly/'.length);
  if(!assets.has(name)){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'");
  response.end(assets.get(name));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const screenshots=await fs.mkdtemp(path.join(os.tmpdir(),'monthly-category-summary-'));
let browser;
try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',msg=>{if(msg.type()==='error'&&msg.text().includes('Content Security Policy'))errors.push(msg.text());});
  const visit=async()=>{await page.goto(`http://127.0.0.1:${server.address().port}/expense/monthly`);await page.waitForSelector('.category-legend-item');};
  for(const width of [1440,390,320]){
    await page.setViewport({width,height:1000});await visit();
    assert.equal(await page.$eval('.summary',el=>/原始报账|汇总条目|归类项目/.test(el.textContent)),false);
    assert.deepEqual(await page.$$eval('.category-legend-heading',els=>els.map(e=>e.children[1].textContent)),names.map(n=>n[1]));
    const segments=await page.$$eval('.category-segment',els=>els.map(e=>({width:e.getBoundingClientRect().width,cents:Number(e.dataset.shareCents)})));
    const available=segments.reduce((s,e)=>s+e.width,0),total=segments.reduce((s,e)=>s+e.cents,0);
    assert.equal(segments.length,6);
    for(const segment of segments)assert.ok(Math.abs(segment.width/available-segment.cents/total)<0.002,'bar widths must reflect amounts under production CSP');
    assert.equal(await page.$eval('.summary',el=>el.scrollWidth<=el.clientWidth),true);
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      await (await page.$('.summary')).screenshot({path:path.join(screenshots,`${width}-${theme}.png`)});
    }
  }
  await page.select('#currency','USD');
  assert.ok((await page.$eval('.category-legend',e=>e.textContent)).includes('USD 100.00'));
  await page.select('#currency','CNY');
  await page.click('[data-store="peanut"]');
  await page.waitForFunction(()=>document.querySelector('.category-legend-amount')?.textContent.includes('136,000.00'));
  for(const value of ['empty','unknown','negative']){
    mode=value;await visit();
    assert.equal(await page.$$eval('.category-segment',els=>els.length),0);
    const text=await page.$eval('.category-legend',e=>e.textContent);
    if(value==='empty')assert.ok(text.includes('0.0%')&&text.includes('0.00'));
    if(value==='unknown')assert.ok(text.includes('待确认')&&!text.includes('0.0%'));
    if(value==='negative')assert.ok(text.includes('-100.00')&&await page.$('.category-share-note'));
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,desktopAndMobile:true,themes:true,currencyAndStoreSwitch:true,emptyUnknownNegative:true,csp:true,screenshots}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
