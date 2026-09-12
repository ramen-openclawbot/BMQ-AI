import { ESLint } from 'eslint';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {scope,addedSource} from './scope.mjs';
const eslint=new ESLint();
const results=[];
for(const file of [...scope,...addedSource]){
 const current=(await eslint.lintText(fs.readFileSync('src/'+file,'utf8'),{filePath:'src/'+file}))[0];
 const baseFile='/tmp/bmq-i18n-lanes/baseline/apps/web/src/'+file;
 const baseline=fs.existsSync(baseFile)?(await eslint.lintText(fs.readFileSync(baseFile,'utf8'),{filePath:'src/'+file}))[0]:{messages:[]};
 const signature=m=>JSON.stringify({ruleId:m.ruleId,severity:m.severity,message:m.message,nodeType:m.nodeType});
 const a=current.messages.map(signature).sort(),b=baseline.messages.map(signature).sort();
 results.push({file,current:current.messages,baseline:baseline.messages});
 assert.deepEqual(a,b,`${file}: scoped lint diagnostics must match baseline exactly (locations may move)`);
}
fs.writeFileSync('/tmp/bmq-i18n-lanes/c-warehouse/lint-results.json',JSON.stringify(results,null,2));
console.log(`PASS: ${results.length} files; zero new lint diagnostics. ${results.reduce((n,r)=>n+r.current.length,0)} existing diagnostics preserved.`);
