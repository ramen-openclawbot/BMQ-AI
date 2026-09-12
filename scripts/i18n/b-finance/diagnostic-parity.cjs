// Type diagnostics move when imports/copy are added. Compare the complete multiset of
// file + TS code + full diagnostic text, and retain old/new line locations as evidence.
const fs=require('fs'),assert=require('node:assert/strict');
const before=JSON.parse(fs.readFileSync(process.argv[2]||'/tmp/bmq-i18n-lanes/b-finance/typecheck-before.json'));
const after=JSON.parse(fs.readFileSync(process.argv[3]||'/tmp/bmq-i18n-lanes/b-finance/typecheck-final.json'));
const key=d=>JSON.stringify([d.file,d.code,d.message]);
const sorted=d=>d.diagnostics.map(key).sort();
assert.deepEqual(sorted(after),sorted(before),'Exact diagnostic multiset differs');
assert.equal(before.errors,55);assert.equal(after.errors,55);
console.log(JSON.stringify({baselineErrors:before.errors,currentErrors:after.errors,exactDiagnosticMultiset:true,locationChanges:after.diagnostics.map(d=>{const originals=before.diagnostics.filter(x=>key(x)===key(d));return {file:d.file,code:d.code,message:d.message,baselineLines:originals.map(x=>x.line),currentLine:d.line}})},null,2));
