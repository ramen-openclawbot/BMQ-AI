import fs from 'node:fs';import assert from 'node:assert/strict';
const root='/tmp/bmq-i18n-lanes/d-people/';
const base=JSON.parse(fs.readFileSync(root+'typecheck-base.json','utf8'));
const current=JSON.parse(fs.readFileSync(root+'typecheck-current.json','utf8'));
// Line numbers can move after UI edits; preserve exact file/code/message AND the offending source line.
function identity(d,baseline){
 const file=(baseline?'/tmp/bmq-i18n-lanes/baseline/apps/web/':'')+d.file;
 const sourceLine=d.file&&d.line?fs.readFileSync(file,'utf8').split('\n')[d.line-1].trim():null;
 return JSON.stringify({file:d.file,code:d.code,message:d.message,sourceLine});
}
assert.equal(base.errors,55);assert.equal(current.errors,55);
assert.deepEqual(current.diagnostics.map(d=>identity(d,false)).sort(),base.diagnostics.map(d=>identity(d,true)).sort());
const result={baseline:base.errors,current:current.errors,exactMessageAndSourceParity:true,normalization:'Line number shifts only; no union/message normalization.',introduced:[],removed:[]};
fs.writeFileSync(root+'typecheck-parity.json',JSON.stringify(result,null,2)+'\n');console.log('PASS: exact 55-diagnostic multiset, including file, code, full message and offending source line.');
