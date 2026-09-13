// DEFERRED: run only in the parent's serialized browser gate with fixture Vite on 4301.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs';
const origin='http://127.0.0.1:4301',out='/tmp/bmq-i18n-lanes/b-finance/review-fix';
const copy=JSON.parse((await fs.readFile('apps/web/src/i18n/financeControl.ts','utf8')).replace(/^[\s\S]*?export const \w+ = /,'').replace(/;\s*$/,''));
const format=(s,data)=>s.replace(/\{(\w+)\}/g,(_,key)=>String(data[key]));
const tiny='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2l8AAAAASUVORK5CYII=';
const browser=await chromium.launch({executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const results=[],unexpected=[],pageErrors=[];
test.after(async()=>{await browser.close();await fs.mkdir(out,{recursive:true});await fs.writeFile(`${out}/browser-results.json`,JSON.stringify({results,unexpected,pageErrors},null,2));assert.deepEqual(unexpected,[]);assert.deepEqual(pageErrors,[]);});
async function setup(lang,width,scenario){
 const context=await browser.newContext({viewport:{width,height:900},locale:'vi-VN',timezoneId:'Asia/Ho_Chi_Minh'});
 const calls=[],files=scenario.types.flatMap(type=>(scenario.partial?['local','server','ok']:['local','server']).map(kind=>({id:`${type}-${kind}`,name:`${type}-${kind}.png`,mimeType:'image/png'})));
 const imageMap=new Map(files.map((file,i)=>[tiny+'\n'.repeat(i+1),file]));
 await context.addInitScript(lang=>localStorage.setItem('app-language',lang),lang);
 await context.route('**/*',async route=>{
  const request=route.request(),url=request.url();
  if(url.startsWith('https://fonts.googleapis.com/'))return route.fulfill({contentType:'text/css',body:''});
  if(url===`${origin}/mock-supabase/functions/v1/scan-drive-folder`){
   const body=request.postDataJSON();calls.push({path:'scan',body});
   if(body.mode==='download_file'){
    const file=files.find(file=>file.id===body.fileId);assert.ok(file,'known download');
    const base64=[...imageMap].find(([,item])=>item.id===file.id)[0];
    return route.fulfill({contentType:'application/json',body:JSON.stringify({file:{...file,base64}})});
   }
   if(scenario.auth==='preview'||(scenario.auth==='reconcile'&&body.folderType==='bank_slip'))return route.fulfill({status:401,contentType:'application/json',body:'{}'});
   const type=body.subfolderDate.endsWith('/UNC')?'unc':'qtm',selected=files.filter(file=>file.id.startsWith(type));
   return route.fulfill({contentType:'application/json',body:JSON.stringify({files:selected,totalFilesFound:selected.length})});
  }
  if(url===`${origin}/mock-supabase/functions/v1/finance-extract-slip-amount`){
   const body=request.postDataJSON(),file=imageMap.get(body.imageBase64);calls.push({path:'ocr',body});assert.ok(file,'OCR retains fixture base64');assert.equal(body.slipType,file.id.split('-')[0]);
   // Both the local zero-result error and a genuine server string use the same English text.
   const localName=file.name.replace('-server','-local');
   if(file.id.endsWith('-server'))return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:format(copy.en.zeroOcr,{file:localName})})});
   return route.fulfill({contentType:'application/json',body:JSON.stringify({data:{amount:file.id.endsWith('-ok')?100:0,confidence:1}})});
  }
  if(url.startsWith(origin+'/')&&request.method()==='GET'&&!url.includes('/mock-supabase/'))return route.continue();
  unexpected.push({url,method:request.method()});return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(error.message));
 try{await page.goto(`${origin}/ceo?fixture=review-ocr`);await page.getByAltText(format(copy[lang].slipImage,{type:'UNC',index:1}),{exact:true}).first().waitFor();return {context,page,calls,files};}catch(error){await context.close();throw error;}
}
for(const lang of ['en','vi'])for(const width of [390,1440])for(const types of [['unc'],['qtm'],['unc','qtm']])for(const partial of [false,true])test(`retained OCR ${types.join('+')} ${partial?'partial':'total'} ${lang} ${width}`,async()=>{
 const {context,page,calls,files}=await setup(lang,width,{types,partial});
 try{
  await page.getByRole('button',{name:copy[lang].approveCloseDay,exact:true}).click();const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:copy[lang].execute,exact:true}).click();
  await dialog.getByText(/OCR (extracted|đọc được)/).waitFor();
  const networkCount=calls.length;
  for(const current of ['en','vi','en']){
   await page.evaluate(lang=>window.__fixtureSetLanguage(lang),current);
   const error=dialog.locator('.text-destructive').filter({hasText:/OCR (extracted|đọc được)/});await error.waitFor();const text=await error.innerText();
   for(const type of types){
    assert.ok(text.includes(format(copy[current].ocrFailureScope,{type:type.toUpperCase(),successful:partial?1:0,total:partial?3:2,failed:2})),text);
    assert.ok(text.includes(`${type}-local.png: ${format(copy[current].zeroOcr,{file:`${type}-local.png`})}`),text);
    assert.ok(text.includes(`${type}-server.png: ${format(copy.en.zeroOcr,{file:`${type}-local.png`})}`),text);
   }
   assert.equal(await dialog.getByRole('button',{name:copy[current].execute,exact:true}).isDisabled(),true,'failure stops closing');
  }
  assert.equal(calls.length,networkCount,'language switching must not repeat scan/OCR');
  const writes=await page.evaluate(()=>window.__fixtureCalls.filter(call=>call.operations?.some(op=>op.method==='upsert')));
  const markers=writes.filter(call=>call.table==='drive_file_index');assert.equal(markers.length,1);
  const rows=markers[0].operations.find(op=>op.method==='upsert').args[0];assert.equal(rows.length,files.length);
  for(const row of rows){const ok=row.file_id.endsWith('-ok');assert.equal(row.processed,ok);assert.equal(row.extracted_amount,ok?100:null);assert.equal(row.extraction_confidence,ok?1:null);assert.equal(row.processed_at===null,!ok);}
  assert.equal(writes.filter(call=>call.table==='ceo_daily_closing_declarations').length,1,'only initial declaration save; no post-failure closing write');
  assert.equal(calls.filter(call=>call.path==='ocr').length,files.length);
  results.push({lang,width,types,partial,states:['actual OCR local/backend failures','EN→VI→EN','processed flags','fail-closed']});
 }finally{await context.close();}
});
for(const lang of ['en','vi'])for(const width of [390,1440])for(const auth of ['preview','reconcile'])test(`retained nested401 ${auth} ${lang} ${width}`,async()=>{
 const {context,page,calls}=await setup(lang,width,{types:['unc','qtm'],partial:false,auth});
 try{
  await page.getByRole('button',{name:copy[lang].approveCloseDay,exact:true}).click();const dialog=page.getByRole('dialog');
  if(auth==='reconcile')await dialog.getByRole('button',{name:copy[lang].execute,exact:true}).click();
  await dialog.getByText(copy[lang].sessionExpired,{exact:false}).waitFor();const count=calls.length;
  for(const current of ['en','vi','en']){await page.evaluate(lang=>window.__fixtureSetLanguage(lang),current);await dialog.getByText(copy[current].sessionExpired,{exact:false}).waitFor();assert.equal(await dialog.getByRole('button',{name:copy[current].execute,exact:true}).isDisabled(),true);}
  assert.equal(calls.length,count);assert.equal(calls.filter(call=>call.path==='ocr').length,0);
  const writes=await page.evaluate(()=>window.__fixtureCalls.filter(call=>call.operations?.some(op=>op.method==='upsert')));assert.equal(writes.length,auth==='preview'?0:1);
  results.push({lang,width,auth,states:['nested401','EN→VI→EN','fail-closed']});
 }finally{await context.close();}
});
