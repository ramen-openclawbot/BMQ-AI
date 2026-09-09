import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { files } from './inventory.mjs';
test('every assigned page and nested component subscribes to the language context', () => {
 for(const file of files) assert.match(fs.readFileSync('src/'+file,'utf8'), /useLanguage|useProductionCopy/, file);
});
test('product label writes preserve canonical fields and matching values', () => {
 const s=fs.readFileSync('src/pages/ProductionProducts.tsx','utf8');
 assert.match(s,/text.includes\("thành phẩm"\)/);
 for(const code of ['sku_id: sku.id','sku_code: sku.sku_code','product_name: sku.product_name','Math.max(1, Number(draft.shelf_life_days || 1))','{ onConflict: "sku_id" }']) assert.ok(s.includes(code),code);
});
test('all lane JSX parses without syntax diagnostics', () => {
 for(const file of files) { const s=fs.readFileSync('src/'+file,'utf8'); const tree=ts.createSourceFile(file,s,99,true,ts.ScriptKind.TSX); assert.deepEqual(tree.parseDiagnostics.map(d => ({ start: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })),[],file); }
});
test('all seven pages retain the lane version marker', () => {
 for(const file of files.slice(0,7)) assert.match(fs.readFileSync('src/'+file,'utf8'),/data-production-i18n="c-production-v1"/,file);
});
