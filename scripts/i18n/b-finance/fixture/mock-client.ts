// Closed fixture: unknown tables/RPCs fail. No production client or credentials.
const w = window as unknown as { __fixtureCalls: unknown[]; __fixtureMode: string };
w.__fixtureCalls = [];
w.__fixtureMode = new URLSearchParams(location.search).get('fixture') || 'data';
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const drafts = Array.from({ length: 22 }, (_, i) => ({
  id: `draft-${i}`, customer_id: 'customer-fixture', sales_po_doc_id: 'po-fixture', status: i === 21 ? 'exception' : 'pending',
  source: 'Nguồn giữ nguyên', po_number: `PO-${i}`, po_order_date: today, delivery_date: today,
  total_amount: 15000 + i, raw_payload: {}, created_at: `${today}T04:00:00Z`, updated_at: null,
  mini_crm_customers: { customer_name: `Khách hàng giữ nguyên ${i}` },
}));
const requests = [
  { id: 'pr-1', request_number: 'QA-PR-1', title: 'Nội dung giữ nguyên', total_amount: 15000, payment_allocations: [{ id: 'a1', amount: 5000 }], payment_method: 'cash', payment_status: 'partial', status: 'approved', created_at: `${today}T04:00:00Z`, suppliers: { name: 'Nhà cung cấp giữ nguyên' }, payment_request_items: [{ product_name: 'Bánh giữ nguyên' }], goods_receipt_id: null, purchase_order_id: null, invoice_id: null, image_url: null, invoice_created: true, delivery_status: 'delivered' },
  { id: 'pr-2', request_number: 'QA-PR-2', title: 'Đã thanh toán giữ nguyên', total_amount: 30000, payment_allocations: [{ id: 'a2', amount: 30000 }], payment_method: 'bank_transfer', payment_status: 'paid', status: 'approved', created_at: `${today}T04:00:00Z`, suppliers: { name: 'Nhà cung cấp khác' }, payment_request_items: [], goods_receipt_id: null, purchase_order_id: null, invoice_id: null, image_url: null, invoice_created: true, delivery_status: 'delivered' },
];
if (['pending','invoice','drive','drive-configured'].includes(w.__fixtureMode)) {
 requests[0].invoice_created=false;
 if(w.__fixtureMode==='pending') requests[0].status='pending';
}
const customers = [
 {id:'direct',customer_name:'Khách giữ nguyên $&',customer_group:'B2B',is_active:true,is_npp:false},
 {id:'npp',customer_name:'Đại lý cấp 1 - Anh Thanh',is_active:true,is_npp:true},
 {id:'agency',customer_name:'Đại lý giữ nguyên',is_active:true,supplied_by_npp_customer_id:'npp',npp_management_fee_vnd:2000}
];
const ledger = [
 {id:'line-1',revenue_date:today,invoice_no:'PO-QA',channel:'B2B',customer_id:'direct',customer_name:'Khách giữ nguyên $&',product_name:'Bánh giữ nguyên',item_note:'Ghi chú giữ nguyên',quantity:3,unit_price:10000,gross_revenue:30000,approval_status:'approved',raw_payload:{}},
 {id:'line-2',revenue_date:today,channel:'agency',customer_id:'agency',parent_customer_id:'npp',customer_name:'Đại lý giữ nguyên',product_name:'Bánh giữ nguyên',quantity:2,unit_price:10000,gross_revenue:20000,approval_status:'approved',raw_payload:{}}
];
const costSummary={month:today.slice(0,7)+'-01',category_code:'OPEX_GENERAL',category_label:'Nhóm giữ nguyên',cost_group:'opex',product_line:'general',allocation_rule:'none',review_status:'approved',line_count:1,total_amount:15000};
const tables: Record<string, Array<Record<string, unknown>>> = { mini_crm_customers:customers, revenue_ledger_lines:ledger, customer_debt_period_adjustments:[], app_settings:[], ceo_daily_closing_declarations:[], daily_reconciliations:[], cost_categories:[], cost_classification_category_summary:[], cost_classification_monthly_summary:[], cost_classification_line_details:[], invoice_items:[], revenue_drafts: drafts, payment_requests: requests, payment_request_items: [{id:'item-1',payment_request_id:'pr-1',product_name:'Bánh giữ nguyên',quantity:3,unit_price:5000,unit:'cái',line_total:15000}], suppliers: [], inventory_items: [], product_skus: [], purchase_orders: [], goods_receipts: [] };
if(w.__fixtureMode==='classification-data') {
 tables.cost_categories=[{code:'OPEX_GENERAL',label:'Nhóm giữ nguyên',is_active:true,sort_order:1,cost_group:'opex',product_line:'general'}];
 tables.cost_classification_monthly_summary=[costSummary];
 tables.cost_classification_category_summary=[costSummary];
 tables.cost_classification_line_details=[{...costSummary,classification_id:'class-1',source_type:'payment_request_item',source_line_id:'item-1',payment_request_id:'pr-1',source_number:'QA-PR-1',source_date:today,supplier_name:'Nhà cung cấp giữ nguyên',product_name:'Bánh giữ nguyên',product_code:'SKU-QA',unit:'cái',quantity:3,unit_price:5000,line_amount:15000,confidence:1}];
}
const tinyImage='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2l8AAAAASUVORK5CYII=';
const slipDeclaration={closing_date:today,unc_total_declared:3000,unc_extracted_amount:3000,cash_fund_topup_amount:5000,qtm_extracted_amount:5000,notes:'Ghi chú CEO giữ nguyên',extraction_meta:{unc_images:[tinyImage],qtm_images:[tinyImage]}};
if(w.__fixtureMode==='slips'||w.__fixtureMode.startsWith('review-'))tables.ceo_daily_closing_declarations=[slipDeclaration];
if(w.__fixtureMode.startsWith('review-'))tables.drive_file_index=[];
if(w.__fixtureMode==='drive-configured'||w.__fixtureMode.startsWith('review-')) tables.app_settings=[{key:'google_drive_receipts_folder',value:'https://drive.example.invalid/folder'}];
function query(table: string) {
  if (!(table in tables)) throw new Error(`Unexpected fixture table: ${table}`);
  const operations: Array<{ method: string; args: unknown[] }> = [];
  const chain = new Proxy({}, { get(_target, method: string) {
    if (method === 'then') return (resolve: (value: unknown) => void) => {
      w.__fixtureCalls.push({ table, operations });
      if(operations.some(op=>op.method==='update') && table!=='payment_requests') throw new Error('Unexpected fixture update');
      if(operations.some(op=>op.method==='upsert') && table!=='ceo_daily_closing_declarations' && !(w.__fixtureMode.startsWith('review-') && table==='drive_file_index')) throw new Error('Unexpected fixture write');
      if (w.__fixtureMode === 'loading') return;
      if(w.__fixtureMode==='save-error' && operations.some(op=>op.method==='upsert')) return resolve({data:null,error:{message:'SERVER giữ nguyên $&'}});
      let data = w.__fixtureMode === 'empty' ? [] : tables[table];
      for (const op of operations) {
        if (op.method === 'eq') data = data.filter(row => row[String(op.args[0])] === op.args[1]);
        if (op.method === 'range') data = data.slice(Number(op.args[0]), Number(op.args[1]) + 1);
        if (op.method === 'in') data = data.filter(row => (op.args[1] as unknown[]).includes(row[String(op.args[0])]));
      }
      resolve(w.__fixtureMode === 'error' ? { data: null, error: { message: 'SERVER giữ nguyên $&' } } : { data: operations.some(op => ['single','maybeSingle'].includes(op.method)) ? data[0] || null : data, error: null });
    };
    if (!['select', 'order', 'limit', 'eq', 'in', 'single', 'maybeSingle', 'gte', 'lte', 'lt', 'gt', 'neq', 'or', 'range', 'is', 'upsert', 'update', 'ilike', ...(w.__fixtureMode.startsWith('review-') ? ['not'] : [])].includes(method)) throw new Error(`Unexpected fixture operation: ${method}`);
    return (...args: unknown[]) => { operations.push({ method, args }); return chain; };
  } });
  return chain;
}
export const supabase = {
  auth:{refreshSession:async()=>({data:{session:{access_token:'fixture-token'}},error:null}),getSession:async()=>({data:{session:{access_token:'fixture-token',expires_at:9999999999}},error:null}),getUser:async()=>({data:{user:{id:'fixture-user'}},error:null})},
  from: query,
  rpc: async (name: string, args: unknown) => {
    if (!['edit_revenue_draft_daily_review', 'record_payment_allocations','edit_revenue_ledger_line','upsert_customer_debt_period_adjustment','finance_daily_snapshot'].includes(name)) throw new Error(`Unexpected fixture RPC: ${name}`);
    w.__fixtureCalls.push({ rpc: name, args });
    if(name==='finance_daily_snapshot' && (w.__fixtureMode==='slips'||w.__fixtureMode.startsWith('review-'))) return {data:{declaration:slipDeclaration,uncDetailAmount:3000,qtmOpeningBalance:2000},error:null};
    if(name==='finance_daily_snapshot' && w.__fixtureMode==='loading') return new Promise(()=>{});
    return { data: null, error: ['save-error','error'].includes(w.__fixtureMode) ? { message: 'SERVER giữ nguyên $&' } : null };
  },
};
