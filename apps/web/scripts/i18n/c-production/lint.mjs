import { ESLint } from 'eslint';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {files} from './inventory.mjs';
const eslint=new ESLint();const output=[];
for(const file of [...files,'i18n/production.ts','i18n/productionErrors.ts','i18n/useProductionCopy.ts']){
 const filePath=path.resolve('src',file),baseline='/tmp/bmq-i18n-lanes/baseline/apps/web/src/'+file;
 const current=(await eslint.lintText(fs.readFileSync(filePath,'utf8'),{filePath}))[0];
 const base=fs.existsSync(baseline)?(await eslint.lintText(fs.readFileSync(baseline,'utf8'),{filePath}))[0]:{messages:[]};
 const fingerprint=m=>JSON.stringify([m.ruleId,m.severity,m.message]);const counts=new Map();for(const m of base.messages){const k=fingerprint(m);counts.set(k,(counts.get(k)||0)+1);}const added=[];
 for(const m of current.messages){const k=fingerprint(m);if(counts.get(k)>0)counts.set(k,counts.get(k)-1);else added.push(m);}
 output.push({file,baseline:base.messages,current:current.messages,added});
}
fs.writeFileSync('/tmp/bmq-i18n-lanes/c-production/lint-parity.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(output.map(x=>({file:x.file,baseline:x.baseline.length,current:x.current.length,new:x.added.length})),null,2));assert.deepEqual(output.flatMap(x=>x.added),[],'No new lint diagnostics');
