import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browser,cases,configs,run,has,button,text,artifacts} from './runtime.mjs';
try{
for(const width of [390,1440])for(const lang of ['vi','en']){
 const l=lang==='vi'?0:1,other=1-l;
 for(const [name,c] of Object.entries(configs)){
 await run(name,lang,width,'data',async(p,writes)=>{
  await has(text(p,c.title[l]));await has(text(p,'12.345'));
  await has(text(p,c.row.name||c.row.category));
  if(name!=='overhead'){
    const search=p.locator('input').first();await search.fill('NO-MATCH-FIXTURE');assert.equal(await button(p,l===0?'Sửa':'Edit').count(),0);await search.fill('');
  }
  if(name==='products'||name==='employees')await has(text(p,'active'));
  if(name==='employees'){
    await p.getByRole('combobox').first().click();await p.getByRole('option',{name:l===0?'Khác':'Other',exact:true}).click();assert.equal(await button(p,l===0?'Sửa':'Edit').count(),0);
    await p.getByRole('combobox').first().click();await p.getByRole('option',{name:l===0?'Tất cả vai trò':'All roles',exact:true}).click();await has(text(p,'2026-09-01'));
  }
  await button(p,lang==='vi'?'Sửa':'Edit').first().click();
  await has(p.getByRole('dialog').getByRole('heading',{name:c.update[l],exact:true}));
  await p.evaluate(v=>window.__setLanguage(v),lang==='vi'?'en':'vi');
  await has(p.getByRole('dialog').getByRole('heading',{name:c.update[other],exact:true}));
  await button(p,other===0?'Lưu':'Save').click();
  await p.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  assert.deepEqual(writes[0],{path:c.endpoint+'1/',method:'PUT',body:c.payload});
  await p.reload();await has(text(p,c.title[other]));
  await button(p,c.add[other]).click();await has(p.getByRole('dialog').getByRole('heading',{name:c.add[other],exact:true}));
  await button(p,other===0?'Lưu':'Save').click();await p.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  const expected=name==='products'?{sku_code:'',name:'',category:'other',unit:'piece',selling_price:0,status:'active'}:name==='ingredients'?{name:'',category:'other',unit:'kg',current_stock:0,minimum_stock:0,current_cost_per_unit:0}:name==='employees'?{employee_id:'',name:'',role:'baker',hire_date:'',phone:'',email:'',wage_type:'monthly_salary',base_rate:0}:{category_id:0,amount:0,month:null};
  assert.deepEqual(writes[1],{path:c.endpoint,method:'POST',body:expected});
  await button(p,other===0?'Xoá':'Delete').first().click();await p.waitForTimeout(100);
  assert.equal(writes[2].method,'DELETE');assert.equal(writes[2].path,c.endpoint+'1/');
  await p.screenshot({path:`${artifacts}/${name}-${lang}-${width}.png`,fullPage:true});
 });
 for(const mode of ['empty','loading','error'])await run(name,lang,width,mode,async p=>{
  await has(text(p,c.title[l]));
  if(mode==='error')await has(text(p,l===0?'Không tải được dữ liệu.':'Unable to load data.'));
  if(mode==='loading')await has(p.locator('.animate-pulse'));
  if(mode==='empty'){await p.waitForTimeout(150);assert.equal(await button(p,l===0?'Sửa':'Edit').count(),0);if(name==='products')await has(text(p,l===0?'Không tìm thấy SKU phù hợp.':'No matching SKUs found.'));}
 });
 }
 await run('index',lang,width,'data',async p=>{
  await has(p.getByRole('heading',{name:l===0?'Tổng quan':'Dashboard',exact:true}));
  await has(text(p,l===0?'Chờ duyệt':'Pending Approvals'));
  await button(p,l===0?'Tạo đề nghị chi':'Create payment request').click();
  let dialog=p.getByRole('dialog');await has(dialog.getByRole('heading',{name:l===0?'Tạo đề nghị duyệt chi':'Create payment approval request'}));
  await button(p,l===0?'Tạo đề nghị':'Create request').click();await has(text(p,l===0?'Tiêu đề là bắt buộc':'Title is required'));
  await p.evaluate(v=>window.__setLanguage(v),l===0?'en':'vi');
  await has(text(p,other===0?'Tiêu đề là bắt buộc':'Title is required'));
  await dialog.getByPlaceholder(other===0?'VD: Đề nghị chi mua NVL tháng 1':'E.g. January materials payment request').fill('Nội dung giữ nguyên');
  await dialog.getByPlaceholder(other===0?'Ghi chú thêm...':'Additional notes...').fill('Ghi chú giữ nguyên');
  await button(p,other===0?'Thêm sản phẩm':'Add product').click();
  await dialog.getByPlaceholder(other===0?'Tên sản phẩm':'Product name',{exact:true}).fill('Bánh giữ nguyên');
  await dialog.locator('input[name="items.0.quantity"]').fill('2');
  await dialog.locator('input[name="items.0.unit_price"]').fill('12000');
  await dialog.locator('input[name="vat_amount"]').fill('1000');
  await has(dialog.getByText(/25\.000/));
  await dialog.locator('#payment_cash').click();
  await button(p,other===0?'Tạo đề nghị':'Create request').click();
  await has(text(p,other===0?'Đã tạo đề nghị duyệt chi thành công':'Payment request created successfully'));
  const calls=await p.evaluate(()=>window.__dbCalls);
  const request=calls.find(c=>c.table==='payment_requests'&&c.operations.some(o=>o.method==='insert')).operations.find(o=>o.method==='insert').args[0];
  assert.equal(request.total_amount,25000);assert.equal(request.vat_amount,1000);assert.equal(request.payment_method,'cash');assert.equal(request.payment_type,'old_order');assert.equal(request.title,'Nội dung giữ nguyên');assert.equal(request.notes,'Ghi chú giữ nguyên');
  const item=calls.find(c=>c.rpc==='create_procurement_line_with_material_resolution').args.p_line;
  assert.equal(item.product_name,'Bánh giữ nguyên');assert.equal(item.quantity,2);assert.equal(item.unit_price,12000);assert.equal(item.line_total,24000);assert.equal(item.unit,'kg');assert.equal(item.cost_review_routing,'none');
  await p.reload();await has(p.getByRole('heading',{name:other===0?'Tổng quan':'Dashboard',exact:true}));
  await p.screenshot({path:`${artifacts}/index-${lang}-${width}.png`,fullPage:true});
 });
 await run('index',lang,width,'save-error',async p=>{
  await button(p,l===0?'Tạo đề nghị chi':'Create payment request').click();const d=p.getByRole('dialog');
  await button(p,l===0?'Tạo NCC mới':'Create new supplier').click();
  await d.getByPlaceholder(l===0?'Nhập tên NCC mới...':'Enter new supplier name...').fill('NCC giữ nguyên');
  await has(text(p,l===0?'NCC sẽ được tạo tự động khi lưu PR':'The supplier will be created when the request is saved'));
  await button(p,l===0?'Chọn NCC có sẵn':'Select existing supplier').click();
  await d.getByPlaceholder(l===0?'VD: Đề nghị chi mua NVL tháng 1':'E.g. January materials payment request').fill('Giữ nguyên');
  await button(p,l===0?'Thêm sản phẩm':'Add product').click();await d.getByPlaceholder(l===0?'Tên sản phẩm':'Product name',{exact:true}).fill('Bánh giữ nguyên');
  await button(p,l===0?'Tạo đề nghị':'Create request').click();await has(text(p,l===0?'Không thể tạo đề nghị chi. Vui lòng thử lại.':'Unable to create payment request. Please try again.'));
  await has(d);await button(p,l===0?'Hủy':'Cancel').click();
 });
 for(const mode of ['empty','loading','error'])await run('index',lang,width,mode,async p=>{
  await has(p.getByRole('heading',{name:l===0?'Tổng quan':'Dashboard',exact:true}));
  if(mode==='loading')await has(text(p,'...'));else {await p.waitForTimeout(mode==='error'?1400:100);await has(text(p,'0'));}
 });
}
}finally{await browser.close();await fs.writeFile(`${artifacts}/browser-results.json`,JSON.stringify(cases,null,2));}
console.log(`PASS ${cases.length} actual-page cases`);
