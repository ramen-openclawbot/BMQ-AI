import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT||'/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const origin='http://127.0.0.1:4307',artifacts='/tmp/bmq-i18n-lanes/d-sku';
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM||'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox'],headless:true});
const cases=[];
const configs={
 products:{endpoint:'/api/products/api/',title:['SKU thành phẩm','Finished SKUs'],add:['Thêm sản phẩm','Add product'],update:['Cập nhật sản phẩm','Update product'],row:{id:1,sku_code:'SKU-1',name:'Bánh giữ nguyên',category:'other',unit:'piece',selling_price:12345,status:'active'},payload:{sku_code:'SKU-1',name:'Bánh giữ nguyên',category:'other',unit:'piece',selling_price:12345,status:'active'}},
 ingredients:{endpoint:'/api/inventory/ingredients/api/',title:['Nguyên liệu','Ingredients'],add:['Thêm nguyên liệu','Add ingredient'],update:['Cập nhật nguyên liệu','Update ingredient'],row:{id:1,name:'Bột giữ nguyên',category:'other',unit:'kg',current_stock:3,minimum_stock:2,current_cost_per_unit:12345},payload:{name:'Bột giữ nguyên',category:'other',unit:'kg',current_stock:3,minimum_stock:2,current_cost_per_unit:12345}},
 employees:{endpoint:'/api/labor/employees/api/',title:['Nhân sự','Employees'],add:['Thêm nhân sự','Add employee'],update:['Cập nhật nhân sự','Update employee'],row:{id:1,employee_id:'NV-1',name:'Tên giữ nguyên',role:'baker',hire_date:'2026-09-01',phone:'0123',email:'staff@example.invalid',wage_type:'monthly_salary',base_rate:12345,status:'active'},payload:{employee_id:'NV-1',name:'Tên giữ nguyên',role:'baker',hire_date:'2026-09-01',phone:'0123',email:'staff@example.invalid',wage_type:'monthly_salary',base_rate:12345}},
 overhead:{endpoint:'/api/overhead/costs/api/',title:['Chi phí chung','Overhead costs'],add:['Thêm chi phí','Add cost'],update:['Cập nhật chi phí','Update cost'],row:{id:1,category_id:7,category:'Chi phí giữ nguyên',amount:12345,month:'2026-09'},payload:{category_id:7,amount:12345,month:'2026-09'}},
};
const visible=l=>l.filter({visible:true});
const button=(p,n)=>visible(p.getByRole('button',{name:n,exact:true}));
const text=(p,n)=>visible(p.getByText(n,{exact:true}));
async function has(l){await l.first().waitFor({state:'visible',timeout:10000});}
async function run(name,lang,width,mode,fn){
 if(process.env.BMQ_CASE&&!`${name}-${lang}-${width}-${mode}`.includes(process.env.BMQ_CASE))return;
 const entry={name,lang,width,mode,passed:false};cases.push(entry);
 const context=await browser.newContext({viewport:{width,height:width===390?844:1000},timezoneId:'Asia/Ho_Chi_Minh',locale:'vi-VN',serviceWorkers:'block'});
 const writes=[],unexpected=[],errors=[];
 await context.addInitScript(lang=>{localStorage.setItem('app-language',localStorage.getItem('app-language')||lang);window.WebSocket=class {constructor(){throw new Error('Unexpected WebSocket')}};},lang);
 await context.route('**/*',async route=>{const request=route.request(),u=new URL(request.url());
  if(u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2')return route.fulfill({contentType:'text/css',body:''});
  if(u.origin!==origin){unexpected.push(request.url());return route.abort();}
  const config=Object.values(configs).find(c=>u.pathname===c.endpoint||u.pathname===c.endpoint+'1/');
  if(u.pathname==='/fixture/functions/v1/scan-invoice'&&request.method()==='POST'){
   writes.push({path:u.pathname,method:'POST',body:request.postDataJSON()});
   await new Promise(resolve=>setTimeout(resolve,700));
   return route.fulfill({json:{data:{invoice_number:'INV-fixture',vat_amount:1000,items:[{product_name:'Bánh OCR giữ nguyên',quantity:2,unit:'kg',unit_price:12000,ocr_cost_classification:{suggested_standard_cost_code:'NVL-001',canonical_cost_item_name:'Bột chuẩn giữ nguyên',standard_cost_code_type:'NVL'}}]}}});
  }
  if(config){
   if(request.method()!=='GET'){writes.push({path:u.pathname,method:request.method(),body:request.postDataJSON()});return route.fulfill({json:{}});}
   if(mode==='loading'){await new Promise(resolve=>setTimeout(resolve,1200));return route.fulfill({json:{items:[]}});}
   return route.fulfill({status:mode==='error'?500:200,json:{items:mode==='empty'?[]:[config.row]}});
  }
  if(request.method()!=='GET'||u.pathname.startsWith('/api/')){unexpected.push(request.url());return route.abort();}
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(`${origin}/${name}?mode=${mode}`);await has(page.locator('[data-i18n-version="d-sku-v1"]'));await fn(page,writes);
  assert.deepEqual(unexpected,[],'unexpected network');assert.deepEqual(errors,[],'page errors');
  assert.deepEqual(await page.evaluate(()=>window.__unexpected),[],'unexpected backend calls');
  entry.passed=true;console.log(`PASS ${name} ${lang} ${width} ${mode}`);
 }catch(error){entry.error=error.message;console.error(JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,calls:window.__dbCalls,unexpected:window.__unexpected,invalid:[...document.querySelectorAll(':invalid')].map(e=>({name:e.name,message:e.validationMessage}))})),null,2));await page.screenshot({path:`${artifacts}/FAIL-${name}-${lang}-${width}-${mode}.png`,fullPage:true});throw error;}
 finally{await context.close();}
}

export {browser,cases,configs,run,has,button,text,artifacts};
