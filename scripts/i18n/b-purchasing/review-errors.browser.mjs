// PENDING sequential browser gate: do not run alongside another lane/heavy job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {root} from './inventory.mjs';
const read=name=>JSON.parse(fs.readFileSync(`${root}/apps/web/src/i18n/${name}.ts`,'utf8').split(' = ')[1].replace(/;\s*$/,''));
const gr=read('goodsReceiptPurchasing'),drive=read('drivePurchasing');
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const origin='http://127.0.0.1:4300',edge='https://backend.example.invalid/functions/v1/';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const cases=[],unexpected=[],errors=[];
const visible=l=>l.filter({visible:true});
async function setup(route,mode,lang,width){
 const c=await browser.newContext({viewport:{width,height:1000}});
 await c.addInitScript(lang=>localStorage.setItem('app-language',lang),lang);
 await c.route('**/*',r=>{
  const request=r.request(),url=request.url();
  if(url.startsWith(origin+'/')&&['GET','HEAD'].includes(request.method())&&!['fetch','xhr'].includes(request.resourceType()))return r.continue();
  if(url.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});
  if(url===edge+'scan-invoice'&&mode==='review-scan-local')return r.fulfill({json:{success:false}});
  // Deliberately identical to an EN local label: backend provenance must win after switching to VI.
  if(url===edge+'scan-invoice'&&mode==='review-scan-backend')return r.fulfill({status:400,json:{error:gr.en.noValidScanDataReceived}});
  if(url===edge+'scan-drive-folder'&&mode.startsWith('review-drive-')){
   const body=request.postDataJSON();
   if(mode==='review-drive-backend')return r.fulfill({status:400,json:{error:drive.en.unableToScanGoogleDriveFolder}});
   if(body.mode==='list_all_dates')return r.fulfill({json:{dates:[{date:'09092026',folderId:'fixture-date'}]}});
   return r.fulfill({json:{files:[{id:'fixture-slip',name:'UNC giữ nguyên.png',base64:png.toString('base64'),mimeType:'image/png'}]}});
  }
  if(url===edge+'scan-bank-slip'&&mode==='review-drive-local')return r.fulfill({status:400,json:{}});
  if(url===edge+'scan-bank-slip'&&mode==='review-drive-no-amount')return r.fulfill({json:{data:{amount:0}}});
  unexpected.push({url,method:request.method()});return r.abort();
 });
 const p=await c.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));try{await p.goto(`${origin}/${route}?fixture=${mode}`);return {c,p};}catch(error){await c.close();throw error;}
}
async function switchAndAssert(p,scope,copy,key,lang,backend=false){
 await scope.getByText(backend?copy.en[key]:copy[lang][key],{exact:true}).waitFor();
 const other=lang==='en'?'vi':'en';await p.evaluate(next=>window.__fixtureSetLanguage(next),other);
 await scope.getByText(backend?copy.en[key]:copy[other][key],{exact:true}).waitFor();
 await p.evaluate(next=>window.__fixtureSetLanguage(next),lang);
 await scope.getByText(backend?copy.en[key]:copy[lang][key],{exact:true}).waitFor();
 assert.deepEqual(await p.evaluate(()=>window.__fixtureUnexpected),[]);
}
for(const lang of ['en','vi'])for(const width of [390,1440]){
 for(const mode of ['review-session','review-scan-local','review-scan-backend'])test(`actual AddGoodsReceipt persistent ${mode} ${lang} ${width}`,async()=>{
  const {c,p}=await setup('goods-receipts',mode,lang,width);try{
   await visible(p.getByRole('button',{name:lang==='en'?'Create receipt':'Tạo Phiếu Nhập',exact:true})).click();
   const d=p.getByRole('dialog');await d.locator('#delivery-note-image').setInputFiles({name:'ghi-chu.png',mimeType:'image/png',buffer:png});
   const key=mode==='review-session'?'yourSessionExpiredPleaseSignInAgain':'noValidScanDataReceived';
   await switchAndAssert(p,d,gr,key,lang,mode.endsWith('backend'));cases.push({mode,lang,width});
  }finally{await c.close();}
 });
 for(const mode of ['review-ocr-local','review-ocr-backend'])test(`actual GoodsReceiptDetails hook persistent ${mode} ${lang} ${width}`,async()=>{
  const {c,p}=await setup('goods-receipts',mode,lang,width);try{
   await visible(p.getByText('QA-GR-1',{exact:true})).click();const d=p.getByRole('dialog');
   await d.locator('[data-bmq-goods-receipt-ocr-assist] input[type=file]').setInputFiles({name:'delivery.png',mimeType:'image/png',buffer:png});
   await switchAndAssert(p,d,gr,'ocrFailed',lang,mode.endsWith('backend'));cases.push({mode,lang,width});
  }finally{await c.close();}
 });
 for(const mode of ['review-drive-session','review-drive-local','review-drive-no-amount','review-drive-backend'])test(`actual Drive persistent ${mode} ${lang} ${width}`,async()=>{
  const {c,p}=await setup('review-drive',mode,lang,width);try{
   const d=p.getByRole('dialog');
   if(mode==='review-drive-local'||mode==='review-drive-no-amount')await d.getByRole('button',{name:new RegExp(lang==='en'?'Update.*All':'Cập nhật.*Tất cả','i')}).click();
   const key=mode==='review-drive-session'?'yourSessionExpiredPleaseSignInAgain':mode==='review-drive-local'?'unableToReadBankSlipInformation':mode==='review-drive-no-amount'?'noAmountFoundOnTheBankSlip':'unableToScanGoogleDriveFolder';
   await switchAndAssert(p,d,drive,key,lang,mode.endsWith('backend'));cases.push({mode,lang,width});
  }finally{await c.close();}
 });
}
test.after(async()=>{await browser.close();fs.writeFileSync('/tmp/bmq-i18n-lanes/b-purchasing/review-errors-browser-results.json',JSON.stringify({cases,unexpected,errors},null,2));assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
