import fs from 'node:fs';import ts from 'typescript';
const files=['pages/MiniCrm.tsx','pages/FacebookMessengerInbox.tsx','components/facebook-messenger/FacebookMessengerPanels.tsx',...['SalesPoQuickViewEditor','KnowledgeBaseProfileEditor','ParseTestWorkbench','KioskReportAdminPanel','DeliveryStaffAdminPanel','AttendanceGeofenceAdminPanel'].map(n=>`components/mini-crm/${n}.tsx`)];
const found=[];
for(const file of files){const source=fs.readFileSync(new URL('../../../src/'+file,import.meta.url),'utf8'),sf=ts.createSourceFile(file,source,99,true,4);function walk(n){
 const parents=[];for(let p=n.parent;p;p=p.parent)parents.push(p);
 const attr=parents.find(ts.isJsxAttribute),jsx=parents.some(ts.isJsxExpression);
 const handled=parents.some(p=>ts.isCallExpression(p)&&['f','crmNotice','crmErrorNotice','renderCustomerGroup','renderProductGroup','formatDealerContactPhones'].includes(p.expression.getText(sf)));
 const inline=parents.some(p=>ts.isConditionalExpression(p)&&p.condition.getText(sf)==='isVi');
 const text=ts.isJsxText(n)?n.text.trim().replace(/\s+/g,' '):ts.isStringLiteral(n)?n.text:null;
 if(text&&!handled&&!inline&&(!attr||['placeholder','title','aria-label'].includes(attr.name.text))&&(ts.isJsxText(n)||(ts.isStringLiteral(n)&&(jsx||attr)))){
 // Only human-language literals, not numbers/punctuation, are candidates. Canonical values are documented individually.
 if(/[a-zA-ZÀ-ỹ]/.test(text))found.push({file,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,text});
 }
 ts.forEachChild(n,walk)}walk(sf)}
if(process.argv.includes('--check')){
 const exceptions=JSON.parse(fs.readFileSync(new URL('./literal-exceptions.json',import.meta.url),'utf8'));
 const unresolved=found.filter(row=>!exceptions.some(e=>e.file===row.file&&e.text===row.text&&e.reason));
 const stale=exceptions.filter(e=>!found.some(row=>e.file===row.file&&e.text===row.text));
 if(unresolved.length||stale.length){console.error(JSON.stringify({unresolved,stale},null,2));process.exitCode=1;}
 else console.log(`PASS: ${files.length} files, ${found.length} canonical literal occurrences, ${exceptions.length} individually documented exceptions, zero unresolved UI literals.`);
}else console.log(JSON.stringify(found,null,2));
