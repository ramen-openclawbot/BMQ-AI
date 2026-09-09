import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT||'/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM||'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const origin='http://127.0.0.1:4304',out='/tmp/bmq-i18n-lanes/c-warehouse';
const errors=[],unexpected=[],cases=[];
let exportBytes;
const titles={Inventory:['Kho hàng','Inventory'],LowStock:['Cảnh báo tồn kho thấp','Low stock alerts'],KitchenInventory:['Kiểm soát kho bếp','Kitchen inventory'],TanTaoWarehouse:['Kho Tân Tạo','Tân Tạo warehouse'],WarehouseDispatch:['Xuất kho','Warehouse dispatch'],StockReport:['Báo cáo tồn kho','Stock report']};
const label=(lang,vi,en)=>lang==='vi'?vi:en;
const btn=(p,name)=>p.getByRole('button',{name,exact:true}).filter({visible:true});
const shown=(p,text)=>p.getByText(text,{exact:true}).filter({visible:true}).first();
async function setup(pageName,lang,width,mode='data',extra=''){
 const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true});
 await context.addInitScript(lang=>{if(!sessionStorage.getItem('initialized')){localStorage.setItem('app-language',lang);sessionStorage.setItem('initialized','1');}},lang);
 await context.route('**/*',route=>{
  const u=route.request().url();
  if(u.startsWith(origin+'/'))return route.continue();
  if(u.startsWith('https://fonts.googleapis.com/'))return route.fulfill({body:'',contentType:'text/css'});
  unexpected.push(u);return route.abort();
 });
 const p=await context.newPage();await p.clock.setFixedTime(new Date('2026-09-09T03:00:00Z'));p.setDefaultTimeout(8000);p.on('pageerror',e=>errors.push(e.message));
 await p.goto(`${origin}/${pageName}?fixture=${mode}${extra}`);
 return {context,p};
}
async function switchTo(p,lang){await p.evaluate(lang=>window.__setLanguage(lang),lang);await p.waitForFunction(lang=>localStorage.getItem("app-language")===lang,lang);}
async function calls(p){return p.evaluate(()=>window.__calls);}
function writes(log,table,method){return log.filter(c=>c.table===table).flatMap(c=>c.operations.filter(o=>o.method===method).map(o=>o.args[0]));}
async function inventory(p,lang){
 const l=(vi,en)=>label(lang,vi,en);
 await shown(p,'Bánh giữ nguyên').waitFor();
 // Business categories remain untouched, derived urgency uses translated display labels.
 await shown(p,'Nguyên liệu').waitFor();await shown(p,l('Khẩn cấp','Critical')).waitFor();await shown(p,l('Đủ hàng','In stock')).waitFor();
 const download=p.waitForEvent('download');await btn(p,l('Xuất dữ liệu','Export')).click();const file=await download;
 const bytes=await fs.readFile(await file.path()); if(exportBytes)assert.deepEqual(bytes,exportBytes,"XLSX bytes must be identical across languages/viewports at fixed time"); else exportBytes=bytes;
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(await file.path());
 assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1),['Name','Category','Quantity','Unit','Min Stock']);
 assert.deepEqual(workbook.worksheets[0].getRow(2).values.slice(1),['Bánh giữ nguyên','Nguyên liệu',80,'que',100]);
 await btn(p,l('Thêm mặt hàng','Add item')).evaluate(el=>el.click());let dialog=p.getByRole('dialog');
 await dialog.getByRole('button',{name:l('Thêm mặt hàng','Add item'),exact:true}).click();await shown(p,l('Vui lòng nhập tên mặt hàng','Item name is required')).waitFor();
 const other=lang==='vi'?'en':'vi';await switchTo(p,other);await shown(p,label(other,'Vui lòng nhập tên mặt hàng','Item name is required')).waitFor();await switchTo(p,lang);
 await dialog.getByLabel(l('Tên mặt hàng','Item name'),{exact:true}).fill('Tên nhập giữ nguyên');
 await dialog.getByRole('combobox').first().click();await p.getByRole('option',{name:l('Bột','Flour'),exact:true}).click();
 await dialog.getByRole('button',{name:l('Thêm mặt hàng','Add item'),exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.deepEqual(writes(await calls(p),'inventory_items','insert'),[{created_by:'synthetic-staff',name:'Tên nhập giữ nguyên',category:'Flour',quantity:0,unit:'kg',min_stock:0}]);
 await btn(p,l('Chỉnh sửa nguyên vật liệu','Edit inventory item')).first().click();dialog=p.getByRole('dialog');
 await dialog.getByRole('combobox').nth(1).click();await p.getByRole('option',{name:'kg',exact:true}).click();await dialog.locator('#quantity').fill('81');await dialog.getByRole('button',{name:l('Lưu thay đổi','Save changes')}).click();await dialog.waitFor({state:'hidden'});
 assert.deepEqual(writes(await calls(p),'inventory_items','update')[0],{name:'Bánh giữ nguyên',category:'Nguyên liệu',quantity:81,unit:'kg',min_stock:100});
 await btn(p,l('Xoá','Delete')).first().click();await p.getByRole('alertdialog').waitFor();await btn(p,l('Hủy','Cancel')).click();
 await btn(p,l('Thống kê HSD','Expiry statistics')).click();dialog=p.getByRole('dialog');await shown(p,l('Quá hạn','Expired')).waitFor();
 await dialog.locator('input[type=date]').first().fill('2030-12-31');assert.equal(await dialog.locator('input[type=date]').nth(1).isDisabled(),true);
 await dialog.getByRole('button',{name:l('Lưu','Save'),exact:true}).first().click();
 await shown(p,l('Đã cập nhật HSD thành công','Expiry date updated')).waitFor();
 assert.deepEqual((await calls(p)).filter(c=>c.rpc==='update_batch_expiry_once'),[{rpc:'update_batch_expiry_once',args:{p_batch_id:'batch-1',p_expiry_date:'2030-12-31'}}]);
 await p.keyboard.press('Escape');
 await p.getByPlaceholder(l('Tìm kiếm nguyên liệu, danh mục...','Search ingredients, categories...')).fill('nothing-found');await shown(p,l('Không tìm thấy mặt hàng phù hợp.','No matching items.')).waitFor();
}
async function kitchen(p,lang){
 const l=(vi,en)=>label(lang,vi,en);await shown(p,l('Tổng chi phí','Total cost')).waitFor();
 await shown(p,'41.000 ₫').waitFor();
 await btn(p,l('Import T3/T4','March/April import')).click();await shown(p,'APPROVE').waitFor();await shown(p,'REVIEW').waitFor();await shown(p,'applied').waitFor();assert.equal(await btn(p,l('Tải lên XLSX','Upload XLSX')).isDisabled(),true);
 await btn(p,l('Danh mục chuẩn','Master items')).click();await shown(p,'Bột chuẩn giữ nguyên').waitFor();
 await p.getByPlaceholder(l('Tìm theo mã, tên chuẩn, đơn vị...','Search code, master name, unit...')).fill('bot chuan');await shown(p,'Bột chuẩn giữ nguyên').waitFor();
 await btn(p,l('Ledger hằng ngày','Daily ledger')).click();
 await p.locator('select').nth(1).selectOption('ki-1');await p.locator('input[type=number]').fill('2');await btn(p,l('Ghi sổ','Post entry')).click();
 await shown(p,l('Đã ghi sổ kho bếp','Kitchen ledger entry posted')).waitFor();
 const period=await p.locator('input[type=month]').inputValue();
 assert.deepEqual(writes(await calls(p),'kitchen_inventory_movements','insert')[0],{movement_date:period+'-01',period_month:period+'-01',item_id:'ki-1',movement_type:'usage',quantity:2,unit:'kg',unit_cost:12000,amount:24000,source:'manual_daily',note:null,created_by:'synthetic-staff'});
 await p.locator('select').first().selectOption('adjustment');await p.locator('input[type=number]').fill('0');await p.getByPlaceholder(l('Bắt buộc khi điều chỉnh hoặc override sau này','Required for adjustments or later overrides')).fill('Lý do giữ nguyên');await btn(p,l('Ghi sổ','Post entry')).click();await shown(p,l('Điều chỉnh phải khác 0.','Adjustment must be nonzero.')).waitFor();
 const other=lang==='vi'?'en':'vi';await switchTo(p,other);await shown(p,label(other,'Điều chỉnh phải khác 0.','Adjustment must be nonzero.')).waitFor();await switchTo(p,lang);
 await btn(p,l('Chốt tháng','Monthly close')).first().click();await btn(p,l('Chốt tháng','Monthly close')).last().click();await shown(p,l('Đã chốt tháng kho bếp','Kitchen inventory month closed')).waitFor();
 assert.deepEqual((await calls(p)).filter(c=>c.rpc==='close_kitchen_inventory_month'),[{rpc:'close_kitchen_inventory_month',args:{p_period_month:period+'-01'}}]);
}
async function tantao(p,lang){
 const l=(vi,en)=>label(lang,vi,en);await shown(p,'TT-QA').waitFor();await shown(p,'posted').waitFor();await shown(p,'Pate 500g').waitFor();
 await p.locator('#tan-tao-stock-count-quantity').fill('79');await p.locator('#tan-tao-stock-count-reason').fill('Kiểm kê giữ nguyên');
 p.once('dialog',async d=>{assert.ok(d.message().includes('79 que'));await d.accept();});await btn(p,l('Ghi nhận kiểm kê vật lý','Record physical stock count')).click();await shown(p,l('Đã ghi nhận kiểm kê vật lý','Physical stock count recorded')).waitFor();
 const count=(await calls(p)).find(c=>c.rpc==='record_tan_tao_stock_count');assert.equal(count.args.p_sku_code,'BMQ-001');assert.equal(count.args.p_count,79);assert.equal(count.args.p_reason,'Kiểm kê giữ nguyên');assert.match(count.args.p_idempotency_key,/^stock-count:BMQ-001:/);
 await p.getByPlaceholder(l('Nhắn nghiệp vụ kho…','Enter a warehouse transaction…')).fill('unrecognized command');await btn(p,l('Gửi lệnh','Send command')).click();await shown(p,l('Em chưa nhận diện được nghiệp vụ. Anh có thể khai báo tồn đầu, đặt Tuyết Anh, xác nhận đã nhận, hoặc nhập đơn Đặt/Đổi/Bù.','The transaction was not recognized. You can declare opening stock, order from Tuyết Anh, confirm receipt, or enter an Order/Exchange/Makeup order.')).waitFor();
 await switchTo(p,lang==='vi'?'en':'vi');await shown(p,label(lang==='vi'?'en':'vi','Em chưa nhận diện được nghiệp vụ. Anh có thể khai báo tồn đầu, đặt Tuyết Anh, xác nhận đã nhận, hoặc nhập đơn Đặt/Đổi/Bù.','The transaction was not recognized. You can declare opening stock, order from Tuyết Anh, confirm receipt, or enter an Order/Exchange/Makeup order.')).waitFor();await switchTo(p,lang);
 await btn(p,'Tồn đầu BMQ-001 350 que').click();await btn(p,l('Gửi lệnh','Send command')).click();await shown(p,l('BMQ Agent đã ghi nhận','BMQ Agent recorded the transaction')).waitFor();
 const command=(await calls(p)).find(c=>c.rpc==='execute_tan_tao_warehouse_command');assert.equal(command.args.p_command_type,'opening');assert.equal(command.args.p_quantity,350);assert.equal(command.args.p_reference_type,'trusted_owner_chat');assert.equal(command.args.p_note,null);
}
async function dispatch(p,lang){
 const l=(vi,en)=>label(lang,vi,en);await shown(p,'XK-QA-0').waitFor();
 await btn(p,l('PXK tự động','Automatic issues')).click();await shown(p,'AUTO-QA').click();let dialog=p.getByRole('dialog');await shown(p,'Vật tư giữ nguyên').waitFor();await shown(p,l('Chứng từ chỉ đọc','Read-only document')).waitFor();assert.equal(await dialog.locator('input').count(),0);await p.keyboard.press('Escape');
 await btn(p,l('Thành phẩm','Finished goods')).click();await shown(p,'XK-QA-0').click();dialog=p.getByRole('dialog');await dialog.getByRole('button',{name:l('Bắt đầu lấy hàng','Start picking')}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual(writes(await calls(p),'warehouse_dispatches','update')[0],{status:'picked'});
 await shown(p,'XK-QA-1').click();dialog=p.getByRole('dialog');await dialog.getByRole('button',{name:l('Xuất kho (trừ tồn kho)','Dispatch (deduct stock)')}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual(writes(await calls(p),'inventory_items','update')[0],{quantity:75});
 const movement=writes(await calls(p),'inventory_movements','insert')[0];assert.equal(movement.movement_type,'dispatch_out');assert.equal(movement.quantity,-5);assert.equal(movement.notes,'Xuất kho XK-QA-1');
 await shown(p,'XK-QA-2').click();dialog=p.getByRole('dialog');await dialog.getByRole('button',{name:l('Xác nhận đã giao','Confirm delivery')}).click();await dialog.waitFor({state:'hidden'});assert.equal(writes(await calls(p),'warehouse_dispatches','update').at(-1).status,'delivered');
 await btn(p,l('Tạo phiếu thành phẩm','Create finished goods dispatch')).click();dialog=p.getByRole('dialog');await dialog.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'PO-QA-1'}).click();
 await dialog.getByPlaceholder(l('SKU thiếu','Shortage SKU')).fill('BMQ-001');await dialog.getByRole('button',{name:l('Tạo phiếu xuất kho','Create dispatch document'),exact:true}).click();await dialog.waitFor({state:'hidden'});
 const rpc=(await calls(p)).find(c=>c.rpc==='upsert_po_dispatch_revenue_confirmation');assert.equal(rpc.args._customer_po_inbox_id,'po-1');const payload=rpc.args._payload;
 assert.equal(payload.ordered_qty_total,100);assert.equal(payload.dispatched_qty_total,75);assert.equal(payload.billable_qty_total,75);assert.equal(payload.defect_qty_total,25);assert.equal(payload.temporary_revenue_amount_vat_included,1000000);
 assert.deepEqual(payload.lines[0],{source_line_key:'BMQ-001',sku:'BMQ-001',product_name:'Bánh giữ nguyên',ordered_qty:100,produced_qty:75,defect_qty:25,dispatched_qty:75,billable_qty:75,unit_price_vat_included:10000,source_line_amount_vat_included:1000000,temporary_revenue_amount_vat_included:1000000,confirmed_revenue_amount_vat_included:750000,shortage_reason_code:'production_defect',shortage_note:null});
 const confirm=(await calls(p)).find(c=>c.rpc==='confirm_po_dispatch_revenue');assert.equal(confirm.args._note,'Xác nhận số xuất thực tế từ phiếu xuất kho');
}
async function stock(p,lang){
 const l=(vi,en)=>label(lang,vi,en);await shown(p,'Bánh giữ nguyên').waitFor();await shown(p,'Ghi chú giữ nguyên').waitFor();
 const reconciliation=p.locator('table').last().getByRole('row').last();assert.deepEqual(await reconciliation.getByRole('cell').allTextContents(),['Bánh giữ nguyên','80','+20','-5','95','80','-15']);
 await p.getByPlaceholder(l('Nhập tên sản phẩm...','Enter product name...')).fill('missing');await shown(p,l('Không có dữ liệu tồn kho','No inventory data')).waitFor();await p.getByPlaceholder(l('Nhập tên sản phẩm...','Enter product name...')).fill('');
 await p.getByRole('combobox').click();await p.getByRole('option',{name:l('Nguyên vật liệu','Raw materials'),exact:true}).click();assert.equal(await p.locator('table').first().getByText('Bánh giữ nguyên',{exact:true}).count(),0);
}
for(const pageName of Object.keys(titles))for(const width of [390,1440])for(const lang of ['vi','en'])test(`data ${pageName} ${width} ${lang}`,async()=>{
 const {context,p}=await setup(pageName,lang,width);
 try{
  await p.getByRole('heading',{name:titles[pageName][lang==='vi'?0:1],exact:true}).waitFor();
  await p.locator('[data-bmq-warehouse-i18n="v1"]').waitFor();
  if(pageName==='Inventory')await inventory(p,lang);
  if(pageName==='LowStock'){await shown(p,'Bột giữ nguyên').waitFor();await shown(p,label(lang,'Khẩn cấp','Critical')).waitFor();await shown(p,label(lang,'Cao','High')).waitFor();await shown(p,label(lang,'Trung bình','Medium')).waitFor();assert.equal(await p.getByText('Đường giữ nguyên',{exact:true}).count(),0);await btn(p,label(lang,'Đặt mua tất cả','Order all')).click();assert.equal(writes(await calls(p),'inventory_items','insert').length,0);}
  if(pageName==='KitchenInventory')await kitchen(p,lang);
  if(pageName==='TanTaoWarehouse')await tantao(p,lang);
  if(pageName==='WarehouseDispatch')await dispatch(p,lang);
  if(pageName==='StockReport')await stock(p,lang);
  const other=lang==='vi'?'en':'vi';await switchTo(p,other);await p.getByRole('heading',{name:titles[pageName][other==='vi'?0:1],exact:true}).waitFor();await p.reload();await p.getByRole('heading',{name:titles[pageName][other==='vi'?0:1],exact:true}).waitFor();
  assert.deepEqual(await p.evaluate(()=>window.__unexpected),[]);
  await p.screenshot({path:`${out}/${pageName}-${width}-${lang}.png`,fullPage:true});cases.push({pageName,width,lang,mode:'data',passed:true});
 }finally{await context.close();}
});
for(const pageName of Object.keys(titles))for(const width of [390,1440])for(const lang of ['vi','en'])test(`states ${pageName} ${width} ${lang}`,async()=>{
 for(const mode of ['empty','loading','error']){
  const {context,p}=await setup(pageName,lang,width,mode);const l=(vi,en)=>label(lang,vi,en);
  try{
   if(pageName==='Inventory')await (mode==='loading'?p.locator('.animate-pulse').first():shown(p,mode==='error'?l("Không tải được tồn kho","Couldn't load inventory"):l('Chưa có mặt hàng trong kho. Thêm mặt hàng đầu tiên để bắt đầu.','No inventory items yet. Add your first item to get started.'))).waitFor();
   if(pageName==='LowStock')await (mode==='loading'?p.locator('.animate-pulse').first():shown(p,l('Tất cả hàng hóa đang đủ tồn kho! Không có cảnh báo tồn thấp.','All items are well stocked! No low stock alerts.'))).waitFor();
   if(pageName==='KitchenInventory'){await btn(p,l('Import T3/T4','March/April import')).click();await shown(p,mode==='loading'?l('Đang tải dữ liệu import...','Loading import data...'):l('Chưa có batch import. Chạy script admin để staging/apply workbook đã review.','No import batches yet. Run the admin script to stage/apply the reviewed workbook.')).waitFor();}
   if(pageName==='TanTaoWarehouse'){
    if(mode==='error')await shown(p,l('Không tải được sổ kho.','Unable to load the inventory ledger.')).waitFor();
    else if(mode==='empty')await shown(p,l('Chưa có chứng từ. Anh có thể bắt đầu bằng khai báo tồn đầu.','No documents yet. You can start by declaring opening stock.')).waitFor();
    else {await p.waitForFunction(()=>document.querySelector('section .tabular-nums')?.textContent.includes('…'));assert.equal(await p.locator('#tan-tao-stock-count-quantity').count(),0);}
   }
   if(pageName==='WarehouseDispatch'){
    if(mode==='loading')await p.locator('.animate-spin').first().waitFor();
    else {await btn(p,l('PXK tự động','Automatic issues')).click();await shown(p,mode==='error'?l('Không tải được PXK tự động','Unable to load automatic issues'):l('Chưa có PXK tự động','No automatic issues yet')).waitFor();}
   }
   if(pageName==='StockReport')await (mode==='loading'?p.locator('.animate-spin').first():shown(p,l('Không có dữ liệu tồn kho','No inventory data'))).waitFor();
   const other=lang==='vi'?'en':'vi';await switchTo(p,other);if(!(pageName==='WarehouseDispatch'&&mode==='loading'))await p.getByRole('heading',{name:titles[pageName][other==='vi'?0:1],exact:true}).waitFor();await p.reload();assert.equal(await p.evaluate(()=>localStorage.getItem('app-language')),other);
   assert.deepEqual(await p.evaluate(()=>window.__unexpected),[]);cases.push({pageName,width,lang,mode,passed:true});
  }finally{await context.close();}
 }
});

for(const width of [390,1440])for(const lang of ['vi','en'])test(`extra permissions, failures and shortage ${width} ${lang}`,async()=>{
 const l=(vi,en)=>label(lang,vi,en);
 for(const [pageName,mode] of [['KitchenInventory','denied'],['KitchenInventory','readonly'],['KitchenInventory','missing-count'],['KitchenInventory','closed'],['KitchenInventory','save-error'],['TanTaoWarehouse','readonly'],['TanTaoWarehouse','negative'],['TanTaoWarehouse','save-error'],['Inventory','save-error'],['WarehouseDispatch','existing'],['WarehouseDispatch','confirm-error'],['WarehouseDispatch','shortage']]){
  const {context,p}=await setup(pageName,lang,width,mode);
  try{
   if(pageName==='KitchenInventory'){
    if(mode==='denied')await shown(p,l('Không có quyền truy cập','Access denied')).waitFor();
    else if(mode==='save-error'){
     await btn(p,l('Ledger hằng ngày','Daily ledger')).click();await p.locator('select').nth(1).selectOption('ki-1');await btn(p,l('Ghi sổ','Post entry')).click();await shown(p,l('Không thể ghi sổ','Unable to post entry')).waitFor();await shown(p,'SERVER giữ nguyên $&').waitFor();
    }else{
     await btn(p,l('Chốt tháng','Monthly close')).first().click();assert.equal(await btn(p,l('Chốt tháng','Monthly close')).last().isDisabled(),true);
     if(mode==='missing-count')await p.getByText(l('Chưa thể chốt: còn','Cannot close: there are'),{exact:false}).waitFor();
     if(mode==='readonly'){await btn(p,l('Ledger hằng ngày','Daily ledger')).click();assert.equal(await p.locator('select').first().isDisabled(),true);}
    }
   }
   if(pageName==='TanTaoWarehouse'){
    await shown(p,'TT-QA').waitFor();
    if(mode==='readonly'){assert.equal(await p.locator('#tan-tao-stock-count-quantity').count(),0);assert.equal(await p.locator('textarea').count(),0);}
    if(mode==='negative')await p.getByText(l('ATP đang âm','ATP is negative by'),{exact:false}).waitFor();
    if(mode==='save-error'){
     await p.locator('#tan-tao-stock-count-quantity').fill('1');await p.locator('#tan-tao-stock-count-reason').fill('Lý do giữ nguyên');p.once('dialog',d=>d.accept());await btn(p,l('Ghi nhận kiểm kê vật lý','Record physical stock count')).click();await shown(p,'SERVER giữ nguyên $&').waitFor();assert.equal(await p.locator('#tan-tao-stock-count-quantity').inputValue(),'1');
    }
   }
   if(pageName==='Inventory'){
    await shown(p,'Bánh giữ nguyên').waitFor();await btn(p,l('Xoá','Delete')).first().click();await p.getByRole('alertdialog').getByRole('button',{name:l('Xoá','Delete'),exact:true}).click();await shown(p,l('Không thể xoá','Unable to delete')).waitFor();
    await btn(p,l('Thống kê HSD','Expiry statistics')).click();await p.getByRole('dialog').locator('input[type=date]').first().fill('2030-01-01');await p.getByRole('dialog').getByRole('button',{name:l('Lưu','Save'),exact:true}).first().click();await shown(p,'SERVER giữ nguyên $&').waitFor();
   }
   if(pageName==='WarehouseDispatch'){
    await btn(p,l('Tạo phiếu thành phẩm','Create finished goods dispatch')).click();const dialog=p.getByRole('dialog');await dialog.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'PO-QA-1'}).click();
    await dialog.getByRole('button',{name:l('Tạo phiếu xuất kho','Create dispatch document'),exact:true}).click();
    if(mode==='shortage'){
     await dialog.waitFor({state:'hidden'});const log=await calls(p);const rpc=log.find(c=>c.rpc==='upsert_po_dispatch_revenue_confirmation');assert.equal(rpc.args._payload.lines[0].sku,null);assert.equal(rpc.args._payload.lines[0].confirmed_revenue_amount_vat_included,null);assert.equal(log.filter(c=>c.rpc==='confirm_po_dispatch_revenue').length,0);
    }else{
     await shown(p,l('Lỗi tạo phiếu','Unable to create document')).waitFor();const log=await calls(p);
     if(mode==='existing')assert.equal(writes(log,'warehouse_dispatches','insert').length,0);
     else {await shown(p,'SERVER giữ nguyên $&').waitFor();assert.ok(log.some(c=>c.table==='warehouse_dispatches'&&c.operations.some(o=>o.method==='delete')));assert.ok(log.some(c=>c.table==='warehouse_dispatch_items'&&c.operations.some(o=>o.method==='delete')));}
    }
   }
   assert.deepEqual(await p.evaluate(()=>window.__unexpected),[]);cases.push({pageName,width,lang,mode,passed:true});
  }finally{await context.close();}
 }
});
test.after(async()=>{await browser.close();await fs.writeFile(`${out}/browser-results.json`,JSON.stringify({cases,errors,unexpected},null,2));assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
