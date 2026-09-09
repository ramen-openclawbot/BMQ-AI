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
const payloads={};
for(const route of ['baseline-invoice','invoices'])test(`actual ${route} typed VAT payload`,async()=>{
 const {c,p}=await setup(route,'en',390);try{await button(p,'Add Invoice').click();await p.getByPlaceholder('e.g., INV-001').fill('QA-NEW-INV');await p.getByPlaceholder('Product name',{exact:true}).fill('Bột mới giữ nguyên');await p.getByLabel('Quantity',{exact:true}).fill('2');await p.getByLabel('Unit Price',{exact:true}).fill('10000');await p.getByLabel('VAT Amount (VND)',{exact:true}).fill('2000');await p.getByPlaceholder('Additional notes...').fill('Ghi chú mới $&');await button(p,'Create Invoice').click();await p.waitForFunction(()=>window.__fixtureCalls.some(c=>c.rpc==='create_invoice_with_material_controller'));payloads[route]=await p.evaluate(()=>window.__fixtureCalls.find(c=>c.rpc==='create_invoice_with_material_controller'));assert.deepEqual(await p.evaluate(()=>window.__fixtureUnexpected),[]);}finally{await c.close();}
});
test.after(async()=>{await browser.close();await fs.writeFile(`${out}/invoice-baseline-parity.json`,JSON.stringify({payloads,errors,unexpected},null,2));assert.deepEqual(payloads.invoices,payloads['baseline-invoice']);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
