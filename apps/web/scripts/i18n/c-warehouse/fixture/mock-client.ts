// All operations remain in this process; unknown operations fail closed.
const w=window as unknown as {__calls:unknown[];__unexpected:unknown[]};w.__calls=[];w.__unexpected=[];
const mode=new URLSearchParams(location.search).get('fixture')||'data';
const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`,today=`${month.slice(0,7)}-${String(now.getDate()).padStart(2,'0')}`;
const inv=[
 {id:'inv-1',name:'Bánh giữ nguyên',category:'Nguyên liệu',quantity:80,unit:'que',min_stock:100,sku_type:'finished_good',sku_id:'sku-1'},
 {id:'inv-2',name:'Bột giữ nguyên',category:'Flour',quantity:2,unit:'kg',min_stock:10,sku_type:'raw_material',sku_id:'sku-2'},
 {id:'inv-3',name:'Sữa giữ nguyên',category:'Dairy',quantity:5,unit:'L',min_stock:10,sku_type:'raw_material',sku_id:'sku-3'},
 {id:'inv-4',name:'Đường giữ nguyên',category:'Sugar',quantity:20,unit:'kg',min_stock:10,sku_type:'raw_material',sku_id:'sku-4'},
];
const kitchenItems=[{id:'ki-1',item_code:'K-001',item_type:'ingredient',name:'Bột kế toán giữ nguyên',unit:'kg',standard_unit_cost:12000,active:true,canonical_materials:{material_code:'M-001',canonical_name:'Bột chuẩn giữ nguyên',default_unit:'kg'}}];
const tables:Record<string,any[]>={
 inventory_items:inv,product_skus:inv.map(i=>({id:i.sku_id,product_name:i.name,name:i.name,sku_code:i.sku_id,sku_type:i.sku_type})),
 inventory_batches:[{id:'batch-1',quantity:5,unit:'kg',expiry_date:'2020-01-01',expiry_edit_count:0,inventory_items:{name:'Bột giữ nguyên'}},{id:'batch-2',quantity:4,unit:'kg',expiry_date:null,expiry_edit_count:1,inventory_items:{name:'Lô đã sửa'}}],
 inventory_movements:[{id:'move-1',date:today,movement_type:'goods_receipt_in',product_name:inv[0].name,quantity:20,unit:'que',notes:'Ghi chú giữ nguyên'},{id:'move-2',date:today,movement_type:'dispatch_out',product_name:inv[0].name,quantity:-5,unit:'que',notes:'Ghi chú giữ nguyên'}],
 kitchen_inventory_items:kitchenItems,
 kitchen_inventory_import_batches:[{id:'kb-1',rows_total:3,rows_approved:1,rows_review:1,rows_rejected:1,status:'applied'}],
 kitchen_inventory_import_rows:['APPROVE','REVIEW','REJECT'].map((d,i)=>({id:'kr-'+i,batch_id:'kb-1',source_row_number:i+1,source_item_name:'Tên kế toán giữ nguyên',source_unit:'kg',source_standard_unit_cost:12000,approval_decision:d,import_status:i===0?'applied':'staged'})),
 kitchen_inventory_movements:[{id:'km-1',item_id:'ki-1',period_month:month,movement_date:today,movement_type:'opening',quantity:10,unit:'kg',amount:120000,source:'manual_daily'},{id:'km-2',item_id:'ki-1',period_month:month,movement_date:today,movement_type:'usage',quantity:3,unit:'kg',amount:36000,source:'manual_daily'},...(mode==='missing-count'?[]:[{id:'km-3',item_id:'ki-1',period_month:month,movement_date:today,movement_type:'stock_count',quantity:7,unit:'kg',amount:84000,source:'manual_daily'}])],
 kitchen_inventory_monthly_closings:mode==='closed'?[{id:'kc-1',period_month:month,status:'closed'}]:[],kitchen_other_costs:[{id:'other-1',period_month:month,amount:5000}],
 warehouse_dispatches:['pending','picked','dispatched','delivered'].map((status,i)=>({id:'dispatch-'+i,dispatch_number:'XK-QA-'+i,customer_name:'Khách giữ nguyên',dispatch_date:today,delivered_date:status==='delivered'?today:null,delivery_address:'Địa chỉ giữ nguyên',notes:'Ghi chú giữ nguyên',status,created_at:today+'T01:00:00Z'})),
 warehouse_dispatch_items:['0','1','2','3'].map(id=>({id:'di-'+id,dispatch_id:'dispatch-'+id,product_name:inv[0].name,quantity:5,unit:'que'})),
 customer_po_inbox:[{id:'po-1',match_status:'approved',po_number:'PO-QA-1',from_name:'Khách giữ nguyên',delivery_date:today,matched_customer_id:'customer-1',total_amount:1000000,production_items:[{product_name:inv[0].name,qty:100,unit:'que',sku:'BMQ-001',unit_price:10000,line_total:1000000}],mini_crm_customers:{address:'Địa chỉ giữ nguyên'}}],
 po_dispatch_revenue_confirmations:mode==='existing'?[{id:'confirm-1',status:'confirmed',customer_po_inbox_id:'po-1'}]:[],production_orders:[],
 goods_receipt_auto_issues:[{id:'auto-1',issue_number:'AUTO-QA',goods_receipt_id:'gr-1',issue_date:today,status:'posted',source:'goods_receipt',total_quantity:15,notes:'Audit giữ nguyên',created_at:today+'T02:03:00Z'}],
 goods_receipt_auto_issue_items:[{id:'ai-1',auto_issue_id:'auto-1',product_name:'Vật tư giữ nguyên',quantity:15,unit:'kg'}],goods_receipts:[{id:'gr-1',receipt_number:'PNK-QA',supplier_id:'supplier-1'}],suppliers:[{id:'supplier-1',name:'NCC giữ nguyên'}],
};
const snapshot={can_manage:mode!=='readonly',on_hand_quantity:80,reserved_quantity:20,atp_quantity:mode==='negative'?-5:60,incoming_quantity:100,needs_attention:mode==='negative',recent_documents:[],items:[{sku_code:'BMQ-001',product_name:'Bánh mì tươi',unit:'que',on_hand_quantity:80,reserved_quantity:20,atp_quantity:60,incoming_quantity:100,recent_documents:[{id:'doc-1',document_number:'TT-QA',document_type:'supplier_order',status:'posted',quantity:100,physical_quantity:100,supplier_billable_quantity:100,supplier_credit_quantity:5,supplier_exchange_quantity:2,supplier_makeup_quantity:3,reference_label:'Nhà cung cấp giữ nguyên'}]},{sku_code:'PATE-500G',product_name:'Pate 500g',unit:'hộp',on_hand_quantity:10},{sku_code:'PATE-200G',product_name:'Pate 200g',unit:'hộp',on_hand_quantity:5}]};
function unexpected(value:unknown):never{w.__unexpected.push(value);throw new Error('Unexpected mock operation: '+JSON.stringify(value));}
function from(table:string){
 if(!(table in tables))return unexpected(table);
 const operations:{method:string;args:any[]}[]=[];
 const chain=new Proxy({}, {get(_,method:string){
  if(method==='then')return (resolve:(v:unknown)=>void)=>{
   w.__calls.push({table,operations});
   const write=operations.find(o=>['insert','update','delete'].includes(o.method));
   if(mode==='loading'&&!write)return;
   if(mode==='error'||mode==='save-error'&&write)return resolve({data:null,error:{message:'SERVER giữ nguyên $&'}});
   let data=mode==='empty'?[]:[...tables[table]];
   for(const op of operations){if(op.method==='eq')data=data.filter(r=>r[op.args[0]]===op.args[1]);if(op.method==='neq')data=data.filter(r=>r[op.args[0]]!==op.args[1]);if(op.method==='in')data=data.filter(r=>op.args[1].includes(r[op.args[0]]));}
   if(write?.method==='insert'){data=(Array.isArray(write.args[0])?write.args[0]:[write.args[0]]).map((r,i)=>({...r,id:'created-'+i}));tables[table].push(...data);}
   if(write?.method==='update')data.forEach(r=>Object.assign(r,write.args[0]));
   if(write?.method==='delete')tables[table]=tables[table].filter(r=>!data.includes(r));
   resolve({data:operations.some(o=>['single','maybeSingle'].includes(o.method))?(data[0]||null):data,error:null});
  };
  if(!['select','order','limit','eq','neq','in','not','gte','lte','ilike','single','maybeSingle','insert','update','delete'].includes(method))return unexpected({table,method});
  return (...args:any[])=>{operations.push({method,args});return chain;};
 }});return chain;
}
export const supabase={from,rpc:async(name:string,args?:Record<string,any>)=>{
 if(!['get_tan_tao_warehouse_snapshot','record_tan_tao_stock_count','execute_tan_tao_warehouse_command','update_batch_expiry_once','close_kitchen_inventory_month','upsert_po_dispatch_revenue_confirmation','confirm_po_dispatch_revenue'].includes(name))return unexpected(name);
 w.__calls.push({rpc:name,args});
 if(mode==='loading'&&name==='get_tan_tao_warehouse_snapshot')return new Promise(()=>{});
 if(mode==='error'||mode==='save-error'&&name!=='get_tan_tao_warehouse_snapshot'||mode==='confirm-error'&&name==='upsert_po_dispatch_revenue_confirmation')return {data:null,error:{message:'SERVER giữ nguyên $&'}};
 if(name==='get_tan_tao_warehouse_snapshot')return {data:mode==='empty'?{can_manage:true,items:[],recent_documents:[]}:snapshot,error:null};
 if(name==='record_tan_tao_stock_count'||name==='execute_tan_tao_warehouse_command')return {data:{status:'posted',document:{document_number:'TT-NEW',document_type:'opening'},snapshot},error:null};
 if(name==='update_batch_expiry_once'){tables.inventory_batches[0].expiry_date=args.p_expiry_date;tables.inventory_batches[0].expiry_edit_count=1;}
 if(name==='close_kitchen_inventory_month')tables.kitchen_inventory_monthly_closings=[{id:'closed',period_month:args.p_period_month,status:'closed'}];
 if(name==='upsert_po_dispatch_revenue_confirmation'){
  const missing=args._payload.lines.some((l:any)=>l.defect_qty>0&&!l.sku);
  return {data:{id:'confirmation-new',amount_status:missing?'needs_sku_allocation':'confirmed_dispatch_amount',confirmed_revenue_amount_vat_included:missing?null:800000},error:null};
 }
 return {data:null,error:null};
}};
