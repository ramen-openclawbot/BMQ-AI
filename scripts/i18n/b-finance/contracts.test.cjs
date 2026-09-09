const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('NPP retains canonical calculations and audited financial payload',()=>{
 const s=read('apps/web/src/pages/NppDebtManagement.tsx');
 for(const text of ['openingBalance + totals.gross - amountCollected','toNumber(quantity) * toNumber(unitPrice)','payable: g.gross - g.managementFee','approval_status: editingLine.approval_status','audit_status: "adjusted"','confidence_status: "manual_review"','review_status: "resolved"','reconciliation_status: "manual_override"','_note: note || null','sendEmail, overwrite: Boolean(options?.overwrite)','new Intl.NumberFormat("vi-VN"','ensureGroup("unmapped", "Chưa map đại lý", null)'])assert.ok(s.includes(text),text);
});
test('each finance page uses a reactive module dictionary',()=>{
 for(const [page,module]of [['NppDebtManagement','nppDebt'],['FinanceControl','financeControl'],['PayablesManagement','payables']]){const s=read(`apps/web/src/pages/${page}.tsx`);assert.ok(s.includes(`@/i18n/${module}`));assert.match(s,/useLanguage\(\)/)}
});
const ts=require('../../../apps/web/node_modules/typescript');
const scope=require('./scope.cjs');
const baseline='/tmp/bmq-i18n-lanes/baseline';
const parse=(file,s)=>ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true);
const nodes=(tree,predicate)=>{const result=[];function visit(n){if(predicate(n))result.push(n.getText(tree));ts.forEachChild(n,visit)}visit(tree);return result};
test('every approved layout class expression is byte-identical to integration baseline',()=>{
 for(const file of scope){const relative='apps/web/src/'+file;const a=parse(file,read(relative)),b=parse(file,fs.readFileSync(path.join(baseline,relative),'utf8'));const classes=n=>ts.isJsxAttribute(n)&&n.name.getText()==='className';assert.deepEqual(nodes(a,classes),nodes(b,classes),file)}
});
test('financial write payloads and generated business text remain canonical',()=>{
 const names=new Set(['payload','aliasPayload','auditDecision','ledgerSnapshot','buildEditForm']);
 for(const file of scope){const relative='apps/web/src/'+file;const a=parse(file,read(relative)),b=parse(file,fs.readFileSync(path.join(baseline,relative),'utf8'));const match=n=>ts.isVariableDeclaration(n)&&names.has(n.name.getText())&&n.initializer&&ts.isObjectLiteralExpression(n.initializer);assert.deepEqual(nodes(a,match),nodes(b,match),file)}
 const file='apps/web/src/components/payment-requests/DriveImportProgressDialog.tsx';
 const fields=new Set(['title','description','notes','p_notes','payment_status','payment_method','status']);
 const canonical=n=>ts.isPropertyAssignment(n)&&fields.has(n.name.getText())&&((ts.isStringLiteral(n.initializer)&&!['pending','processing','success','failed','skipped'].includes(n.initializer.text))||ts.isTemplateExpression(n.initializer));
 assert.deepEqual(nodes(parse(file,read(file)),canonical),nodes(parse(file,fs.readFileSync(path.join(baseline,file),'utf8')),canonical));
});
test('server export implementation bytes are unchanged',()=>{
 const relative='apps/web/supabase/functions/export-npp-debt-sheet/index.ts';assert.deepEqual(fs.readFileSync(path.join(root,relative)),fs.readFileSync(path.join(baseline,relative)));
});
test('lane module dictionaries have exact EN/VI keys and interpolation parity',()=>{
 for(const name of ['financeControl','nppDebt','paymentRequestDetails','createInvoiceFromRequest','editPaymentRequest','addPaymentRequest','driveImport','paymentRequestOperations']){
  const js=ts.transpile(read(`apps/web/src/i18n/${name}.ts`),{module:ts.ModuleKind.CommonJS});const exports={};new Function('exports',js)(exports);const d=exports[name];assert.deepEqual(Object.keys(d.vi).sort(),Object.keys(d.en).sort(),name);
  for(const key of Object.keys(d.vi)){const tokens=v=>(v.match(/\{\w+\}/g)||[]).sort();assert.deepEqual(tokens(d.vi[key]),tokens(d.en[key]),`${name}.${key}`);assert.ok(d.vi[key]&&d.en[key]);}
 }
});
test('interpolation preserves supplier/notes text containing replacement metacharacters',()=>{
 const js=ts.transpile(read('apps/web/src/i18n/format.ts'),{module:ts.ModuleKind.CommonJS});const exports={};new Function('exports',js)(exports);assert.equal(exports.formatText('{name}: {amount}',{name:'NCC giữ nguyên $& $1 {raw}',amount:12000}),'NCC giữ nguyên $& $1 {raw}: 12000');
});
