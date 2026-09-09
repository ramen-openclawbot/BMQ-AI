import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs';
const origin='http://127.0.0.1:4301',out='/tmp/bmq-i18n-lanes/b-finance';
const browser=await chromium.launch({executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const unexpected=[],errors=[],captures=[];
try{
 for(const lang of ['en','vi'])for(const width of [390,1440])for(const route of ['debt','payables','ceo','classification']){
  const c=await browser.newContext({viewport:{width,height:1000},locale:'vi-VN',timezoneId:'Asia/Ho_Chi_Minh'});
  try{
   await c.addInitScript(lang=>localStorage.setItem('app-language',lang),lang);
   await c.route('**/*',r=>{const url=r.request().url();if(url.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});if(url.startsWith(origin+'/')&&r.request().method()==='GET'&&!url.includes('/mock-supabase/'))return r.continue();unexpected.push(url);return r.abort()});
   const p=await c.newPage();p.setDefaultTimeout(7000);p.on('pageerror',e=>errors.push(e.message));
   await p.goto(`${origin}/${route}?fixture=${route==='ceo'?'slips':route==='classification'?'classification-data':'data'}`);
   if(route==='debt'){await p.getByRole('button').filter({hasText:'Khách giữ nguyên $&'}).click();await p.getByRole('button',{name:lang==='en'?'View debt':'Xem công nợ',exact:true}).click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor()}
   if(route==='payables'){await p.getByText('QA-PR-1',{exact:true}).waitFor();await p.getByRole('button',{name:lang==='en'?'Details':'Chi tiết',exact:true}).filter({visible:true}).first().click();await p.getByRole('dialog').getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor()}
   if(route==='ceo'){await p.getByAltText(lang==='en'?'UNC slip 1':'Chứng từ UNC 1',{exact:true}).waitFor()}
   if(route==='classification'){await p.getByText('Nhóm giữ nguyên',{exact:true}).filter({visible:true}).last().click();await p.getByText('Bánh giữ nguyên',{exact:true}).filter({visible:true}).waitFor()}
   const screenshot=`${out}/visual-${route}-${lang}-${width}.png`;
   await p.screenshot({path:screenshot,fullPage:true,animations:'disabled'});
   const dimensions=await p.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(dimensions.document<=dimensions.viewport+1,`${route} ${lang} ${width}: document overflows`);
   captures.push({route,lang,width,screenshot,dimensions});
  }finally{await c.close()}
 }
}finally{await browser.close();await fs.writeFile(out+'/visual-results.json',JSON.stringify({captures,unexpected,errors},null,2))}
assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);console.log(`PASS: ${captures.length} stable EN/VI responsive captures; no document overflow, unexpected network, or page errors.`);
