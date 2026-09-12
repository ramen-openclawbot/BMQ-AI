import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {browser,cases,run,has,button,text,artifacts} from './runtime.mjs';
try{
for(const width of [390,1440])for(const lang of ['vi','en']){
 const l=lang==='vi'?0:1;
 for(const mode of ['scan','supplier-create','supplier-error','request-denied','request-failed'])await run('index',lang,width,mode,async(p,writes)=>{
  await button(p,l===0?'Tạo đề nghị chi':'Create payment request').click();const d=p.getByRole('dialog');
  if(mode==='scan'){
   await d.locator('input[type=file]').setInputFiles({name:'invoice.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=','base64')});
   await has(d.getByAltText(l===0?'Xem trước hóa đơn':'Invoice preview'));
   await button(p,l===0?'Scan hóa đơn':'Scan invoice').click();await has(button(p,l===0?'Đang scan...':'Scanning...'));
   await p.evaluate(v=>window.__setLanguage(v),l===0?'en':'vi');await has(button(p,l===0?'Scanning...':'Đang scan...'));
   await has(button(p,l===0?'Scan invoice':'Scan hóa đơn'));
   assert.equal(await d.locator('input[name=title]').inputValue(),'Đề nghị chi - INV-fixture');
   assert.equal(await d.locator('input[name="items.0.product_name"]').inputValue(),'Bánh OCR giữ nguyên');
   await has(text(p,'Bột chuẩn giữ nguyên').or(p.getByText(/NVL-001 — Bột chuẩn giữ nguyên/)));
   await has(d.getByText(/25\.000/));assert.equal(writes.length,1);assert.equal(writes[0].body.image_base64!==undefined||writes[0].body.imageBase64!==undefined,true);
   await p.screenshot({path:`${artifacts}/scan-${lang}-${width}.png`,fullPage:true});
   await button(p,l===0?'Cancel':'Hủy').click();
  }else{
   await d.locator('input[name=title]').fill('Tiêu đề giữ nguyên');
   if(mode.startsWith('supplier')){
    await button(p,l===0?'Tạo NCC mới':'Create new supplier').click();
    await d.getByPlaceholder(l===0?'Nhập tên NCC mới...':'Enter new supplier name...').fill('NCC giữ nguyên $&');
   }
   await button(p,l===0?'Thêm sản phẩm':'Add product').click();await d.locator('input[name="items.0.product_name"]').fill('NVL giữ nguyên');
   await button(p,l===0?'Tạo đề nghị':'Create request').click();
   if(mode==='supplier-error'){
    const backend='  fixture $& {message}\n denied  ';
    const description=p.locator('[data-sonner-toast] [data-description]');
    await has(text(p,l===0?'Lỗi tạo NCC':'Unable to create supplier'));await has(description);assert.equal(await description.textContent(),backend);await has(d);
    await p.evaluate(v=>window.__setLanguage(v),l===0?'en':'vi');
    await has(text(p,l===0?'Unable to create supplier':'Lỗi tạo NCC'));assert.equal(await description.textContent(),backend);
   } else if(mode==='supplier-create') {
    await has(text(p,l===0?'Đã tạo NCC "NCC giữ nguyên $&"':'Supplier "NCC giữ nguyên $&" created'));
    await p.evaluate(v=>window.__setLanguage(v),l===0?'en':'vi');
    await has(text(p,l===0?'Payment request created successfully':'Đã tạo đề nghị duyệt chi thành công'));await has(text(p,l===0?'Supplier "NCC giữ nguyên $&" created':'Đã tạo NCC "NCC giữ nguyên $&"'));
    await p.evaluate(v=>window.__setLanguage(v),lang);
    await has(text(p,l===0?'Đã tạo đề nghị duyệt chi thành công':'Payment request created successfully'));
    await has(text(p,l===0?'Đã tạo NCC "NCC giữ nguyên $&"':'Supplier "NCC giữ nguyên $&" created'));
   } else {
    await p.evaluate(v=>window.__setLanguage(v),l===0?'en':'vi');
    const switched=mode==='request-denied'?(l===0?'You do not have permission to create a payment request':'Bạn không có quyền tạo đề nghị chi'):(l===0?'Unable to create payment request. Please try again.':'Không thể tạo đề nghị chi. Vui lòng thử lại.');
    const initial=mode==='request-denied'?(l===0?'Bạn không có quyền tạo đề nghị chi':'You do not have permission to create a payment request'):(l===0?'Không thể tạo đề nghị chi. Vui lòng thử lại.':'Unable to create payment request. Please try again.');
    await has(text(p,switched));await has(d);
    await p.evaluate(v=>window.__setLanguage(v),lang);await has(text(p,initial));
   }
   if(mode.startsWith('supplier')){const calls=await p.evaluate(()=>window.__dbCalls);const insert=calls.find(c=>c.table==='suppliers'&&c.operations.some(o=>o.method==='insert')).operations.find(o=>o.method==='insert').args[0];assert.equal(insert.name,'NCC giữ nguyên $&');}
  }
 });
}
}finally{await browser.close();await fs.writeFile(`${artifacts}/dialogs-results.json`,JSON.stringify(cases,null,2));}
console.log(`PASS ${cases.length} actual dialog cases`);
