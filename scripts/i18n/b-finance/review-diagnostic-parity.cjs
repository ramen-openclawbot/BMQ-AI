// Run only AFTER the parent's serialized full typecheck. No compiler is launched here.
const fs=require('node:fs'),assert=require('node:assert/strict');
const dir='/tmp/bmq-i18n-lanes/b-finance/review-fix';
const before=JSON.parse(fs.readFileSync(`${dir}/typecheck-before.json`));
const after=JSON.parse(fs.readFileSync(process.argv[2]||`${dir}/typecheck.json`));
const lines=new Set([1565,2171,2278,2318]);
const removed=before.diagnostics.filter(d=>d.file==='src/pages/FinanceControl.tsx'&&lines.has(d.line)&&d.code===2339&&d.message==="Property 'message' does not exist on type 'unknown'.");
assert.equal(before.errors,55);assert.equal(removed.length,4);
const expected=before.diagnostics.filter(d=>!removed.includes(d));
const key=d=>JSON.stringify([d.file,d.code,d.message]);
assert.deepEqual(after.diagnostics.map(key).sort(),expected.map(key).sort(),'Unexpected diagnostic change beyond four removed unsafe unknown.message accesses');
assert.equal(after.errors,51);
console.log(JSON.stringify({baselineErrors:55,currentErrors:after.errors,removed,exactRemainingDiagnosticMultiset:true},null,2));
