const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ts=require('../../../apps/web/node_modules/typescript');
const file='apps/web/src/pages/FinanceControl.tsx',source=fs.readFileSync(file,'utf8');
const before=fs.readFileSync('/tmp/bmq-i18n-lanes/b-finance/review-fix/FinanceControl.before.tsx','utf8');
const parse=s=>ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const nodes=(s,p)=>{const tree=parse(s),out=[];const visit=n=>{if(p(n))out.push(n.getText(tree));ts.forEachChild(n,visit)};visit(tree);return out;};
test('review fix retains every financial guard, count, processed flag and write payload',()=>{
 const names=new Set(['uncOcrFailedHard','qtmOcrFailedHard','uncOcrPartialFailedHard','qtmOcrPartialFailedHard','folderTotal','ceoTotal','delta','status','lowConfidenceCount','finalItems','processedAt','ocrAmountMap','successfulOcrFileIds','processedRows','uncSummary','BATCH_SIZE','totalTargets','processedSkippedCount']);
 const variables=n=>ts.isVariableDeclaration(n)&&names.has(n.name.getText());
 assert.deepEqual(nodes(source,variables),nodes(before,variables));
 const writes=n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['upsert','update','insert','rpc'].includes(n.expression.name.text);
 assert.deepEqual(nodes(source,writes),nodes(before,writes));
 assert.ok(source.indexOf('if (ocrFailureMessage) {\n        throw new FinanceUiError')>source.indexOf('.upsert(processedRows,'));
 assert.ok(source.indexOf('if (ocrFailureMessage) {\n        throw new FinanceUiError')<source.indexOf('setQtmSpentFromFolder(Number(qtmTotal || 0))'));
});
test('actual component retains structured errors through settled collection, preview and closing catch',()=>{
 assert.match(source,/ocrErrors: FinanceMessage\[\]/);
 assert.match(source,/ocrErrors\.push\(ocrFileFailure\(slipType,[\s\S]*?r\.reason\)\)/);
 assert.match(source,/ocrFailureMessage = combinedOcrFailure\(scopes, ocrErrors\)/);
 assert.match(source,/throw new FinanceUiError\(ocrFailureMessage, isVi\)/);
 assert.match(source,/throw error; \/\/ Re-throw the structured error so executeClose stops/);
 assert.equal((source.match(/scanFailureDetail\(resp.status, err\)/g)||[]).length,2);
 assert.match(source,/setReconcileError\(financeErrorMessage\(e, financeMessage\(\(isVi\) => financeControl\[isVi \? "vi" : "en"\]\.failedClosingDay\)\)\)/);
 assert.doesNotMatch(source,/const reason = r\.reason instanceof Error/);
});
test('changed page and helper parse without JSX/TypeScript syntax diagnostics',()=>{
 for(const file of ['apps/web/src/pages/FinanceControl.tsx','apps/web/src/lib/finance-ui-error.ts','apps/web/src/i18n/financeControl.ts','scripts/i18n/b-finance/fixture/mock-client.ts']){
  const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);assert.deepEqual(tree.parseDiagnostics,[],file);
 }
});
test('OCR HTTP payload details remain verbatim, including whitespace and local-copy lookalikes',()=>{
 const declaration=nodes(source,n=>ts.isVariableDeclaration(n)&&n.name.getText()==='getOcrErrorMessage')[0];
 const js=ts.transpile(`const ${declaration}; exports.read = getOcrErrorMessage;`,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});const exports={};new Function('exports',js)(exports);
 for(const message of ['  SERVER giữ nguyên $&  ','Failed to scan slip.','timeout from backend'])for(const field of ['error','detail','message'])assert.equal(exports.read({[field]:message},'fallback'),message);
 assert.equal(exports.read({},'local fallback'),'local fallback');
 assert.match(source,/if \(stillTimeout\) \{\s*if \(retryError instanceof FinanceUiError\) throw retryError;/);
});
