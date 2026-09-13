import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT||'/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM||'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const origin='http://127.0.0.1:4305',out='/tmp/bmq-i18n-lanes/c-production',results=[];
const vis=l=>l.filter({visible:true}),button=(p,name)=>['EN','VI'].includes(name)?p.locator('nav[aria-label="Fixture language"] button').filter({hasText:name}):vis(p.getByRole('button',{name,exact:true}));
const titles={products:['Quản lý sản phẩm','Product management'],inventory:['Xuất-nhập-tồn NVL Q7','Q7 material inventory'],materials:['Danh mục nguyên vật liệu từ Giá vốn','Material catalog from COGS'],system:['Dashboard giám sát controller','Controller monitoring dashboard'],planning:['Kế hoạch sản xuất - Xưởng Q7','Q7 Workshop Production Plan'],shifts:['Tạo ca sản xuất','Create production shift'],qa:['QA & nhập kho thành phẩm Q7','Q7 QA & finished goods receiving']};
async function run(slug,lang,width,mode,fn){const id=`${slug}-${lang}-${width}-${mode}`,ctx=await browser.newContext({viewport:{width,height:1000}});const unexpected=[],errors=[];
 await ctx.addInitScript(lang=>{if(!sessionStorage.getItem('initialized')){localStorage.setItem('app-language',lang);sessionStorage.setItem('initialized','1');}},lang);
 await ctx.route('**/*',r=>{if(r.request().url().startsWith(origin+'/'))return r.continue();if(r.request().url().startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});unexpected.push(r.request().url());return r.abort();});
 const p=await ctx.newPage();p.setDefaultTimeout(4000);p.on('pageerror',e=>errors.push(e.message));
 try{await p.goto(`${origin}/${slug}?fixture=${mode}`);await vis(p.getByText(slug==='shifts'&&width===390?en(lang,'Tạo ca','New shift'):titles[slug][lang==='en'?1:0],{exact:true})).first().waitFor();await fn(p);assert.deepEqual(await p.evaluate(()=>window.__unexpected),[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);results.push({id,passed:true});console.log('PASS',id);}catch(e){results.push({id,passed:false,error:e.message});console.log('FAIL',id,e.message);await fs.writeFile(`${out}/${id}-failure.txt`,await p.locator('body').innerText());}finally{await ctx.close();await fs.writeFile(out+'/browser-actions.json',JSON.stringify(results,null,2));}}
const en=(lang,vi,english)=>lang==='en'?english:vi;
try {
for(const lang of ['en','vi'])for(const width of [390,1440]){
 await run('shifts',lang,width,'data',async p=>{
 await button(p,en(lang,width===390?'Tạo ca':'Tạo ca sản xuất',width===390?'New shift':'Create production shift')).click();const d=p.getByRole('dialog');await d.waitFor();await d.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'SX-KEEP'}).click();await d.locator('input[type="date"]').fill('2026-09-10');await d.getByPlaceholder(en(lang,'Nhập tên người phụ trách','Enter assignee name')).fill('Tên giữ nguyên');await d.locator('input[type="number"]').fill('17');await d.getByRole('button',{name:en(lang,'Tạo ca','Create shift'),exact:true}).click();await p.waitForFunction(()=>window.__fixtureCalls.some(c=>c.table==='production_shift_items'&&c.operations.some(o=>o.method==='insert')));const calls=await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.table&&c.operations.some(o=>o.method==='insert')));const payload=t=>calls.find(c=>c.table===t).operations.find(o=>o.method==='insert').args[0];assert.deepEqual(payload('production_shifts'),{shift_code:'CA-20260910-S',shift_date:'2026-09-10',shift_type:'morning',status:'scheduled',assigned_to:'Tên giữ nguyên',production_order_id:'order-1'});assert.deepEqual(payload('production_shift_items'),[{production_shift_id:'shift-created',production_order_item_id:'item-1',planned_qty:17,actual_qty:null}]);
 });
 await run('products',lang,width,'save-error',async p=>{
 await p.getByRole('combobox').click();await p.getByRole('option').filter({hasText:'Bánh giữ nguyên'}).click();await button(p,en(lang,'Lưu thông số tem','Save label specifications')).click();await p.getByText(en(lang,'Không thể lưu','Unable to save'),{exact:true}).waitFor();await p.getByText('SERVER giữ nguyên',{exact:true}).waitFor();assert.equal(await p.locator('[data-product-label-save-success]').count(),0);
 });
 await run('inventory',lang,width,'save-error',async p=>{
 await p.getByRole('tab',{name:en(lang,'Nhập kho','Receiving'),exact:true}).click();await button(p,en(lang,'Ghi nhận nhập Q7','Record Q7 receipt')).click();await p.getByText(en(lang,'Thiếu dữ liệu nhập Q7','Missing Q7 receipt details'),{exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.rpc==='record_q7_inventory_receipt').length),0);
 });
 await run('materials',lang,width,'data&readonly=1',async p=>{
 await p.getByText(en(lang,'Chế độ chỉ xem','View-only mode'),{exact:true}).waitFor();assert.equal(await button(p,en(lang,'Sửa','Edit')).count(),0);assert.equal(await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.rpc).length),0);
 });
 await run('system',lang,width,'data&readonly=1',async p=>{
 await p.getByText(en(lang,'Controller chỉ đọc','Read-only controller'),{exact:true}).waitFor();assert.equal(await button(p,en(lang,'Bật enforced','Promote enforced')).count(),0);assert.equal(await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.rpc==='set_material_master_enforcement_mode').length),0);
 });
 await run('inventory',lang,width,'data&readonly=1',async p=>{
 await p.getByRole('tab',{name:en(lang,'Nhập kho','Receiving'),exact:true}).click();assert.ok(await button(p,en(lang,'Ghi nhận nhập Q7','Record Q7 receipt')).isDisabled());await p.getByRole('tab',{name:en(lang,'Phiếu ký','Signed issues'),exact:true}).click();assert.ok(await p.getByTestId('q7-material-issue-confirm-open-ready').isDisabled());assert.equal(await p.evaluate(()=>window.__fixtureCalls.filter(c=>c.rpc==='record_q7_inventory_receipt'||c.rpc==='confirm_q7_material_issue').length),0);
 });
}
}finally{await browser.close();}
assert.equal(results.filter(r=>!r.passed).length,0,'All deeper action cases pass');
