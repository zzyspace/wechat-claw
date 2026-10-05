import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildOperatingCharts(target){
 const source=path.join(base,'frontend/operating-summary');
 await build({entryPoints:[path.join(source,'index.tsx')],outfile:path.join(target,'operating-summary/charts.js'),bundle:true,minify:true,target:['es2020'],format:'iife',define:{'process.env.NODE_ENV':'"production"'},legalComments:'linked'});
 await fs.appendFile(path.join(target,'operating-summary/charts.js.LEGAL.txt'),'\nTremor — Copyright 2025 Tremor\n'+await fs.readFile(path.join(source,'vendor/tremor/LICENSE'),'utf8'));
 const input=path.join(source,'tailwind.css');
 const output=await postcss([tailwind({base:source,optimize:true})]).process(await fs.readFile(input,'utf8'),{from:input});
 // Scope generated utilities to the chart island; no Tailwind preflight on the existing app.
 const css=postcss.parse(output.css);css.walkRules(rule=>{if(rule.parent?.type==='atrule'&&/keyframes/.test(rule.parent.name))return;if(!rule.selector.includes(':root')&&!rule.selector.includes(':host'))rule.selectors=rule.selectors.map(selector=>`#operatingCharts ${selector}`)});
 await fs.writeFile(path.join(target,'operating-summary/charts.css'),css.toString()+'\n'+await fs.readFile(path.join(source,'styles.css'),'utf8'));
}
