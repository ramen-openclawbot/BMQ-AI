import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { files } from './scope.mjs';
import { parse } from './inventory.mjs';
const baseline=process.env.BMQ_PEOPLE_BASELINE || '/tmp/bmq-i18n-lanes/baseline/apps/web/';
const collect=(tree,predicate)=>{const out=[];function walk(n){if(predicate(n))out.push(n.getText(tree));ts.forEachChild(n,walk);}walk(tree);return out;};
test('all lane sources parse (bounded diagnostic summaries)',()=>{
 for(const file of [...files,'src/hooks/usePeopleCopy.ts','src/hooks/usePeopleLabels.ts','src/i18n/people.ts']){const tree=parse(file);assert.deepEqual(tree.parseDiagnostics.map(d=>({start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})),[],file);}
});
test('UI dictionaries have exact key and interpolation parity',()=>{
 const file='src/i18n/people.ts';const src=fs.readFileSync(file,'utf8');
 const js=ts.transpile(src, {module:ts.ModuleKind.CommonJS}); const module={exports:{}};new Function('exports',js)(module.exports);
 const { people }=module.exports;
 assert.deepEqual(Object.keys(people.vi).sort(),Object.keys(people.en).sort());
 for(const key of Object.keys(people.vi)){
  assert.ok(people.vi[key]&&people.en[key],key);
  assert.deepEqual(people.vi[key].match(/\{\w+\}/g)?.sort()||[],people.en[key].match(/\{\w+\}/g)?.sort()||[],key);
 }
});
test('layout classes, protocol identifiers, calculations and export helpers stay canonical',()=>{
 for(const file of files){
  const old=parse(file,fs.readFileSync(baseline+file,'utf8')), current=parse(file);
  for(const predicate of [
   n=>ts.isJsxAttribute(n)&&n.name.text==='className',
   n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['from','rpc','invoke','eq','in','select','order','invalidateQueries','includes','insert','upsert','update','delete'].includes(n.expression.name.text),
   n=>ts.isBinaryExpression(n)&&[ts.SyntaxKind.AsteriskToken,ts.SyntaxKind.SlashToken,ts.SyntaxKind.MinusToken].includes(n.operatorToken.kind),
   n=>ts.isFunctionDeclaration(n)&&['downloadTextFile','toSqlLiteral','formatBytes','formatCurrency','formatBuildTime','toCsv','downloadCsv','createEmptyBanner','normalizeBanners'].includes(n.name?.text),
  ])assert.deepEqual(collect(current,predicate),collect(old,predicate),file);
  const protectedVariables=['emptyProfile','createEmptyBanner','normalizeBanners','downloadSummary','downloadJournal','downloadSku','TABLES','DEFAULT_VIEW','DEFAULT_EDIT','ALL_MODULE_KEYS','fallbackName'];
  const variable=n=>ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&protectedVariables.includes(n.name.text);
  assert.deepEqual(collect(current,variable),collect(old,variable),file+' protected constants/exports');
 }
});

test('stable lane markers and canonical navigation group labels',()=>{
 for(const file of files.filter(f=>f.startsWith('src/pages/')))assert.ok(fs.readFileSync(file,'utf8').includes('data-i18n-version="d-people-v1"'),file);
 const shared=fs.readFileSync('src/contexts/LanguageContext.tsx','utf8');
 assert.ok(shared.includes('sectionMarketingSales: "Bán Hàng và Tiếp Thị"'));
 assert.ok(shared.includes('sectionMarketingSales: "Sale & Marketing"'));
});
