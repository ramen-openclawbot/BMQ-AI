import ts from 'typescript';import fs from 'node:fs';import assert from 'node:assert/strict';
const files=['pages/Index','pages/SkuCostsProducts','pages/SkuCostsIngredients','pages/SkuCostsEmployees','pages/SkuCostsOverhead','components/dialogs/AddPaymentRequestDialog','components/dashboard/QuickActions','components/dashboard/StatCard','components/sku-costs/SkuCostMenuBar'].map(f=>`src/${f}.tsx`);
const exceptions=JSON.parse(fs.readFileSync('scripts/i18n/d-sku/literal-exceptions.json','utf8'));
const failures=[];const used=new Set();
for(const file of files){const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function visit(n){let value;
 if(ts.isJsxText(n)&&/[\p{L}]/u.test(n.text))value=n.text.trim();
 if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)){
  let p=n.parent;const attr=ts.isJsxAttribute(p)&&['placeholder','title','alt','aria-label'].includes(p.name.getText(tree));
  while(ts.isConditionalExpression(p)||ts.isParenthesizedExpression(p))p=p.parent;
  if((attr||(ts.isJsxExpression(p)&&(!ts.isJsxAttribute(p.parent)||['placeholder','title','alt','aria-label'].includes(p.parent.name.getText(tree)))))&&/[\p{L}]/u.test(n.text))value=n.text;
  if(/[À-ỹ]/.test(n.text))value=n.text;
 }
 if(ts.isTemplateExpression(n)&&/[À-ỹ]/.test(n.getText(tree)))value=n.getText(tree);
 if(value){const key=file+' :: '+value;if(exceptions[key])used.add(key);else failures.push({file,line:tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1,value});}
 ts.forEachChild(n,visit);
}visit(tree);}
assert.deepEqual(failures,[]);for(const key of Object.keys(exceptions))assert.ok(used.has(key),`stale exception: ${key}`);console.log(`PASS scoped literal guard: ${files.length} actual source files; ${used.size} individually documented exceptions (static coverage only)`);
