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
const tables: Record<string, Array<Record<string, unknown>>> = { revenue_drafts: drafts, payment_requests: requests, payment_request_items: [], suppliers: [], inventory_items: [], purchase_orders: [], goods_receipts: [] };
function query(table: string) {
  if (!(table in tables)) throw new Error(`Unexpected fixture table: ${table}`);
  const operations: Array<{ method: string; args: unknown[] }> = [];
  const chain = new Proxy({}, { get(_target, method: string) {
    if (method === 'then') return (resolve: (value: unknown) => void) => {
      w.__fixtureCalls.push({ table, operations });
      if (w.__fixtureMode === 'loading') return;
      let data = w.__fixtureMode === 'empty' ? [] : tables[table];
      for (const op of operations) {
        if (op.method === 'eq') data = data.filter(row => row[String(op.args[0])] === op.args[1]);
        if (op.method === 'in') data = data.filter(row => (op.args[1] as unknown[]).includes(row[String(op.args[0])]));
      }
      resolve(w.__fixtureMode === 'error' ? { data: null, error: { message: 'SERVER giữ nguyên $&' } } : { data: operations.some(op => op.method === 'single') ? data[0] : data, error: null });
    };
    if (!['select', 'order', 'limit', 'eq', 'in', 'single'].includes(method)) throw new Error(`Unexpected fixture operation: ${method}`);
    return (...args: unknown[]) => { operations.push({ method, args }); return chain; };
  } });
  return chain;
}
export const supabase = {
  from: query,
  rpc: async (name: string, args: unknown) => {
    if (!['edit_revenue_draft_daily_review', 'record_payment_allocations'].includes(name)) throw new Error(`Unexpected fixture RPC: ${name}`);
    w.__fixtureCalls.push({ rpc: name, args });
    return { data: null, error: w.__fixtureMode === 'save-error' ? { message: 'SERVER giữ nguyên $&' } : null };
  },
};
