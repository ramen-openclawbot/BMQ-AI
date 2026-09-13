const fs=require('fs'),path=require('path'),ts=require('../../../apps/web/node_modules/typescript');
const scope=[...require('./scope.cjs'),'lib/finance-ui-error.ts','hooks/useFinanceReconciliation.ts','hooks/useCostClassifications.ts','hooks/usePaymentRequests.ts'];const root=path.resolve(__dirname,'../../..');
const exceptions=JSON.parse(fs.readFileSync(path.join(__dirname,'literal-exceptions.json'),'utf8'));
const remaining=[],seen=new Map();
for(const file of scope){const source=fs.readFileSync(path.join(root,'apps/web/src',file),'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 function bilingual(n){for(let p=n.parent;p;p=p.parent){if(ts.isConditionalExpression(p)&&p.condition.getText(tree)==='isVi')return true;if(ts.isPropertyAssignment(p)&&p.name.getText(tree)==='vi'&&ts.isObjectLiteralExpression(p.parent)&&p.parent.properties.some(x=>x.name?.getText(tree)==='en'))return true;}return false}
 function visit(n){if((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isJsxText(n)||ts.isTemplateExpression(n))&&!bilingual(n)){
  const text=ts.isTemplateExpression(n)?n.getText(tree):n.text.trim().replace(/\s+/g,' ');
  if(/[À-ỹ]/.test(text)){const index=exceptions.findIndex(e=>e.file===file&&e.text===text&&e.reason);if(index<0)remaining.push({file,line:tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1,text});else seen.set(index,(seen.get(index)||0)+1);}
 }ts.forEachChild(n,visit)}
 if(file==='hooks/usePaymentRequests.ts'){
  const active=new Set(['usePaymentRequests','usePaymentRequest','usePaymentRequestItems','useMarkPaid','useApprovePaymentRequest','useRejectPaymentRequest','useMarkDelivered','useUpdatePaymentRequest','useCreatePaymentRequest','useCreatePaymentRequestItem']);
  tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&active.has(n.name?.text)).forEach(visit);
 }else visit(tree);
}
exceptions.forEach((e,i)=>{if(seen.get(i)!==e.count)remaining.push({file:e.file,text:e.text,reason:'Exception occurrence count changed',expected:e.count,actual:seen.get(i)||0})});
console.log(JSON.stringify({untranslated:remaining.length,remaining},null,2));if(remaining.length)process.exitCode=1;
