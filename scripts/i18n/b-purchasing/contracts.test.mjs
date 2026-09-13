import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, files, ts } from './inventory.mjs';
const read=f=>fs.readFileSync(path.join(root,'apps/web/src',f),'utf8');
const baseline='/tmp/bmq-i18n-lanes/baseline/apps/web/src';
const nodes=(source,predicate)=>{ const ast=ts.createSourceFile('x.tsx',source,ts.ScriptTarget.Latest,true), out=[]; function walk(n){if(predicate(n))out.push(n.getText(ast));ts.forEachChild(n,walk);}walk(ast);return out; };
test('approved layout classes and route targets match integration baseline exactly',()=>{
 for(const f of files){const predicate=n=>ts.isJsxAttribute(n)&&['className','href','to'].includes(n.name.getText());assert.deepEqual(nodes(read(f),predicate),nodes(fs.readFileSync(path.join(baseline,f),'utf8'),predicate),f);}
});
test('supplier workbook and PDF output generation remain byte-for-byte source identical',()=>{
 for(const [f,begin,end] of [['components/suppliers/ExportSuppliersButton.tsx','// Create workbook','} catch'],['components/payment-requests/ExportApprovedPDFDialog.tsx','const doc =','toast.success']]){
  const slice=s=>s.slice(s.indexOf(begin),s.indexOf(end,s.indexOf(begin)));assert.ok(slice(read(f)).length>100);assert.equal(slice(read(f)),slice(fs.readFileSync(path.join(baseline,f),'utf8')),f);
 }
});
test('canonical enums, matching literals, routes, writes and arithmetic are preserved',()=>{
 const inToast=n=>{for(let p=n.parent;p;p=p.parent)if(ts.isCallExpression(p)&&p.expression.getText().startsWith('toast.'))return true;return false;};
 const predicate=n=>ts.isBinaryExpression(n)&&[ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.AsteriskToken,ts.SyntaxKind.SlashToken].includes(n.operatorToken.kind)&&! /language|isVi/.test(n.getText())||ts.isCallExpression(n)&&!n.expression.getText().startsWith('Array.')&&/\.(?:insert|update|rpc|eq|in|from)$/.test(n.expression.getText())||ts.isPropertyAssignment(n)&&!inToast(n)&&!n.initializer.getText().startsWith('z.')&&/^(?:title|notes|description|product_name|status|payment_status|payment_method|payment_type)$/.test(n.name.getText())&&!n.getText().includes('isVi');
 // These UI-only discriminants changed from ambiguous localized strings to explicit descriptors.
 // The additional test below guards the replacement; all business predicates remain exact.
 const displayDiscriminants = new Set(["error === 'Chưa có UNC để cập nhật'", "error === 'Không có file PO mới để import'", 'typeof message === "string"', 'typeof error !== "string"', 'error?.copyKey === "noBankSlipsToUpdate"', 'error?.copyKey === "noNewPOFilesToImport"']);
 for(const f of files){const select=n=>predicate(n)&&!(f==='components/payment-requests/DriveImportProgressDialog.tsx'&&displayDiscriminants.has(n.getText()));assert.deepEqual(nodes(read(f),select),nodes(fs.readFileSync(path.join(baseline,f),'utf8'),select),f);}
});
test('form field paths and validation constraints preserve canonical input contracts',()=>{
 const extract=source=>{
  const ast=ts.createSourceFile('x.tsx',source,ts.ScriptTarget.Latest,true),out=[];
  function walk(n){
   if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){
    const method=n.expression.name.text,owner=n.expression.expression.getText(ast);
    if(['register','watch','setValue','getValues','getFieldState'].includes(method)&&/^(form|formMethods)$/.test(owner))out.push(['field',method,n.arguments[0]?.getText(ast)]);
    if(['min','max','length','positive','nonnegative','int','email','uuid','enum','optional','nullable'].includes(method)&&owner.startsWith('z.'))out.push(['constraint',method,['min','max','length','enum'].includes(method)?n.arguments[0]?.getText(ast):null]);
   }
   if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='name')out.push(['name',n.initializer?.getText(ast)]);
   ts.forEachChild(n,walk);
  }
  walk(ast);return out;
 };
 for(const f of files)assert.deepEqual(extract(read(f)),extract(fs.readFileSync(path.join(baseline,f),'utf8')),f);
});

test('Drive empty-result UI uses descriptor provenance, never backend string matching',()=>{
 const source=read('components/payment-requests/DriveImportProgressDialog.tsx');
 assert.ok(source.includes('typeof error !== "string" && (error?.copyKey === "noBankSlipsToUpdate" || error?.copyKey === "noNewPOFilesToImport")'));
 assert.ok(source.includes('setError({ copyKey: "noBankSlipsToUpdate" })'));
 assert.ok(!source.includes("error === 'Chưa có UNC để cập nhật'"));
 assert.ok(!source.includes('renderDriveError'));
});
