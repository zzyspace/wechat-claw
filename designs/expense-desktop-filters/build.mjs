import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const babel=require(process.env.BABEL_STANDALONE||'/Users/ryan/DataDisk/Work/AI/server-infra/designs/restaurant-ops-logo-exploration/vendor/babel-7.29.0.min.cjs');
const root=path.dirname(fileURLToPath(import.meta.url));
for(const name of ['app','review','design-canvas']){const input=fs.readFileSync(path.join(root,name+'.jsx'),'utf8');fs.writeFileSync(path.join(root,name+'.js'),babel.transform(input,{presets:['react'],comments:true,filename:name+'.jsx'}).code+'\n')}
function vendorScript(name){const src=`vendor/${name}`;const hash=crypto.createHash('sha384').update(fs.readFileSync(path.join(root,src))).digest('base64');return `<script src="${src}" integrity="sha384-${hash}"></script>`}
const vendor=[vendorScript('react-18.3.1.min.js'),vendorScript('react-dom-18.3.1.min.js')].join('\n');
const names={a:'全项紧凑',b:'常用条件优先',c:'两行分组'};
for(const [key,name] of Object.entries(names))fs.writeFileSync(path.join(root,`${key}.html`),`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><link rel="icon" href="data:,"><title>${key.toUpperCase()} · ${name} — /expense 电脑端筛选</title><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="desktop.css"></head><body data-variant="${key}"><div id="root"></div>${vendor}<script src="app.js"></script></body></html>\n`);
fs.writeFileSync(path.join(root,'index.html'),`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>/expense 电脑端筛选 · 三版对比</title><link rel="stylesheet" href="review.css"></head><body><div id="root"></div>${vendor}<script src="design-canvas.js"></script><script src="review.js"></script></body></html>\n`);
console.log('Built 3 prototypes and the comparison review.');
