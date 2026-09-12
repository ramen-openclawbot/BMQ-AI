// Synthetic fixtures only. This module never imports an external client or credentials.
const month = new Date().toISOString().slice(0, 7);
const date = `${month}-03T04:05:00Z`;
export const sku = {
  id: 'fixture-sku-1', sku_code: 'QA-TP-001', product_name: 'Bánh chà bông thử nghiệm',
  category: 'Thành phẩm', sku_type: 'finished_good', unit: 'cái', unit_price: 15000,
  updated_at: date, finished_output_qty: 100, finished_output_unit: 'cái',
  notes: 'Ghi chú thử nghiệm — giữ nguyên', hide_from_dealer_portal: false,
  cost_values: { material_cost: 650, selling_price: 15000, packaging_cost: 200, labor_cost: 300, sga_cost: 100 },
};
const materials = ['Bột mì thử nghiệm', 'Đường thử nghiệm', 'Muối thử nghiệm', 'Bơ thử nghiệm'].map((name, i) => ({
  id: `material-${i}`, material_code: `QA-NVL-${i}`, canonical_name: name, default_unit: 'g', ingredient_sku_id: `ingredient-${i}`,
}));
const formulas = materials.map((m, i) => ({
  id: `formula-${i}`, sku_id: sku.id, ingredient_sku_id: m.ingredient_sku_id, ingredient_name: m.canonical_name,
  canonical_material_id: m.id, material_code: m.material_code, canonical_default_unit: 'g', material_resolution_status: 'resolved_exact',
  unit: 'g', unit_price: 10, dosage_qty: 100, wastage_percent: 0, sort_order: i,
}));
const tables: Record<string, unknown[]> = {
  product_skus: [sku, { ...sku, id: 'fixture-sku-2', sku_code: 'QA-TP-002', product_name: 'Bánh không giá thử nghiệm', hide_from_dealer_portal: true, cost_values: {} }, ...materials.map(m => ({ id: m.ingredient_sku_id, sku_code: m.material_code, product_name: m.canonical_name, category: 'Nguyên liệu', sku_type: 'ingredient', unit: 'g', unit_price: 10 }))],
  sku_formulations: formulas,
  sku_cogs_materials: materials,
  sku_cogs_versions: [{id: 'version-1', version_no: 1, effective_from: `${month}-01`, effective_to: null, change_reason: 'Ghi chú lịch sử giữ nguyên', created_at: date}],
  payment_request_items: materials.map((m, i) => ({ sku_id: m.ingredient_sku_id, product_name: m.canonical_name, product_code: m.material_code, unit: 'g', quantity: 100, unit_price: i === 3 ? 35 : 11, line_total: (i === 3 ? 35 : 11) * 100, created_at: date, confirmed_standard_cost_code: m.material_code, payment_request_id: `pr-${i}`, payment_requests: { request_number: `QA-PR-${i}`, payment_status: 'paid', status: 'approved', paid_at: date } })),
  purchase_order_items: [], inventory_batches: [],
};
const w = window as unknown as { __fixtureCalls: unknown[]; __fixtureMode: string; __fixtureDelay: number };
w.__fixtureCalls = [];
w.__fixtureMode = new URLSearchParams(location.search).get('fixture') || 'data';
w.__fixtureDelay = w.__fixtureMode === 'loading' ? 1200 : 5;
function query(table: string, rpcArgs?: unknown) {
  const operations: Array<{ method: string; args: unknown[] }> = [];
  let single = false;
  const chain = new Proxy({}, {
    get(_target, method: string) {
      if (method === 'then') return (resolve: (value: unknown) => void) => {
        w.__fixtureCalls.push({ table, rpcArgs, operations });
        setTimeout(() => {
          if (w.__fixtureMode === 'error' || (w.__fixtureMode === 'save-error' && table === 'save_sku_cogs')) return resolve({ data: null, error: { message: 'SYNTHETIC_FAILURE', code: 'FIXTURE' } });
          let data = w.__fixtureMode === 'empty' ? [] : [...(tables[table] || [])];
          if(table === 'sku_formulations' && w.__fixtureMode === 'unresolved') data = data.map(r => ({...(r as object), canonical_material_id: null, material_resolution_status: 'pending_resolution'}));
          if(table === 'sku_formulations' && w.__fixtureMode === 'zero-cost') data = data.map(r => ({...(r as object), unit_price: 0}));
          for (const op of operations) {
            if (op.method === 'eq') data = data.filter((r: Record<string, unknown>) => !(op.args[0] in r) || r[String(op.args[0])] === op.args[1]);
          }
          if (table === 'save_sku_cogs') return resolve({ data: { saved_sku_id: sku.id }, error: null });
          const update = operations.find(op => op.method === 'update');
          if (update) data = [{ ...sku, ...(update.args[0] as object) }];
          resolve({ data: single ? data[0] || null : data, error: null });
        }, w.__fixtureDelay);
      };
      return (...args: unknown[]) => { if (method === 'single' || method === 'maybeSingle') single = true; operations.push({ method, args }); return chain; };
    },
  });
  return chain;
}
export const supabase = {
  from: (table: string) => query(table),
  rpc: (name: string, args?: unknown) => query(name, args),
  auth: { getSession: async () => ({ data: { session: null } }), refreshSession: async () => ({ data: { session: null } }) },
  functions: { invoke: async (name: string, options?: { body: Record<string, unknown> }) => {
    if (name !== 'revenue-monthly-parse-preview') return { data: { token: 'fixture-only' }, error: null };
    const body = options?.body || {};
    w.__fixtureCalls.push({ function: name, body });
    const mode = new URLSearchParams(location.search).get('revenue') || 'report';
    if (mode === 'load-error' || (mode === 'preview-error' && body.action === 'preview_daily_compare') || (mode === 'post-error' && body.action === 'confirm_daily_overwrite')) throw null;
    if (mode === 'no-message') return { data: null, error: { message: '' } };
    if (mode === 'server-error') return { data: null, error: { message: 'SERVER giữ nguyên $&' } };
    const report = { sourceDocumentId: 'source-fixture', revenueDate: '2026-09-03', period: '2026-09', summary: { grossRevenue: 15000, lineCount: 2, quantity: 3 } };
    return { data: body.action === 'latest_auto_daily_report' ? { report: mode === 'empty' ? null : report } : { runId: 'run-fixture', revenueDate: report.revenueDate, existingReport: mode === 'empty' ? null : report, requiresCancellationConfirmation: mode !== 'empty', comparison: { totals: { delta: { grossRevenue: 1000, lineCount: 1 } }, channels: [{ channel: 'Kênh giữ nguyên', current: { grossRevenue: 15000, rows: 2 }, preview: { grossRevenue: 16000, rows: 3 }, delta: { grossRevenue: 1000, rows: 1, quantity: 1 } }] } }, error: null };
  } },
  storage: { from: (bucket: string) => ({
    upload: async (path: string, file: File, options: unknown) => { w.__fixtureCalls.push({ bucket, path, file: { name: file.name, size: file.size, type: file.type }, options }); return { error: w.__fixtureMode === 'upload-error' ? { message: 'SYNTHETIC_UPLOAD_FAILURE' } : null }; },
    getPublicUrl: () => ({ data: { publicUrl: '/fixture-image.svg' } }),
  }) },
};
