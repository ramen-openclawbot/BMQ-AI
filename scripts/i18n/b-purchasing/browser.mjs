import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const origin='http://127.0.0.1:4300',out='/tmp/bmq-i18n-lanes/b-purchasing';
const unexpected=[],errors=[],cases=[];
const labels={suppliers:{en:'Suppliers',vi:'Nhà cung cấp'},invoices:{en:'Invoice Management',vi:'Quản lý hóa đơn'},'payment-requests':{en:'Payment Requests',vi:'Duyệt chi'},'goods-receipts':{en:'Goods Receipts',vi:'Phiếu Nhập Kho'},'purchase-orders':{en:'PO (Purchasing)',vi:'PO (Mua hàng)'}};
async function setup(route,lang,width,mode='data'){
 const c=await browser.newContext({viewport:{width,height:1000}});await c.addInitScript(lang=>{if(!sessionStorage.getItem('init')){localStorage.setItem('app-language',lang);sessionStorage.setItem('init','1');}},lang);
 await c.route('**/*',r=>{const u=r.request().url();if(u.startsWith(origin+'/')&&['GET','HEAD'].includes(r.request().method())&&!['fetch','xhr'].includes(r.request().resourceType()))return r.continue();if(u.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});unexpected.push(u);return r.abort();});
 const p=await c.newPage();p.setDefaultTimeout(6000);p.on('pageerror',e=>errors.push(`${route}: ${e.message}`));await p.goto(`${origin}/${route}?fixture=${mode}`);return {c,p};
}
for(const route of Object.keys(labels))for(const lang of ['en','vi'])for(const width of [390,1440])test(`${route} ${lang} ${width}: actual page, reactive switch/reload`,async()=>{
 const {c,p}=await setup(route,lang,width);
 try{await p.locator('h1').filter({visible:true}).first().waitFor();await p.getByText('NCC giữ nguyên',{exact:true}).filter({visible:true}).first().waitFor();const before=await p.locator('h1').filter({visible:true}).first().innerText();await fs.writeFile(`${out}/${route}-${lang}-${width}.txt`,await p.locator('body').innerText());const other=lang==='en'?'vi':'en';await p.getByRole('button',{name:other.toUpperCase(),exact:true}).click();await p.waitForFunction(before=>Array.from(document.querySelectorAll('h1')).find(e=>e.offsetWidth)?.textContent?.trim()!==before,before);const after=await p.locator('h1').filter({visible:true}).first().innerText();assert.notEqual(before,after);await p.reload();await p.locator('h1').filter({visible:true}).first().waitFor();assert.equal(await p.locator('h1').filter({visible:true}).first().innerText(),after);assert.deepEqual(await p.evaluate(()=>window.__fixtureUnexpected),[]);await p.screenshot({path:`${out}/${route}-${lang}-${width}.png`,fullPage:true});cases.push({route,lang,width,states:['data','switch','reload']});}finally{await c.close();}
});
test.after(async()=>{await browser.close();await fs.writeFile(`${out}/browser-results.json`,JSON.stringify({cases,errors,unexpected},null,2));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
