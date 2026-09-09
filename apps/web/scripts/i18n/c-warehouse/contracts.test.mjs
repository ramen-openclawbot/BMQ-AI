import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { scope } from './scope.mjs';
const base='/tmp/bmq-i18n-lanes/baseline/apps/web/src/';
function nodes(text, predicate) {
 const file=ts.createSourceFile('file.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), found=[];
 function walk(n){if(predicate(n))found.push(n.getText(file)); ts.forEachChild(n,walk);} walk(file); return found;
}
for(const file of scope) test(`${file}: exact layout and backend arguments`,()=>{
 const before=fs.readFileSync(base+file,'utf8'),after=fs.readFileSync('src/'+file,'utf8');
 assert.deepEqual(nodes(after,n=>ts.isJsxAttribute(n)&&n.name.text==='className'),nodes(before,n=>ts.isJsxAttribute(n)&&n.name.text==='className'));
 const payload=n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['insert','update','rpc'].includes(n.expression.name.text);
 assert.deepEqual(nodes(after,payload),nodes(before,payload));
 const controls=n=>ts.isJsxAttribute(n)&&['value','disabled','onChange','onValueChange','min','max','step'].includes(n.name.text);
 assert.deepEqual(nodes(after,controls),nodes(before,controls));
 const calculations=n=>ts.isCallExpression(n)&&n.expression.getText()==='useMemo';
 assert.deepEqual(nodes(after,calculations),nodes(before,calculations));
});
test('inventory export bytes and header generation source unchanged',()=>{
 const file='components/inventory/ExportInventoryButton.tsx';
 const extract=s=>s.slice(s.indexOf('const handleExport'),s.indexOf('\n  return ('));
 assert.equal(extract(fs.readFileSync('src/'+file,'utf8')),extract(fs.readFileSync(base+file,'utf8')));
});
test('dictionary EN/VI key and interpolation parity',async()=>{
 const source=fs.readFileSync('src/i18n/warehouse.ts','utf8');
 const js=ts.transpile(source, { module:ts.ModuleKind.ES2022 });
 const {warehouse}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 assert.deepEqual(Object.keys(warehouse.en),Object.keys(warehouse.vi));
 for(const key of Object.keys(warehouse.en)) {
  assert.ok(warehouse.en[key]); assert.ok(warehouse.vi[key]);
  const slots=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
  assert.deepEqual(slots(warehouse.en[key]),slots(warehouse.vi[key]),key);
 }
});
test('canonical command examples, SKU catalog and category values remain unchanged',()=>{
 const contracts={
  'pages/TanTaoWarehouse.tsx':['TAN_TAO_ITEMS','commandArgs','examples'],
  'components/dialogs/AddInventoryDialog.tsx':['categories','units','inventorySchema'],
  'components/dialogs/EditInventoryDialog.tsx':['categories','units'],
 };
 for(const [file,names] of Object.entries(contracts)){
  const extract=text=>{
   const sf=ts.createSourceFile(file,text,99,true),found={};
   function walk(n){if(ts.isVariableDeclaration(n)&&names.includes(n.name.getText(sf))){const value=ts.isAsExpression(n.initializer)?n.initializer.expression:n.initializer;found[n.name.getText(sf)]=value.getText(sf);}ts.forEachChild(n,walk);}walk(sf);return found;
  };
  assert.deepEqual(extract(fs.readFileSync('src/'+file,'utf8')),extract(fs.readFileSync(base+file,'utf8')));
 }
});
