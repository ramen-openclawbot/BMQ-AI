import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs';
const origin='http://127.0.0.1:4301',out='/tmp/bmq-i18n-lanes/b-finance';
const browser=await chromium.launch({executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const unexpected=[],errors=[],cases=[];
const dictionary=async name=>{const source=await fs.readFile(`apps/web/src/i18n/${name}.ts`,'utf8'),match=source.match(/export const \w+ = (\{[\s\S]*?\n\});/);assert.ok(match,`dictionary ${name} not found`);return JSON.parse(match[1])};
const invoice=await dictionary('createInvoiceFromRequest'), editCopy=await dictionary('editPaymentRequest'), dSku=await dictionary('dSku'), drive=await dictionary('driveImport');
const debt=await dictionary('nppDebt'),detail=await dictionary('paymentRequestDetails'),finance=await dictionary('financeControl');
const button=(p,name)=>p.getByRole('button',{name,exact:true}).filter({visible:true});
async function setup(route,lang,width,mode='data'){
 const c=await browser.newContext({viewport:{width,height:1000}});const calls=[];
 await c.addInitScript(lang=>{if(!sessionStorage.getItem('initialized')){localStorage.setItem('app-language',lang);sessionStorage.setItem('initialized','1')}},lang);
 await c.route('**/*',async r=>{const u=r.request().url();if(u.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});if(u===`${origin}/mock-supabase/functions/v1/create-invoice-from-pr`){calls.push({path:'create-invoice-from-pr',body:r.request().postDataJSON()});return r.fulfill({contentType:'application/json',body:JSON.stringify({success:true,invoice_id:'fixture-invoice',items_count:1})})}if(u===`${origin}/mock-supabase/functions/v1/scan-drive-folder`){calls.push({path:'scan-drive-folder',body:r.request().postDataJSON()});return r.fulfill({contentType:'application/json',body:JSON.stringify({dates:[],files:[]})})}if(u===`${origin}/mock-supabase/functions/v1/export-npp-debt-sheet`){const body=r.request().postDataJSON();calls.push({path:'export-npp-debt-sheet',body});if(body.overwrite||body.sendEmail)return r.fulfill({contentType:'application/json',body:JSON.stringify({success:true,spreadsheetName:'Tên file giữ nguyên',attachmentName:'Tên file giữ nguyên.xlsx',recipientEmails:['fixture@example.invalid']})});return r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,code:'debt_sheet_exists',spreadsheetName:'Tên file giữ nguyên'})})}if(u.startsWith(origin+'/')&&r.request().method()==='GET'&&!u.includes('/mock-supabase/'))return r.continue();unexpected.push({url:u,method:r.request().method()});return r.abort()});
 const p=await c.newPage();p.setDefaultTimeout(7000);p.on('pageerror',e=>errors.push(e.message));await p.goto(`${origin}/${route}?fixture=${mode}${mode==='readonly'?'&readonly=1':''}`);return {c,p,calls};
}
for(const lang of ['en','vi'])for(const width of [390,1440])test(`NPP/direct debt ${lang} ${width}: edit, formula, canonical adjustment and revenue payload, switch/reload`,async()=>{
 const {c,p}=await setup('debt',lang,width),l=debt[lang],other=lang==='en'?'vi':'en';
 try{
  await p.getByRole('heading',{name:l.customerDebtManagement,exact:true}).waitFor();
  await p.getByRole('button').filter({hasText:'Khách giữ nguyên $&'}).click();await button(p,l.viewDebt).click();
  const adjustment=p.locator('[data-customer-debt-period-adjustment]');await adjustment.waitFor();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor();
  await adjustment.locator('input').nth(0).fill('5000');await adjustment.locator('input').nth(1).fill('10000');await adjustment.locator('input').nth(3).fill('Ghi chú giữ nguyên $&');
  assert.ok((await adjustment.innerText()).includes('25.000'));
  await button(p,l.saveDebt).click();await p.getByText(l.debtInformationSaved,{exact:true}).waitFor();
  const adjust=await p.evaluate(()=>window.__fixtureCalls.find(c=>c.rpc==='upsert_customer_debt_period_adjustment'));
  assert.equal(adjust.args._opening_balance_vnd,5000);assert.equal(adjust.args._amount_collected_vnd,10000);assert.equal(adjust.args._note,'Ghi chú giữ nguyên $&');assert.equal(adjust.args._customer_id,'direct');
  await button(p,l.edit).click();const dialog=p.getByRole('dialog');await dialog.getByRole('heading',{name:l.editDebtRevenue}).waitFor();
  const inputs=dialog.locator('input');await inputs.nth(4).fill('4');await inputs.nth(5).fill('12000');assert.equal(await inputs.nth(6).inputValue(),'48000');assert.equal(await inputs.nth(6).getAttribute('readonly'),'');
  await dialog.locator('textarea').fill('Audit giữ nguyên $&');
  await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await dialog.getByRole('heading',{name:debt[other].editDebtRevenue}).waitFor();assert.equal(await inputs.nth(4).inputValue(),'4');
  await button(p,debt[other].saveChanges).click();await dialog.waitFor({state:'hidden'});
  const edit=await p.evaluate(()=>window.__fixtureCalls.find(c=>c.rpc==='edit_revenue_ledger_line'));
  assert.equal(edit.args._patch.quantity,4);assert.equal(edit.args._patch.unit_price,12000);assert.equal(edit.args._patch.gross_revenue,48000);assert.equal(edit.args._patch.customer_name,'Khách giữ nguyên $&');assert.equal(edit.args._patch.item_note,'Ghi chú giữ nguyên');assert.equal(edit.args._patch.approval_status,'approved');assert.equal(edit.args._patch.audit_status,'adjusted');assert.equal(edit.args._patch.confidence_status,'manual_review');assert.equal(edit.args._patch.review_status,'resolved');assert.equal(edit.args._patch.reconciliation_status,'manual_override');assert.equal(edit.args._note,'Audit giữ nguyên $&');
  await p.reload();await p.getByRole('heading',{name:debt[other].customerDebtManagement,exact:true}).waitFor();
  await p.getByRole('button').filter({hasText:'Đại lý cấp 1 - Anh Thanh'}).click();await button(p,debt[other].viewDebt).click();await p.getByText('Đại lý giữ nguyên',{exact:true}).filter({visible:true}).click();
  assert.ok((await p.locator('body').innerText()).includes('18.000'));await button(p,debt[other].edit).waitFor();
  await button(p,width===390?debt[other].exportSheet:debt[other].exportGoogleSheet).click();await p.getByRole('dialog').getByRole('heading',{name:debt[other].thisDebtStatementFileAlreadyExists}).waitFor();assert.ok((await p.getByRole('dialog').innerText()).includes('Tên file giữ nguyên'));
  await p.screenshot({path:`${out}/debt-${lang}-${width}.png`,fullPage:true});cases.push({page:'NppDebtManagement',lang,width,states:['direct','NPP','expanded agency','fee calculation','adjustment RPC','revenue edit RPC','switch with open dialog','reload','export conflict dialog']});
 }finally{await c.close()}
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`payables ${lang} ${width}: actual detail and payment dialogs`,async()=>{
 const {c,p}=await setup('payables',lang,width),l=detail[lang],other=lang==='en'?'vi':'en';
 try{
  await p.getByText('QA-PR-1',{exact:true}).waitFor();await button(p,lang==='en'?'Details':'Chi tiết').first().click();const dialog=p.getByRole('dialog');await dialog.getByRole('heading',{name:l.paymentRequestDetails}).waitFor();assert.ok((await dialog.innerText()).includes('Bánh giữ nguyên'));
  await button(p,width===390?l.pay:l.recordPayment).click();const payment=p.getByRole('alertdialog');await payment.waitFor();await payment.locator('input').fill('10001');await button(payment,lang==='en'?'Still Mark as Paid':'Vẫn đánh dấu đã TT').click();await p.getByText(l.paymentAmountExceedsTheRemainingBalance,{exact:true}).waitFor();
  await button(p,width===390?l.pay:l.recordPayment).click();await payment.locator('input').fill('7000');await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await payment.getByText(detail[other].paymentAmountThisTime,{exact:true}).waitFor();await button(payment,other==='en'?'Still Mark as Paid':'Vẫn đánh dấu đã TT').click();await payment.waitFor({state:'hidden'});
  const calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.rpc==='record_payment_allocations'));assert.equal(calls.length,1);assert.deepEqual(calls[0].args.p_allocations,[{payment_request_id:'pr-1',amount:7000}]);assert.equal(calls[0].args.p_payment_method,null);
  await button(p,detail[other].changeMethod).click();const methodDialog=p.getByRole('alertdialog');await methodDialog.locator('[role="radio"][value="bank_transfer"]').click();await button(methodDialog,detail[other].saveChanges).click();await methodDialog.waitFor({state:'hidden'});
  const methodWrites=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.table==='payment_requests'&&c.operations.some(o=>o.method==='update')));assert.equal(methodWrites.length,1);assert.deepEqual(methodWrites[0].operations.find(o=>o.method==='update').args[0],{payment_method:'bank_transfer'});
  await p.screenshot({path:`${out}/payables-${lang}-${width}.png`,fullPage:true});await p.reload();await p.getByRole('heading',{name:other==='en'?'Accounts payable management':'Quản lý công nợ phải trả',exact:true}).waitFor();cases.push({page:'PayablesManagement',lang,width,states:['details','payment dialog','invalid payment','canonical allocation','switch with open dialog','reload']});
 }finally{await c.close()}
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`FinanceControl ${lang} ${width}: CEO and classification`,async()=>{
 const {c,p}=await setup('ceo',lang,width),l=finance[lang],other=lang==='en'?'vi':'en';
 try{
  await p.getByRole('heading',{name:l.ceoDeclaration,exact:true}).first().waitFor();await button(p,l.saveDeclaration).click();await p.getByText(l.ceoDeclarationSaved,{exact:true}).waitFor();
  await button(p,other.toUpperCase()).click();await p.getByText(finance[other].ceoDeclarationSaved,{exact:true}).waitFor();
  const writes=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.table==='ceo_daily_closing_declarations'&&c.operations.some(o=>o.method==='upsert')));assert.equal(writes.length,1);const payload=writes[0].operations.find(o=>o.method==='upsert').args[0];assert.equal(payload.unc_total_declared,0);assert.equal(payload.cash_fund_topup_amount,0);assert.equal(payload.extraction_meta.qtm_closing_balance,0);assert.equal(payload.notes,null);
  await p.getByRole('tab',{name:finance[other].monthlyClose,exact:true}).click();await p.getByText(finance[other].noDataYet,{exact:true}).waitFor();await p.reload();await p.getByRole('heading',{name:finance[other].ceoDeclaration,exact:true}).first().waitFor();
  await p.goto(origin+'/classification');await p.getByRole('heading',{name:finance[other].costClassification,exact:true}).waitFor();await p.getByText(finance[other].noBackfilledDataForThisMonthYet,{exact:true}).waitFor();await p.screenshot({path:`${out}/finance-${lang}-${width}.png`,fullPage:true});cases.push({page:'FinanceControl',lang,width,states:['CEO','save payload','persistent message switch','monthly empty','reload','classification empty']});
 }finally{await c.close()}
});
test.after(async()=>{await browser.close();await fs.writeFile(out+'/browser-results.json',JSON.stringify({cases,unexpected,errors},null,2));assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[])});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`extended nested dialogs ${lang} ${width}`,async()=>{
 const other=lang==='en'?'vi':'en';
 // Open the actual manual invoice dialog through the actual Payables detail action.
 {
  const {c,p,calls}=await setup('payables',lang,width,'invoice');const l=detail[lang];
  try{
   await p.getByText('QA-PR-1',{exact:true}).waitFor();await button(p,lang==='en'?'Details':'Chi tiết').first().click();await button(p,width===390?l.createManually:l.createInvoiceManually).click();
   const d=p.getByRole('dialog').last();await d.getByPlaceholder(invoice[lang].enterInvoiceNumber).waitFor();await p.waitForFunction(()=>[...document.querySelectorAll('textarea')].some(el=>el.value==='Tạo từ đề nghị chi QA-PR-1'));assert.equal(await d.locator('textarea').inputValue(),'Tạo từ đề nghị chi QA-PR-1');
   assert.ok((await d.innerText()).includes('15.000'));await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await d.getByPlaceholder(invoice[other].enterInvoiceNumber).waitFor();assert.equal(await d.locator('textarea').inputValue(),'Tạo từ đề nghị chi QA-PR-1');
   await button(d,invoice[other].createInvoice).click();await p.getByText(detail[other].invoiceCreatedSuccessfully,{exact:true}).waitFor();assert.equal(calls.length,1);assert.equal(calls[0].path,'create-invoice-from-pr');assert.equal(calls[0].body.payment_request_id,'pr-1');assert.equal(calls[0].body.notes,'Tạo từ đề nghị chi QA-PR-1');assert.equal(calls[0].body.vat_amount,0);assert.equal(calls[0].body.payment_slip_url,null);
   cases.push({page:'PayablesManagement',lang,width,states:['actual manual invoice dialog','currency/VAT','switch preserves stored note','invoice payload']});
  }finally{await c.close()}
 }
 // Pending request edit validation, approval choices, and rejection payload.
 {
  const {c,p}=await setup('payables',lang,width,'pending');const l=detail[lang];
  try{
   await p.getByText('QA-PR-1',{exact:true}).waitFor();await button(p,lang==='en'?'Details':'Chi tiết').first().click();await button(p,lang==='en'?'Edit':'Sửa').click();const d=p.getByRole('dialog').last();
   const title=d.getByPlaceholder(editCopy[lang].exampleJanuaryMaterialPurchasePaymentRequest);await title.fill('');await button(d,lang==='en'?'Save':'Lưu').click();await d.getByText(editCopy[lang].titleIsRequired,{exact:true}).waitFor();
   await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await d.getByText(editCopy[other].titleIsRequired,{exact:true}).waitFor();assert.equal(await d.getByPlaceholder(editCopy[other].exampleJanuaryMaterialPurchasePaymentRequest).inputValue(),'');await button(d,other==='en'?'Cancel':'Hủy').click();
   await button(p,detail[other].approve).click();const approve=p.getByRole('alertdialog');await approve.waitFor();assert.equal(await approve.locator('[role="radio"][value="cash"]').count(),1);assert.equal(await approve.locator('[role="radio"][value="bank_transfer"]').count(),1);await button(approve,other==='en'?'Cancel':'Hủy').click();
   await button(p,detail[other].reject).click();const reject=p.getByRole('alertdialog');await reject.locator('textarea').fill('Lý do giữ nguyên $&');await button(reject,detail[other].reject).click();await reject.waitFor({state:'hidden'});
   const writes=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.table==='payment_requests'&&c.operations.some(o=>o.method==='update')));assert.equal(writes.length,1);const payload=writes[0].operations.find(o=>o.method==='update').args[0];assert.equal(payload.status,'rejected');assert.equal(payload.rejection_reason,'Lý do giữ nguyên $&');assert.equal(payload.approved_by,null);
   cases.push({page:'PayablesManagement',lang,width,states:['edit validation switches language','approval payment-method values','reject dialog and canonical status/reason payload']});
  }finally{await c.close()}
 }
 // Actual Drive import starts only against mocked settings/HTTP and keeps its phase on switch.
 for(const mode of ['drive','drive-configured']){
  const {c,p,calls}=await setup('payables',lang,width,mode);
  try{
   await p.getByText('QA-PR-1',{exact:true}).waitFor();await button(p,lang==='en'?'Details':'Chi tiết').first().click();await button(p,width===390?detail[lang].createFromDrive:detail[lang].createInvoiceFromGoogleDrive).click();
   const key=mode==='drive'?'bankReceiptsFolderIsNotConfiguredConfigure':'noSubfolders';await p.getByText(drive[lang][key],{exact:true}).waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await p.getByText(drive[other][key],{exact:true}).waitFor();
   if(mode==='drive-configured'){assert.equal(calls.length,1);assert.deepEqual(calls[0],{path:'scan-drive-folder',body:{folderUrl:'https://drive.example.invalid/folder',mode:'list_children',parentPath:''}})}else assert.equal(calls.length,0);
   cases.push({page:'PayablesManagement',lang,width,states:[mode==='drive'?'Drive configuration error':'Drive empty folder picker','persistent Drive message switch without restarting import']});
  }finally{await c.close()}
 }
 // Actual nested form component, including its own reactive validation schema.
 {
  const {c,p}=await setup('add-request',lang,width);
  try{
   const d=p.getByRole('dialog');await button(d,dSku[lang].submitRequest).click();await d.getByText(dSku[lang].titleRequired,{exact:true}).waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await d.getByText(dSku[other].titleRequired,{exact:true}).waitFor();await d.getByPlaceholder(dSku[other].titleExample).fill('Tên giữ nguyên');assert.equal(await d.locator('input[value="old_order"]').count()+await d.getByRole('combobox').count()>0,true);
   assert.equal(await p.evaluate(()=>window.__fixtureCalls.some(c=>c.rpc)),false);cases.push({page:'AddPaymentRequestDialog',lang,width,states:['actual form','required validation','switch','business input preserved','no writes on invalid submit']});
  }finally{await c.close()}
 }
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`extended classification data ${lang} ${width}`,async()=>{
 const {c,p}=await setup('classification',lang,width,'classification-data'),l=finance[lang],other=lang==='en'?'vi':'en';
 try{
  await p.getByRole('heading',{name:l.costClassification,exact:true}).waitFor();await p.getByText('Nhóm giữ nguyên',{exact:true}).filter({visible:true}).last().click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor();assert.ok((await p.locator('body').innerText()).includes('15.000'));
  await button(p,l.editCategory).first().click();await p.getByRole('combobox').filter({visible:true}).first().waitFor();const before=await p.getByRole('combobox').filter({visible:true}).first().innerText();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);assert.equal(await p.getByRole('combobox').filter({visible:true}).first().innerText(),before);await p.getByText(finance[other].standardCode,{exact:true}).filter({visible:true}).first().waitFor();
  await p.screenshot({path:`${out}/classification-data-${lang}-${width}.png`,fullPage:true});cases.push({page:'FinanceControl',lang,width,states:['classification chart/table data','category details','edit category and standard-code controls','canonical category name survives switch']});
 }finally{await c.close()}
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`states ${lang} ${width}: loading, empty, errors, permissions`,async()=>{
 const other=lang==='en'?'vi':'en';
 for(const route of ['debt','payables','classification'])for(const mode of ['empty','loading','error','readonly']){
  const {c,p}=await setup(route,lang,width,mode);
  try{
   if(route==='payables'){
    if(mode==='loading')await p.locator('.animate-pulse').first().waitFor();
    if(mode==='empty')await p.getByText(lang==='en'?'No payables match the current filters.':'Không có công nợ phải trả phù hợp bộ lọc hiện tại.',{exact:true}).waitFor();
    if(mode==='error')await p.getByText(/SERVER giữ nguyên \$&/).first().waitFor();
    if(mode==='readonly'){await p.getByText('QA-PR-1',{exact:true}).waitFor();assert.equal(await button(p,lang==='en'?'Mark paid':'Đã trả').count(),0)}
   }else if(route==='debt'){
    if(mode==='empty'||mode==='error')await p.getByText(debt[lang].noMatchingCustomersFound,{exact:true}).waitFor();
    if(mode==='loading')assert.equal(await button(p,debt[lang].viewDebt).isDisabled(),true);
    if(mode==='readonly'){await p.getByRole('button').filter({hasText:'Khách giữ nguyên $&'}).click();await button(p,debt[lang].viewDebt).click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor();assert.equal(await button(p,debt[lang].saveDebt).isDisabled(),true);assert.equal(await button(p,debt[lang].edit).count(),0)}
   }else{
    if(mode==='loading')await p.getByText(finance[lang].loading,{exact:true}).waitFor();
    if(mode==='empty'||mode==='readonly')await p.getByText(finance[lang].noBackfilledDataForThisMonthYet,{exact:true}).waitFor();
    if(mode==='error')await p.getByText(finance[lang].classificationDataIsNotAvailableYetCheck,{exact:false}).waitFor();
   }
   await button(p,other.toUpperCase()).click();if(route==='debt')await p.getByRole('heading',{name:debt[other].customerDebtManagement,exact:true}).waitFor();if(route==='classification')await p.getByRole('heading',{name:finance[other].costClassification,exact:true}).waitFor();
   cases.push({page:route,lang,width,states:[mode,'language switch'],note:route==='debt'&&mode==='error'?'Existing behavior presents an empty customer list on query failure; no new error UI added.':undefined});
  }finally{await c.close()}
 }
 for(const route of ['ceo','debt','payables']){
  const {c,p}=await setup(route,lang,width,'save-error');
  try{
   if(route==='ceo'){await button(p,finance[lang].saveDeclaration).click();await p.getByText('SERVER giữ nguyên $&',{exact:true}).first().waitFor();}
   if(route==='payables'){await p.getByText('QA-PR-1',{exact:true}).waitFor();await button(p,lang==='en'?'Mark paid':'Đã trả').click();await p.getByText('SERVER giữ nguyên $&',{exact:true}).waitFor();}
   if(route==='debt'){await p.getByRole('button').filter({hasText:'Khách giữ nguyên $&'}).click();await button(p,debt[lang].viewDebt).click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor();await button(p,debt[lang].saveDebt).click();await p.getByText(debt[lang].unableToSaveDebtInformation,{exact:true}).waitFor();}
   cases.push({page:route,lang,width,states:['mocked save failure','localized failure feedback']});
  }finally{await c.close()}
 }
 {
  const {c,p}=await setup('ceo',lang,width);
  try{
   await button(p,finance[lang].approveCloseDay).click();const d=p.getByRole('dialog');await d.getByText(finance[lang].missingRoot,{exact:true}).waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await d.getByRole('heading',{name:finance[other].approveCloseDay,exact:true}).waitFor();await d.getByText(finance[other].missingRoot,{exact:true}).waitFor();
   cases.push({page:'FinanceControl',lang,width,states:['close-day preview','missing Drive config','dialog language switch']});
  }finally{await c.close()}
 }
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`exports and slip preview ${lang} ${width}`,async()=>{
 const other=lang==='en'?'vi':'en';
 {
  const {c,p,calls}=await setup('debt',lang,width);
  try{
   await p.getByRole('button').filter({hasText:'Khách giữ nguyên $&'}).click();await button(p,debt[lang].viewDebt).click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor();
   await button(p,width===390?debt[lang].exportSheet:debt[lang].exportGoogleSheet).click();const d=p.getByRole('dialog');await d.getByRole('heading',{name:debt[lang].thisDebtStatementFileAlreadyExists}).waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await button(d,debt[other].overwrite).click();await p.getByText(debt[other].googleSheetExported,{exact:true}).first().waitFor();await button(p,lang.toUpperCase()).click();await p.getByText(debt[lang].googleSheetExported,{exact:true}).first().waitFor();
   await button(p,debt[lang].sendDebtStatement).click();await p.getByText(debt[lang].debtStatementSent,{exact:true}).first().waitFor();await button(p,other.toUpperCase()).click();await p.getByText(debt[other].debtStatementSent,{exact:true}).first().waitFor();assert.ok((await p.locator('body').innerText()).includes('Tên file giữ nguyên.xlsx'));
   assert.equal(calls.length,3);assert.deepEqual(calls.map(x=>[x.body.sendEmail,x.body.overwrite]),[[false,false],[false,true],[true,false]]);for(const call of calls){assert.equal(call.body.customerId,'direct');assert.deepEqual(Object.keys(call.body).sort(),['customerId','fromDate','overwrite','sendEmail','toDate'])}
   cases.push({page:'NppDebtManagement',lang,width,states:['export conflict','overwrite confirmation','mocked export success','mocked email success','canonical export flags','persistent status switch']});
  }finally{await c.close()}
 }
 {
  const {c,p}=await setup('ceo',lang,width,'slips');
  try{
   const imageLabel=(l,type)=>finance[l].slipImage.replace('{type}',type).replace('{index}','1');const image=p.getByAltText(imageLabel(lang,'UNC'),{exact:true});await image.waitFor();assert.ok((await p.locator('body').innerText()).includes('3.000'));assert.ok((await p.locator('body').innerText()).includes('5.000'));await image.click();const d=p.getByRole('dialog');await d.getByRole('heading',{name:imageLabel(lang,'UNC'),exact:true}).waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),other);await d.getByRole('heading',{name:imageLabel(other,'UNC'),exact:true}).waitFor();await d.getByAltText(imageLabel(other,'UNC'),{exact:true}).waitFor();await p.screenshot({path:`${out}/slip-preview-${lang}-${width}.png`,fullPage:true});assert.equal(await p.evaluate(()=>window.__fixtureCalls.some(c=>c.operations?.some(o=>['update','upsert'].includes(o.method)))),false);
   cases.push({page:'FinanceControl',lang,width,states:['persisted slips and totals','actual image preview dialog','title/alt switch','no writes while viewing']});
  }finally{await c.close()}
 }
});
