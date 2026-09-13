import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { scan, scopedFiles } from './check-literals.mjs';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const repo=path.resolve(web,'../..');const base='eac7ee887ae44494b9187865fe9766b3ccf49e16';
const read=f=>fs.readFileSync(path.join(web,f),'utf8');
const old=f=>execFileSync('git',['show',`${base}:apps/web/${f}`],{cwd:repo,encoding:'utf8'});
async function loadTs(file){const output=ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);}
const {skuCosts}=await loadTs('src/i18n/skuCosts.ts');const {staff}=await loadTs('src/i18n/staff.ts');const {formatText}=await loadTs('src/i18n/format.ts');
const parsed=(file,src=read(file))=>ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function collect(file,src,predicate){const t=parsed(file,src),out=[];function walk(n){if(predicate(n,t))out.push(n.getText(t));ts.forEachChild(n,walk);}walk(t);return out;}
function named(file,src,name){const t=parsed(file,src);let result;function walk(n){if((ts.isFunctionDeclaration(n)||ts.isVariableDeclaration(n))&&n.name?.getText(t)===name)result=n.getText(t);ts.forEachChild(n,walk);}walk(t);assert.ok(result,`Missing ${name}`);return result;}
test('EN/VI keys, nonempty text and interpolation parameter parity in every module',()=>{
  for(const [name,module]of Object.entries({skuCosts,staff})){
    assert.deepEqual(Object.keys(module.en).sort(),Object.keys(module.vi).sort(),name);
    for(const key of Object.keys(module.vi)){
      assert.ok(module.en[key].trim()&&module.vi[key].trim(),key);
      const params=s=>[...s.matchAll(/\{(\w+)\}/g)].map(x=>x[1]).sort();
      assert.deepEqual(params(module.en[key]),params(module.vi[key]),`${name}.${key}`);
    }
  }
});
test('interpolation does not reinterpret business values or replacement metacharacters',()=>{
  assert.equal(formatText('{name}: {amount}',{name:'Bánh $& {amount}',amount:'15.000đ'}),'Bánh $& {amount}: 15.000đ');
  assert.equal(formatText('{missing} {count}',{count:0}),'{missing} 0');
});
test('approved header switch and exact Sales labels preserved',()=>{
  const file='src/components/layout/Header.tsx';
  const extract=s=>s.slice(s.indexOf('          role="group"'),s.indexOf('        </div>',s.indexOf('          role="group"')));
  assert.equal(extract(read(file)),extract(old(file)));
  const language=read('src/contexts/LanguageContext.tsx');
  assert.match(language,/sectionMarketingSales: "Bán Hàng và Tiếp Thị"/);
  assert.match(language,/sectionMarketingSales: "Sale & Marketing"/);
  for(const name of ['LanguageProvider','useLanguage'])assert.ok(language.includes(name));
});
test('every approved layout class expression survives unchanged in Batch A components',()=>{
  const files=[...scopedFiles.filter(f=>!f.includes('pagination')),'src/components/agent/GlobalAgentChatWidget.tsx','src/components/layout/AppLayout.tsx'];
  for(const file of files){const cls=(n)=>ts.isJsxAttribute(n)&&n.name.getText()==='className';const before=collect(file,old(file),cls),after=collect(file,read(file),cls);const counts=new Map();after.forEach(x=>counts.set(x,(counts.get(x)||0)+1));for(const x of before){assert.ok(counts.get(x)>0,`${file}: removed/changed ${x}`);counts.set(x,counts.get(x)-1);}}
});
test('VND, VN dates, material normalization, cost and controller payloads stay canonical',()=>{
  const m='src/pages/SkuCostsManagement.tsx';
  for(const name of ['vnd','formatYYMMDD','parseWidgets','pickPrice','parseLocaleNumber','buildMaterialCode','convertAmountByUnit','parseDosageGramInput','normalizeScannedIngredient','buildDraftFromStoredRows','formulaComputed','importedDraftComputed','importedMaterialSummary','costing','detailCosting','standardVsActual','buildFormulaRowsFromDraft','skuUpdates'])assert.equal(named(m,read(m),name),named(m,old(m),name),name);
  const d='src/pages/SkuCostsDjango.tsx';for(const name of ['vnd','formatDateTime','priceBandLabel','enrichedSkus','stats','filteredSkus'])assert.equal(named(d,read(d),name),named(d,old(d),name),name);
  for(const file of ['src/lib/sku-cost-analysis.ts','src/lib/sku-cost-template.ts','src/lib/skuType.ts'])assert.equal(read(file),old(file),file);
  const rpc=(n,t)=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='rpc';
  assert.deepEqual(collect(m,read(m),rpc),collect(m,old(m),rpc));
});
test('export data, headers, byte construction and filenames stay canonical',()=>{
  for(const [file,names]of [['src/pages/SkuCostsDjango.tsx',['headers','rows','csv','blob']],['src/pages/SkuCostsAnalysis.tsx',['header','rows','chart','csv','blob']]]){
    const exportName=file.includes('Django')?'exportSkuSheet':'exportCurrentAnalysis';
    const current=named(file,read(file),exportName),before=named(file,old(file),exportName);
    for(const name of names)assert.equal(named(file,current,name),named(file,before,name),name);
    assert.equal(current.match(/link.download = [^;]+/)[0],before.match(/link.download = [^;]+/)[0]);
  }
});
test('analysis calculates suspicious purchase fallback, canonical names, paid-only matching and VN formats',async()=>{
  const {buildSkuAnalysis,money,toDayLabel}=await loadTs('src/lib/sku-cost-analysis.ts');
  const sku={id:'sku',product_name:'Bánh thử nghiệm',sku_code:'QA',finished_output_qty:100};
  const formulas=[{sku_id:'sku',ingredient_sku_id:'i',ingredient_name:'Bột QA',material_code:'QA-NVL',unit:'g',unit_price:10,dosage_qty:100,wastage_percent:0}];
  const purchase={sku_id:'i',product_code:'QA-NVL',confirmed_standard_cost_code:'QA-NVL',product_name:'Bột QA',unit:'g',unit_price:11,quantity:100,line_total:1100,created_at:'2026-09-03',paid_at:'2026-09-03',source:'payment_request',payment_status:'paid'};
  const result=buildSkuAnalysis({sku,formulas,purchases:[purchase],period:'2026-09'});
  assert.equal(result.formulaCost,10);assert.equal(result.actualCost,11);assert.equal(result.rows[0].name,'Bột QA');assert.equal(result.rows[0].source,'Mã NVL/PR');
  const suspicious=buildSkuAnalysis({sku,formulas,purchases:[{...purchase,unit_price:35,line_total:3500}],period:'2026-09'});
  assert.equal(suspicious.actualCost,10);assert.ok(suspicious.rows[0].warning);assert.equal(suspicious.rows[0].source,'Cảnh báo mapping/quy đổi');
  const unpaid=buildSkuAnalysis({sku,formulas,purchases:[{...purchase,payment_status:'unpaid'}],period:'2026-09'});assert.equal(unpaid.chartRows.length,0);assert.equal(unpaid.actualCost,10);
  assert.equal(money(15000),'15.000');assert.equal(toDayLabel('2026-09-03'),'03/09');
});
test('literal guard catches JSX, accessible copy, nested Vietnamese and template regressions',()=>{
  const found=scan('negative.tsx','const a = () => <><span>Forgotten title</span><input placeholder="Untranslated" />{show && "Chưa có dữ liệu"}{`Có ${count} dòng`}</>;');
  assert.deepEqual(found.map(x=>x.kind),['JSX','attribute','literal','template']);
});
test('dealer/kiosk pages and stored protocol prompts are untouched while integrated SKU pages are ownership-audited',()=>{
  for(const file of ['src/pages/DealerPortal.tsx','src/pages/KioskReportPortal.tsx','src/lib/vnagentProtocol.ts'])assert.equal(read(file),old(file),file);
  const f='src/components/agent/GlobalAgentChatWidget.tsx';
  for(const name of ['moduleConfig','getRouteContext','sendMessage','formatVnd','summaryNumber'])assert.equal(named(f,read(f),name),named(f,old(f),name),name);
  // Card UI is now in scope; preserve every business handler apart from UI error state.
  for(const name of ['loadDailyReport','openDailyLedgerDetail','runDailyCompare','confirmDailyCompare','cancelDailyCompare']) {
    const withoutUiErrors=s=>s.replace(/setDailyReportError\([^;]*\);/g,'');
    assert.equal(withoutUiErrors(named(f,read(f),name)),withoutUiErrors(named(f,old(f),name)),name);
  }
  const gates=n=>ts.isConditionalExpression(n)&&n.condition.getText()==='isOwner';
  const conditions=src=>collect(f,src,gates).length;
  assert.equal(conditions(read(f)),conditions(old(f)),'Owner gates preserved');
});
test('management row data references cannot be replaced by translation keys',()=>{
  const file='src/pages/SkuCostsManagement.tsx';
  for(const field of ['product_name','sku_code','cost_values','hide_from_dealer_portal','updated_at']){
    const pred=(n)=>ts.isPropertyAccessExpression(n)&&n.expression.getText()==='s'&&n.name.text===field;
    assert.deepEqual(collect(file,read(file),pred),collect(file,old(file),pred),field);
  }
});
test('derived analysis values are translated only at render boundaries',()=>{
  const file='src/pages/SkuCostsAnalysis.tsx';
  const raw=collect(file,read(file),(n,t)=>ts.isJsxExpression(n)&&n.expression&&['row.source','row.warning'].includes(n.expression.getText(t)));
  assert.deepEqual(raw,[],'Do not render canonical source/warning strings directly');
  assert.equal(staff.en.pagination,'pagination','Non-staff pagination default stays unchanged');
});
