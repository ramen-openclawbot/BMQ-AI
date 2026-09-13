import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
export const pages = ['Index','SkuCostsProducts','SkuCostsIngredients','SkuCostsEmployees','SkuCostsOverhead'];
export const files = [...pages.map(n=>`src/pages/${n}.tsx`), 'src/components/dialogs/AddPaymentRequestDialog.tsx', 'src/components/dialogs/ReactiveDSkuToastText.tsx', 'src/components/dashboard/QuickActions.tsx','src/components/dashboard/StatCard.tsx','src/components/sku-costs/SkuCostMenuBar.tsx'];
const base='/tmp/bmq-i18n-lanes/baseline/apps/web';
const parse=(file,text=fs.readFileSync(file,'utf8'))=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function collect(tree,predicate){const out=[],source=tree.getSourceFile();function visit(n){if(predicate(n))out.push(n.getText(source));ts.forEachChild(n,visit);}visit(tree);return out;}
test('all lane JSX parses (bounded diagnostic summaries)',()=>{for(const f of files){const tree=parse(f);assert.deepEqual(tree.parseDiagnostics.map(d=>({start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')})),[],f);}});
test('SKU write handlers, filters, numeric formatting and layout remain exact',()=>{for(const file of files.filter(f=>/pages\/SkuCosts/.test(f))){const a=parse(file),b=parse(file,fs.readFileSync(path.join(base,file),'utf8'));const predicate=n=>(ts.isVariableDeclaration(n)&&['save','remove','filtered','emptyForm','statusTone','formatVnd'].includes(n.name.getText()))||(ts.isJsxAttribute(n)&&n.name.getText()==='className')||(ts.isNewExpression(n)&&n.expression.getText()==='Intl.NumberFormat');assert.deepEqual(collect(a,predicate),collect(b,predicate),file);}});
test('lane dictionary EN/VI keys and interpolation parity',()=>{const file='src/i18n/dSku.ts';assert.ok(fs.existsSync(file),'lane dictionary exists');const source=fs.readFileSync(file,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const exports={};new Function('exports','require',js)(exports,()=>({}));const {dSku}=exports;assert.deepEqual(Object.keys(dSku.en).sort(),Object.keys(dSku.vi).sort());for(const key of Object.keys(dSku.en))assert.deepEqual(dSku.en[key].match(/\{\w+\}/g)||[],dSku.vi[key].match(/\{\w+\}/g)||[],key);});
test('payment request payloads, sums, permission checks, generated content and layout stay exact',()=>{
 const file='src/components/dialogs/AddPaymentRequestDialog.tsx',a=parse(file),b=parse(file,fs.readFileSync(path.join(base,file),'utf8'));
 const predicate=n=>(ts.isCallExpression(n)&&(/\.mutateAsync$/.test(n.expression.getText())||n.expression.getText()==='form.setValue'||n.expression.getText()==='form.reset'||n.expression.getText()==='fetch'))||(ts.isVariableDeclaration(n)&&['subtotal','total','formatCurrency','availableGoodsReceipts'].includes(n.name.getText()))||(ts.isJsxAttribute(n)&&n.name.getText()==='className');
 assert.deepEqual(collect(a,predicate),collect(b,predicate));
 assert.ok(a.getText().includes('errorMessage.includes("row-level security")'));
});
test('interpolation preserves business values containing replacement metacharacters',()=>{
 const js=ts.transpileModule(fs.readFileSync('src/i18n/dSku.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const exports={};new Function('exports',js)(exports);assert.equal(exports.formatDSku('Supplier {name}',{name:'NCC $& {number}'}),'Supplier NCC $& {number}');
});
test('all assigned pages expose the stable lane version marker',()=>{for(const name of pages)assert.match(fs.readFileSync(`src/pages/${name}.tsx`,'utf8'),/data-i18n-version="d-sku-v1"/);});
function assertSupplierErrorBoundary(dialogSource,helperSource){
 const dialog=parse('AddPaymentRequestDialog.tsx',dialogSource),helper=parse('ReactiveDSkuToastText.tsx',helperSource);
 const calls=collect(dialog,n=>ts.isCallExpression(n)&&n.expression.getText(dialog)==='showSupplierErrorToast');
 assert.deepEqual(calls,['showSupplierErrorToast(supplierError.message)'],'backend supplier message must cross the dialog boundary unmodified');
 const supplierContent=helper.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='SupplierErrorToastContent');
 const reactiveText=helper.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ReactiveDSkuToastText');
 const showToast=helper.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='showSupplierErrorToast');
 assert.ok(supplierContent&&reactiveText&&showToast,'supplier toast boundary functions must exist');
 assert.deepEqual(collect(showToast,n=>ts.isJsxAttribute(n)&&n.name.getText(helper)==='description'),['description={description}'],'custom toast must forward the description unchanged');
 assert.deepEqual(collect(supplierContent,n=>ts.isJsxAttribute(n)&&n.name.getText(helper)==='exactText'),['exactText={description}'],'supplier toast must render the backend description as exact text');
 assert.deepEqual(collect(reactiveText,n=>ts.isVariableDeclaration(n)&&n.name.getText(helper)==='text'),['text = exactText ?? formatDSku(copy[copyKey!], values ?? {})'],'exactText must take precedence over translated copy');
 assert.deepEqual(collect(reactiveText,n=>ts.isJsxExpression(n)&&n.expression?.getText(helper)==='text'),['{text}'],'resolved exactText must remain in rendered output');
}
test('payment-request purchasing errors and d-sku Sonner content keep their separate reactive boundaries',()=>{
 const dialogSource=fs.readFileSync('src/components/dialogs/AddPaymentRequestDialog.tsx','utf8');
 const helperSource=fs.readFileSync('src/components/dialogs/ReactiveDSkuToastText.tsx','utf8');
 assert.match(dialogSource,/const pc = usePurchasingCopy\(paymentRequestPurchasing\)/,'purchasing copy must resolve reactively in the dialog');
 assert.match(dialogSource,/errorData\.error \|\| pc\.scanFailed/,'backend scan detail must win; localized fallback is boundary-only');
 assert.match(dialogSource,/new Error\(pc\.unableToReadInvoiceInformation\)/,'missing OCR data must use purchasing copy');
 assert.match(dialogSource,/error instanceof Error \? error\.message : pc\.unknownError/,'unknown submit errors must use purchasing copy');
 assert.doesNotMatch(dialogSource,/toast\.(?:success|error)\((?:formatDSku\(s\.|s\.)/);
 assertSupplierErrorBoundary(dialogSource,helperSource);
 assert.doesNotMatch(dialogSource.replace('errorData.error || pc.scanFailed','pc.scanFailed'),/errorData\.error \|\| pc\.scanFailed/,'dropping backend scan detail must fail this boundary');
 assert.throws(()=>assertSupplierErrorBoundary(dialogSource.replace('showSupplierErrorToast(supplierError.message)','showSupplierErrorToast(supplierError.message.trim())'),helperSource),/unmodified/,'modified backend messages must fail the contract');
 assert.throws(()=>assertSupplierErrorBoundary(dialogSource.replace('showSupplierErrorToast(supplierError.message)','showSupplierErrorToast(s.supplierError)'),helperSource),/unmodified/,'missing backend messages must fail the contract');
 assert.throws(()=>assertSupplierErrorBoundary(dialogSource,helperSource.replace('exactText={description}','copyKey="supplierError"')),/exact text/,'dropping the backend description must fail the contract');
});
