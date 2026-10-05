import test from 'node:test';
import assert from 'node:assert/strict';
import {chartData,combinedLabel,type SummaryChartRow} from './operating-chart-data.js';
const row=(month:string,patch:Partial<SummaryChartRow>={}):SummaryChartRow=>({month,income:10000,expense:4000,profit:6000,dividend:5000,foodRate:20,costRate:40,costComplete:true,pendingAmountCount:0,unknownCurrencyCount:0,note:'',...patch});
test('chart timelines are chronological, pad absent months with null and preserve genuine zero and refunds',()=>{
 const input=[row('2026-03',{profit:-100,dividend:0}),row('2026-01',{income:0})];
 const data=chartData(input,false);
 assert.deepEqual(data.map(r=>r.month),['2026-01','2026-02','2026-03']);assert.equal(data[0]['总收入'],0);assert.equal(data[1]['总支出'],null);assert.equal(data[2]['盈利'],-1);assert.equal(data[2]['总分红'],0);
 assert.equal(input[0].month,'2026-03');assert.deepEqual(chartData([],false),[]);
});
test('charts keep unknown finance unknown, suppress incomplete costs and use server ratios',()=>{
 const data=chartData([row('2026-09',{income:null,dividend:null,profit:null,costComplete:false,pendingAmountCount:1,foodRate:null,costRate:null})],false)[0];
 for(const key of ['总收入','总分红','盈利','总支出','食材占比','总成本率'])assert.equal(data[key],null);
 const partial=row('2026-09',{income:null,dividend:null,profit:null,foodRate:null,costRate:null,costComplete:false});assert.equal(chartData([partial],true)[0]['总支出'],40);
 assert.equal(chartData([row('2026-09',{foodRate:36.65,costRate:67.22})],false)[0]['食材占比'],36.65);
});
test('chart payload excludes personal allocations and preserves combined-period notes without splitting',()=>{
 const r={...row('2026-07',{note:'2026年6–7月合计归入7月'}),allocations:[{name:'Private',amountCents:5000}]};
 assert.equal(chartData([r],false).length,1);assert.doesNotMatch(JSON.stringify(chartData([r],false)),/Private|allocations/);assert.equal(combinedLabel(r),'合并期间');
});
