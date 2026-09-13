import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import crypto from 'node:crypto';
import path from 'node:path';
const baseline=JSON.parse(fs.readFileSync(new URL('./contract-baseline.json',import.meta.url),'utf8'));
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const root=new URL('../../../',import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),'utf8');
const miniCrmSourcePath=process.env.CSALES_MINICRM_SOURCE || 'src/pages/MiniCrm.tsx';
const readMiniCrmSource=()=>fs.readFileSync(path.isAbsolute(miniCrmSourcePath)?miniCrmSourcePath:new URL(miniCrmSourcePath,root),'utf8');
function attrs(text){const sf=ts.createSourceFile('x.tsx',text,99,true,4),out=[];function walk(n){if(ts.isJsxAttribute(n)&&['className','value','disabled','onChange','onSubmit','onClick'].includes(n.name.text))out.push(n.getText(sf));ts.forEachChild(n,walk)}walk(sf);return out;}
for(const p of ['pages/MiniCrm.tsx','pages/FacebookMessengerInbox.tsx','components/facebook-messenger/FacebookMessengerPanels.tsx',...['SalesPoQuickViewEditor','KnowledgeBaseProfileEditor','ParseTestWorkbench','KioskReportAdminPanel','DeliveryStaffAdminPanel','AttendanceGeofenceAdminPanel'].map(n=>`components/mini-crm/${n}.tsx`)])test(`${p}: approved layout and values remain unchanged`,()=>{

 // Callback bodies may localize UI feedback; class/value/permission expressions must remain exact.
 const selected=s=>attrs(s).filter(x=>/^(className|value|disabled)=/.test(x));
 assert.equal(hash(selected(read('src/'+p))),baseline.attributes[p]);
});
test('financial/parser utilities unchanged from integration baseline',()=>{for(const name of ['poDraftUtils','emailBodyParseUtils','kbAiUtils','parseContractTypes'])assert.equal(hash(read(`src/components/mini-crm/${name}.ts`)),baseline.files[`components/mini-crm/${name}.ts`]);});
test('Messenger request/status/idempotency hooks unchanged',()=>{for(const name of ['useFacebookMessenger','useFacebookPageConnection'])assert.equal(hash(read(`src/hooks/${name}.ts`)),baseline.files[`hooks/${name}.ts`]);});
function nodes(text,predicate){const sf=ts.createSourceFile('x.tsx',text,99,true,4),out=[];function walk(n){if(predicate(n))out.push(n.getText(sf));ts.forEachChild(n,walk)}walk(sf);return out;}
function collectNodes(text,predicate){const sf=ts.createSourceFile('x.tsx',text,99,true,4),out=[];function walk(n){if(predicate(n,sf))out.push(n);ts.forEachChild(n,walk)}walk(sf);return out;}
test('all CRM write arguments and workbench evidence remain canonical',()=>{
 for(const p of ['pages/MiniCrm.tsx','components/mini-crm/ParseTestWorkbench.tsx','components/mini-crm/AttendanceGeofenceAdminPanel.tsx','components/mini-crm/DeliveryStaffAdminPanel.tsx','components/mini-crm/KioskReportAdminPanel.tsx']){
 const after=read('src/'+p);
 const predicate=n=>(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['insert','update','upsert','rpc'].includes(n.expression.name.text))||(ts.isVariableDeclaration(n)&&['payload','nextRawPayload','evidence'].includes(n.name.getText()));
 assert.equal(hash(nodes(after,predicate)),baseline.writes[p],p);
 }
});
test('CSV export bytes and order remain canonical',()=>{

 const pred=n=>ts.isVariableDeclaration(n)&&['csv','headers','csvContent'].includes(n.name.getText());
 assert.equal(hash(nodes(read('src/pages/MiniCrm.tsx'),pred)),baseline.csv);
});
import vm from 'node:vm';
function loadDictionary(name){const exports={};vm.runInNewContext(ts.transpileModule(read(`src/i18n/${name}.ts`),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({})});return exports;}
for(const name of ['salesCrm','facebookMessenger'])test(`${name}: exact EN/VI keys, interpolation parity and literal parameter safety`,()=>{
 const module=loadDictionary(name),dict=module[name],text=module[name==='salesCrm'?'salesCrmText':'facebookMessengerText'];
 assert.deepEqual(Object.keys(dict.en).sort(),Object.keys(dict.vi).sort());
 for(const key of Object.keys(dict.vi)){const tokens=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(tokens(dict.en[key]),tokens(dict.vi[key]),key);assert.ok(dict.en[key].trim());assert.ok(dict.vi[key].trim());for(const lang of ['en','vi']){const params=Object.fromEntries(tokens(dict[lang][key]).map(k=>[k,'Dữ liệu $& $1 {literal}']));const result=text(lang,key,params);if(Object.keys(params).length)assert.ok(result.includes('Dữ liệu $& $1 {literal}'),key);}}
});
test('persistent feedback retains canonical tone and translates only typed notices',()=>{const m=loadDictionary('salesCrm');const notice=m.crmNotice('❌ Lưu thất bại: {error}',{error:'SERVER giữ nguyên $&'});assert.equal(m.renderCrmNotice('en',notice),'❌ Save failed: SERVER giữ nguyên $&');assert.equal(m.renderCrmNotice('vi',notice),'❌ Lưu thất bại: SERVER giữ nguyên $&');assert.equal(m.renderCrmNotice('en','Đã lưu'),'Đã lưu');});
test('nested SalesCrmUiError/local notices survive warning boundary and remain correct across EN↔VI toggles',()=>{const m=loadDictionary('salesCrm');const nestedError=m.crmErrorNotice(new m.SalesCrmUiError('Lỗi cập nhật SĐT dealer portal (bước thêm số mới): {error}',{error:'SERVER giữ nguyên $&'}),'Không thể cập nhật khách hàng');const warnings=[nestedError,'BACKEND giữ nguyên $&'];const warningText=m.crmNotice(' Tuy nhiên có phần mở rộng chưa lưu được: {warnings}.',{warnings});const boundaryNotice=m.crmNotice('Đã lưu thay đổi cho {name}{emails}.{warning}',{name:'Khách hàng A',emails:'',warning:warningText});const enInitial=m.renderCrmNotice('en',boundaryNotice);const viLater=m.renderCrmNotice('vi',boundaryNotice);const enAfterToggle=m.renderCrmNotice('en',boundaryNotice);assert.equal(enInitial,'Saved changes for Khách hàng A. However, some additional data could not be saved: Unable to update dealer portal phones (adding new phones): SERVER giữ nguyên $&; BACKEND giữ nguyên $&.');assert.equal(viLater,'Đã lưu thay đổi cho Khách hàng A. Tuy nhiên có phần mở rộng chưa lưu được: Lỗi cập nhật SĐT dealer portal (bước thêm số mới): SERVER giữ nguyên $&; BACKEND giữ nguyên $&.');assert.equal(enAfterToggle,enInitial);});
test('catch boundary keeps crmErrorNotice input as descriptor, not detailError.message',()=>{
 const after=readMiniCrmSource();
 const detailMessageNodes=collectNodes(after,(n,sf)=>{
  if(!ts.isVariableDeclaration(n) || n.name.getText(sf)!=='detailMessage' || !n.initializer || !ts.isCallExpression(n.initializer)) return false;
  return ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text==='crmErrorNotice';
 });
 assert.ok(detailMessageNodes.length>0,'Expected detailMessage to be assigned from crmErrorNotice(detailError, ...).');
 for(const node of detailMessageNodes){
   assert.equal(node.initializer.arguments[0]?.getText(), 'detailError', 'crmErrorNotice must receive the caught error object, not detailError.message.');
 }
});
test('warnings stay as notice descriptors through crmNotice composition into setEditFeedback',()=>{
 const sf=ts.createSourceFile('x.tsx',readMiniCrmSource(),99,true,4);
 const state={warningBoundary:true,resultWarningsRef:false,msgComposedFromNotice:false,setEditFeedbackUsesMsg:false};
 function walk(n){
  if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='warningText'&&n.initializer&&ts.isConditionalExpression(n.initializer)){
   const truthy=n.initializer.whenTrue;
   if(ts.isCallExpression(truthy)&&ts.isIdentifier(truthy.expression)&&truthy.expression.text==='crmNotice'&&ts.isObjectLiteralExpression(truthy.arguments[1])){
    const warningsNode=truthy.arguments[1].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(sf)==='warnings'&&['result.warnings','result?.warnings'].includes(p.initializer.getText(sf).replace(/\s+/g,'')));
    if(warningsNode) state.resultWarningsRef=true;
   }
  }
  if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='msg'&&n.initializer&&ts.isCallExpression(n.initializer)){
   if(ts.isIdentifier(n.initializer.expression)&&n.initializer.expression.text==='crmNotice'&&ts.isObjectLiteralExpression(n.initializer.arguments[1])){
    const warningNode=n.initializer.arguments[1].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(sf)==='warning'&&p.initializer.getText(sf)==='warningText');
    if(warningNode) state.msgComposedFromNotice=true;
   }
  }
  if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='setEditFeedback'){
   const arg=n.arguments[0];
   if(ts.isIdentifier(arg)&&arg.text==='msg') state.setEditFeedbackUsesMsg=true;
   if(ts.isCallExpression(arg)&&ts.isIdentifier(arg.expression)&&arg.expression.text==='renderCrmNotice') state.warningBoundary=false;
  }
  ts.forEachChild(n,walk);
 }
 walk(sf);
 assert.ok(state.warningBoundary,'setEditFeedback must be invoked from crmNotice composition boundary, not pre-rendered with renderCrmNotice.');
 assert.ok(state.resultWarningsRef,'warningText should pass result?.warnings/result.warnings into crmNotice for descriptor composition.');
 assert.ok(state.msgComposedFromNotice,'msg should be composed by crmNotice with warningText placeholder.');
 assert.ok(state.setEditFeedbackUsesMsg,'setEditFeedback should consume msg composition variable, not inline string.');
});
test('stable page i18n markers and exact staff group labels',()=>{assert.match(read('src/pages/MiniCrm.tsx'),/data-i18n-mini-crm="c-sales-v1"/);assert.match(read('src/pages/FacebookMessengerInbox.tsx'),/data-i18n-facebook-messenger="c-sales-v1"/);assert.match(read('src/contexts/LanguageContext.tsx'),/sectionMarketingSales: "Sale & Marketing"/);assert.match(read('src/contexts/LanguageContext.tsx'),/sectionMarketingSales: "Bán Hàng và Tiếp Thị"/);});
