import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const origin = 'http://127.0.0.1:4196';
await fs.mkdir('/tmp/bmq-i18n-a-review-qa', { recursive: true });
const browser = await chromium.launch({executablePath:process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const external=[];
const pageErrors=[];
const vis=l=>l.filter({visible:true});
const txt=(p,s)=>vis(p.getByText(s,{exact:true}));
const btn=(p,s)=>vis(p.getByRole('button',{name:s,exact:true}));
async function setup(lang='en',width=1440,storage='ok') {
  const c=await browser.newContext({viewport:{width,height:1000}});
  await c.addInitScript(({lang,storage})=>{
    localStorage.setItem('app-language',lang);
    if(storage==='getter') Object.defineProperty(window,'localStorage',{get(){throw new Error('Synthetic storage getter failure');}});
    if(storage==='method') Storage.prototype.getItem=()=>{throw new Error('Synthetic storage method failure');};
    const native=window.fetch.bind(window);
    window.fetch=async(input,init)=>String(input).startsWith('https://api.vnagent.ai/')?new Response(JSON.stringify(String(input).includes('/auth/')?{token:'fixture-only'}:String(input).endsWith('/agents')?[{id:'legal'}]:[]),{status:200}):native(input,init);
    window.WebSocket=class {static OPEN=1;readyState=1;constructor(){setTimeout(()=>this.onopen?.({}),10);}send(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'hello_ack'})}),10);}close(){this.readyState=3;}};
  },{lang,storage});
  await c.route('**/*',r=>{const u=r.request().url();if(u.startsWith(origin))return r.continue();if(['dathang.banhmique.vn','baocao.banhmique.vn'].includes(new URL(u).hostname))return r.fetch({url:origin+new URL(u).pathname+new URL(u).search}).then(response=>r.fulfill({response}));if(u.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});external.push(u);return r.abort();});
  const p=await c.newPage();p.on('pageerror',e=>{if(e.message!=='Synthetic render failure')pageErrors.push(e.message);});p.setDefaultTimeout(5000);return {c,p};
}
for(const lang of ['en','vi'])for(const width of [1440,390])test(`level-2 exact name and no placeholder ${lang} ${width}`,async()=>{
  const {c,p}=await setup(lang,width);try {
    await p.goto(`${origin}/sku-costs/management?role=staff`);
    await btn(p,lang==='en'?'Create SKU':'Tạo SKU').click();
    await btn(p,lang==='en'?'+ Add level 1 material':'+ Thêm NVL cấp 1').click();
    await vis(p.getByRole('dialog').getByRole('combobox')).first().click();await p.getByRole('option').first().click();
    await btn(p,lang==='en'?'+ Add level 2 material':'+ Thêm NVL cấp 2').click();
    const label=(lang==='en'?'Level 2 material · ':'NVL cấp 2 · ')+'Bột mì thử nghiệm';
    await txt(p,label).waitFor();assert.ok(!(await p.getByRole('dialog').innerText()).includes('{name}'));
  } finally {await c.close();}
});
for(const storage of ['getter','method'])test(`boundary survives storage ${storage} and retry recovers`,async()=>{
 const {c,p}=await setup('en',1440,storage);try{await p.goto(`${origin}/sku-costs/dashboard?crash=1`);await txt(p,'Đã xảy ra lỗi').waitFor();await p.evaluate(()=>window.__fixtureRecovered=true);await btn(p,'Thử lại').click();await txt(p,'Recovered fixture').waitFor();}finally{await c.close();}
});
for(const route of ['/kho','/kho/','/dealer','/dealer/promotion/test','/auth','/trace/test','/recover','/?recover=1'])test(`excluded ${route} stays VI with staff EN`,async()=>{
 const {c,p}=await setup();try{await p.goto(`${origin}${route}${route.includes('?')?'&':'?'}crash=1`);await txt(p,'Đã xảy ra lỗi').waitFor();assert.equal(await txt(p,'Something went wrong').count(),0);}finally{await c.close();}
});
for(const host of ['dathang.banhmique.vn','baocao.banhmique.vn'])test(`excluded host ${host} stays VI`,async()=>{const {c,p}=await setup();try{await p.goto(`http://${host}/?crash=1`);await txt(p,'Đã xảy ra lỗi').waitFor();}finally{await c.close();}});
test('staff boundary retains EN',async()=>{const {c,p}=await setup();try{await p.goto(`${origin}/sku-costs/dashboard?crash=1`);await txt(p,'Something went wrong').waitFor();}finally{await c.close();}});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`revenue card actual ${lang} ${width} rendering, actions, payloads and errors`,async()=>{
 const {c,p}=await setup(lang,width);const en=lang==='en';
 async function open(mode){await p.goto(`${origin}/finance-control/revenue?revenue=${mode}`);await btn(p,en?'Open VNAgent':'Mở VNAgent').click();await txt(p,en?'Provisionally controlled revenue':'Doanh thu tạm kiểm soát').waitFor();}
 try{
  await open('report');await txt(p,en?'Revenue date':'Ngày doanh thu').waitFor();await txt(p,'15.000đ').waitFor();await txt(p,en?'Rows / Qty':'Dòng / SL').waitFor();await txt(p,en?'Auto daily cron report':'Báo cáo cron daily tự động').waitFor();await txt(p,en?'This figure is provisional, not yet a trusted/month-end audited source.':'Số này là tạm kiểm soát, chưa phải trusted/month-end audited source.').waitFor();
  await btn(p,en?'Run daily parse':'Chạy parse daily').click();await txt(p,en?'Compare current daily revenue':'So sánh daily revenue hiện tại').waitFor();await txt(p,'Kênh giữ nguyên').waitFor();await vis(p.getByText(en?/^Row delta\s*1$/:/^Dòng delta\s*1$/)).waitFor();
  await p.screenshot({path:`/tmp/bmq-i18n-a-review-qa/revenue-${lang}-${width}.png`,fullPage:true});
  await btn(p,en?'Confirm overwrite':'Xác nhận ghi đè').click();await txt(p,en?'Compare current daily revenue':'So sánh daily revenue hiện tại').waitFor({state:'hidden'});
  let calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.function).map(c=>c.body));assert.deepEqual(calls,[{action:'latest_auto_daily_report'},{action:'preview_daily_compare',revenueDate:'2026-09-03'},{action:'confirm_daily_overwrite',runId:'run-fixture',confirmCancelReplacement:true},{action:'latest_auto_daily_report'}]);
  await btn(p,en?'Run daily parse':'Chạy parse daily').click();await btn(p,en?'Cancel':'Hủy').click();calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.function).map(c=>c.body));assert.deepEqual(calls.at(-1),{action:'cancel_daily_preview',runId:'run-fixture'});
  await btn(p,en?'Ledger details':'Ledger chi tiết').click();await p.waitForURL('**/finance-control/revenue/sources?**');assert.equal(new URL(p.url()).search,'?period=2026-09&sourceDocumentId=source-fixture&revenue_date=2026-09-03');
  await open('empty');await txt(p,en?'No active auto daily cron source found.':'Chưa tìm thấy auto daily cron source đang active.').waitFor();await btn(p,en?'Run daily parse':'Chạy parse daily').click();await txt(p,en?'No daily revenue for this date':'Chưa có daily revenue cho ngày này').waitFor();await btn(p,en?'Confirm ledger entry':'Xác nhận ghi ledger').waitFor();
  calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.function).map(c=>c.body));assert.deepEqual(calls.at(-1),{action:'preview_daily_compare'});
  await btn(p,en?'Confirm ledger entry':'Xác nhận ghi ledger').click();await txt(p,en?'No daily revenue for this date':'Chưa có daily revenue cho ngày này').waitFor({state:'hidden'});calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.function).map(c=>c.body));assert.deepEqual(calls.at(-2),{action:'confirm_daily_overwrite',runId:'run-fixture'});
  for(const [mode,vi,eng] of [['no-message','Không tải được báo cáo daily.','Unable to load the daily report.'],['load-error','Không tải được báo cáo daily.','Unable to load the daily report.'],['preview-error','Không chạy được preview daily.','Unable to run the daily preview.'],['post-error','Không ghi được daily revenue.','Unable to write daily revenue.'],['server-error','SERVER giữ nguyên $&','SERVER giữ nguyên $&']]){
   await open(mode);if(['preview-error','post-error'].includes(mode))await btn(p,en?'Run daily parse':'Chạy parse daily').click();if(mode==='post-error')await btn(p,en?'Confirm overwrite':'Xác nhận ghi đè').click();await txt(p,en?eng:vi).waitFor();
   if(mode==='load-error'){const before=await p.evaluate(()=>window.__fixtureCalls.length);await p.evaluate(lang=>window.__fixtureSetLanguage(lang),en?'vi':'en');await txt(p,en?vi:eng).waitFor();assert.equal(await p.evaluate(()=>window.__fixtureCalls.length),before,'Changing error language must not invoke a revenue action');await p.evaluate(lang=>window.__fixtureSetLanguage(lang),lang);}
  }
 }finally{await c.close();}
});
for(const lang of ['en','vi'])test(`staff cannot open owner revenue widget ${lang}`,async()=>{const {c,p}=await setup(lang);try{await p.goto(`${origin}/finance-control/revenue?role=staff`);await p.locator('[data-fixture-outside-scope]').waitFor();assert.equal(await btn(p,lang==='en'?'Open VNAgent':'Mở VNAgent').count(),0);assert.deepEqual(await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.function)),[]);}finally{await c.close();}});
test.after(async()=>{await browser.close();await fs.writeFile('/tmp/bmq-i18n-a-review-qa/external-requests.json',JSON.stringify(external));await fs.writeFile('/tmp/bmq-i18n-a-review-qa/page-errors.json',JSON.stringify(pageErrors));assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);});
