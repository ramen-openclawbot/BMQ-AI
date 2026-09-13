import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const origin='http://127.0.0.1:4300',out='/tmp/bmq-i18n-lanes/b-purchasing';
const errors=[],unexpected=[],cases=[];
const visible=l=>l.filter({visible:true});
const button=(p,name)=>visible(p.getByRole('button',{name,exact:true}));
async function setup(route,lang,width,mode='data'){
 const c=await browser.newContext({viewport:{width,height:1000}});await c.addInitScript(lang=>localStorage.setItem('app-language',lang),lang);
 const edge=[];await c.route('**/*',r=>{const url=r.request().url();if(url===origin+'/fixture-document.svg')return r.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><text x="0" y="20">QA</text></svg>',contentType:'image/svg+xml'});if(url.startsWith(origin+'/')&&['GET','HEAD'].includes(r.request().method())&&!['fetch','xhr'].includes(r.request().resourceType()))return r.continue();if(url.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});if(mode==='receive'&&url==='https://backend.example.invalid/functions/v1/finalize-goods-receipt'){edge.push(r.request().postDataJSON());return r.fulfill({json:{success:true,receiptId:'44444444-4444-4444-8444-444444444444',payableId:'fixture-payable',totalAmount:20000,vatAmount:0,varianceSummary:{}}});}unexpected.push(url);return r.abort();});
 const p=await c.newPage();p.setDefaultTimeout(8000);p.on('pageerror',e=>errors.push(e.message));await p.goto(`${origin}/${route}?fixture=${mode}`);await visible(p.locator('h1')).first().waitFor();return {c,p,edge};
}
const copy={
 suppliers:{empty:['No suppliers yet','Chưa có nhà cung cấp'],error:['Unable to load suppliers','Không tải được danh sách nhà cung cấp']},
 invoices:{empty:['No matching invoices','Không có hóa đơn phù hợp'],error:["Couldn't load invoices",'Không thể tải hóa đơn']},
 'payment-requests':{empty:['No payment requests found','Không có đề nghị duyệt chi nào'],error:["Couldn't load data",'Không thể tải dữ liệu']},
 'goods-receipts':{empty:['No goods receipts yet','Chưa có phiếu nhập kho nào'],error:['Failed to load goods receipts. Please try again.','Lỗi tải dữ liệu phiếu nhập kho. Vui lòng thử lại.']},
 'purchase-orders':{empty:['No purchase orders','Không có PO'],error:['Failed to load','Lỗi tải dữ liệu']},
};
for(const [route,l] of Object.entries(copy))for(const lang of ['en','vi'])for(const width of [390,1440])for(const mode of ['empty','loading','error'])test(`${route} ${mode} ${lang} ${width} actual hooks and reactive copy`,async()=>{
 const {c,p}=await setup(route,lang,width,mode),i=lang==='en'?0:1;
 try{if(mode==='loading')await visible(p.locator('.animate-pulse,.animate-spin')).first().waitFor();else{const needle=l[mode][i];await visible(p.getByText(route==='purchase-orders'?new RegExp(needle):needle,{exact:route!=='purchase-orders'})).first().waitFor();await p.evaluate(lang=>window.__fixtureSetLanguage(lang),i===0?'vi':'en');await visible(p.getByText(route==='purchase-orders'?new RegExp(l[mode][1-i]):l[mode][1-i],{exact:route!=='purchase-orders'})).first().waitFor();}assert.deepEqual(await p.evaluate(()=>window.__fixtureUnexpected),[]);cases.push({route,lang,width,states:[mode,'switch']});}finally{await c.close();}
});
test.after(async()=>{await browser.close();await fs.writeFile(`${out}/states-results.json`,JSON.stringify({cases,errors,unexpected},null,2));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
