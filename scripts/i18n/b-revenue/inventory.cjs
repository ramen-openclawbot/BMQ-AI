const ts=require('../../../apps/web/node_modules/typescript');
const fs=require('fs');
const names=['RevenueManagementDashboard','RevenueSourceDetail','FinanceRevenueControl','PointRevenueManagement'];
for(const name of names){
 const path=`apps/web/src/pages/${name}.tsx`,src=fs.readFileSync(path,'utf8'), sf=ts.createSourceFile(path,src,99,true,4); const rows=[];
 function walk(n){if(ts.isJsxText(n)&&n.text.trim()||ts.isStringLiteral(n)&&/[a-zA-ZÀ-ỹ]/.test(n.text)) rows.push({pos:n.getStart(sf),line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,kind:ts.SyntaxKind[n.kind],text:n.text.trim(),parent:ts.SyntaxKind[n.parent.kind]});ts.forEachChild(n,walk)}walk(sf);
 fs.writeFileSync(`/tmp/bmq-i18n-lanes/b-revenue/${name}.json`,JSON.stringify(rows,null,2));
 console.log(name);console.log(rows.filter(r=>r.kind==='JsxText'||r.parent==='JsxAttribute').map(r=>`${r.line}: ${r.text}`).join('\n'));
}
