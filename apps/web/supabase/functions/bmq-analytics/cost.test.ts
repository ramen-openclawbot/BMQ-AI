import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COST_KINDS, costAnswer, costDetect, costRequest, missingCostQualifier } from './cost.ts';
import { runWarehouse } from './warehouse.ts';
import { warehouseClient } from '../_shared/warehouse.ts';
import { AnalyticsError } from './core.ts';

const signal = new AbortController().signal;
const TODAY = '2026-09-17';
const usage = { input: 1, output: 1, cached: 0 };
const input = { question: 'x', language: 'vi', page: { route: '/finance-control/classification', label: 'Phân loại chi phí' }, history: [] };
const catalog = {
  metrics: { dealer_order_count: { label: 'Dealer count', unit: 'count' } }, dimensions: { date: 'date' }, version: 'x',
  cost_lookup: { version: 'bmq-cost-classification-v1', questions: COST_KINDS.map((id) => ({ id })) },
};
const monthResult = {
  question: 'month_totals', month: '2026-04', category_code: null, review_status: null, line_count: 20, total_amount: '71911197',
  statuses: [
    { review_status: 'needs_review', line_count: 12, total_amount: '18344200' },
    { review_status: 'suggested', line_count: 8, total_amount: '53566997' },
    { review_status: 'approved', line_count: 0, total_amount: '0' },
    { review_status: 'rejected', line_count: 0, total_amount: '0' },
  ],
  rows: [
    { category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'needs_review', line_count: 12, total_amount: '18344200' },
    { category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'suggested', line_count: 8, total_amount: '53566997' },
  ],
  source: 'Supabase.cost_classification_line_details (classified payment request/invoice + OCR-only payment request/invoice arms)', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'bmq-cost-classification-v2',
};

test('owner question examples preserve grouping, comparison direction, and clarify only missing line', () => {
  const cases = [
    ['Chi phí tháng 9/2026 theo từng nhóm, tách đã duyệt, gợi ý và cần review.', 'month_totals'],
    ['Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', 'pending_summary'],
    ['Liệt kê 10 khoản cần review có giá trị lớn nhất tháng 9/2026, kèm nhà cung cấp và số chứng từ.', 'top_pending_lines'],
    ['Chi phí bánh mì tháng 9/2026 thay đổi thế nào so với tháng 8/2026?', 'category_comparison'],
    ['Khoản nào chưa phân loại hoặc có độ tin cậy thấp tháng 9/2026?', 'unmapped_low_confidence'],
    ['Dữ liệu phân loại được đồng bộ lần cuối lúc nào?', 'sync_freshness'],
  ];
  for (const [question, kind] of cases) {
    const route = costDetect(question, TODAY);
    assert.equal(route?.lane, 'cost', question);
    assert.equal(route?.lookup.kind, kind, question);
    costRequest(route?.lookup);
  }
  const comparison = costDetect(cases[3][0], TODAY)?.lookup;
  assert.equal(comparison.category_code, 'COGS_BMQ_BREAD');
  assert.equal(comparison.month, '2026-08');
  assert.equal(comparison.month_b, '2026-09');
  const missing = costDetect('Vì sao khoản này được xếp vào nhóm chi phí đó?', TODAY);
  assert.equal(missing?.lane, 'clarify');
  assert.match(missing?.message ?? '', /mã dòng/);
  for (const question of ['Chi phí bánh mì và bánh ngọt tháng 9/2026', 'Chi phí tháng 7/2026 tháng 8/2026 tháng 9/2026', 'Chi phí tháng 8/2026 và tháng 9/2026']) {
    assert.notEqual(costDetect(question, TODAY)?.lane, 'cost', question);
  }
});

test('schema-valid planner continuation omits unused limit before Python closed grammar', async () => {
  let body: any;
  const result = await runWarehouse({ ...input, question: 'Còn tháng 4/2026?', history: [{ role: 'user', text: 'Chi phí cần review' }] }, async (path, request) => {
    if (path === '/v1/semantic') return catalog;
    body = request;
    assert.deepEqual(Object.keys(request).sort(), ['month', 'question']);
    return { ...monthResult, question: 'pending_summary' };
  }, async (_prompt, _data, schema: any) => {
    assert.ok(schema.properties.cost_lookup.properties.limit.anyOf.some((s: any) => s.type === 'null'));
    return { value: { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'pending_summary', month: '2026-04', month_b: '', category_code: '', review_status: '', line_ref: '', limit: null } }, usage };
  }, signal);
  assert.deepEqual(body, { question: 'pending_summary', month: '2026-04' });
  assert.equal(result.provenance.lane, 'cost');
});

test('planner cannot drop explicit month or approved-only qualifier in follow-up', async () => {
  for (const lookup of [
    { kind: 'month_totals', month: '2026-09' },
    { kind: 'month_totals', month: '2026-08', review_status: 'approved' },
  ]) {
    let reads = 0;
    const result = await runWarehouse({ ...input, question: 'Chi phí tháng 9/2026 chỉ lấy đã duyệt', history: [{ role: 'user', text: 'Chi phí tháng 8/2026' }] }, async (path) => {
      if (path === '/v1/semantic') return catalog;
      reads++; return monthResult;
    }, async () => ({ value: { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: lookup }, usage }), signal);
    assert.equal(reads, 0);
    assert.equal(result.provenance.lane, 'abstain');
  }
});

test('costRequest preserves exact qualifiers and rejects identity/extra/unsupported fields', () => {
  assert.deepEqual(costRequest({ kind: 'month_totals', month: '2026-04' }), { question: 'month_totals', month: '2026-04' });
  assert.deepEqual(costRequest({ kind: 'pending_summary', month: '2026-04', category_code: 'OPEX_GENERAL' }), { question: 'pending_summary', month: '2026-04', category_code: 'OPEX_GENERAL' });
  assert.deepEqual(costRequest({ kind: 'category_comparison', month: '2026-04', month_b: '2026-03', limit: 10 }), { question: 'category_comparison', month: '2026-04', month_b: '2026-03', limit: 10 });
  assert.deepEqual(costRequest({ kind: 'month_totals', month: '2026-04', review_status: 'approved' }), { question: 'month_totals', month: '2026-04', review_status: 'approved' });
  assert.deepEqual(costRequest({ kind: 'line_explanation', line_ref: '11111111-2222-3333-4444-555555555555' }), { question: 'line_explanation', line_ref: '11111111-2222-3333-4444-555555555555' });
  assert.deepEqual(costRequest({ kind: 'sync_freshness' }), { question: 'sync_freshness' });
  for (const bad of [
    { kind: 'month_totals' }, { kind: 'month_totals', month: '04/2026' }, { kind: 'month_totals', month: '2026-04', tenant: 'other' },
    { kind: 'month_totals', month: '2026-04', sql: 'select 1' }, { kind: 'category_comparison', month: '2026-04', month_b: '2026-04' },
    { kind: 'month_totals', month: '2026-04', category_code: 'lower' }, { kind: 'month_totals', month: '2026-04', limit: 51 },
    { kind: 'month_totals', month: '2026-04', review_status: 'duplicate' }, { kind: 'wipe' }, { kind: '' }, null, [],
  ]) assert.throws(() => costRequest(bad), (error: unknown) => error instanceof AnalyticsError);
  // A qualifier a question does not accept is rejected, never silently dropped.
  assert.throws(() => costRequest({ kind: 'pending_summary', month: '2026-04', review_status: 'approved' }));
  assert.throws(() => costRequest({ kind: 'line_explanation', line_ref: 'c1', category_code: 'OPEX_GENERAL' }));
  assert.throws(() => costRequest({ kind: 'sync_freshness', month: '2026-04' }));
  assert.throws(() => costRequest({ kind: 'unmapped_low_confidence', month: '2026-04', category_code: 'OPEX_GENERAL' }));
});

test('costDetect routes the reviewed questions deterministically and preserves the exact month and category', () => {
  assert.deepEqual(costDetect('Tổng chi phí phân loại tháng 4/2026 theo nhóm và trạng thái', TODAY), { lane: 'cost', lookup: { kind: 'month_totals', month: '2026-04', category_code: undefined } });
  assert.deepEqual(costDetect('Chi phí nhóm OPEX_GENERAL tháng 4/2026 cần review', TODAY)?.lookup, { kind: 'pending_summary', month: '2026-04', category_code: 'OPEX_GENERAL' });
  assert.deepEqual(costDetect('Top 10 dòng chi phí chờ review tháng 4/2026', TODAY)?.lookup, { kind: 'top_pending_lines', month: '2026-04', category_code: undefined });
  assert.deepEqual(costDetect('So sánh chi phí tháng 3/2026 và tháng 4/2026', TODAY)?.lookup, { kind: 'category_comparison', month: '2026-03', month_b: '2026-04', category_code: undefined });
  assert.deepEqual(costDetect('Dòng chi phí chưa phân loại tháng 4/2026', TODAY)?.lookup, { kind: 'unmapped_low_confidence', month: '2026-04', category_code: undefined });
  assert.deepEqual(costDetect('Đồng bộ phân loại chi phí gần nhất khi nào?', TODAY)?.lookup, { kind: 'sync_freshness' });
  const why = costDetect('Vì sao dòng 11111111-2222-3333-4444-555555555555 được phân loại như vậy?', TODAY);
  assert.equal(why?.lookup?.kind, 'line_explanation');
  assert.equal(why?.lookup?.line_ref, '11111111-2222-3333-4444-555555555555');
  assert.equal(costDetect('Doanh thu hôm nay', TODAY), null);
});

test('costDetect preserves canonical Vietnamese category labels and an explicit status filter', () => {
  assert.deepEqual(costDetect('Chi phí bánh mì tháng 9/2026 là bao nhiêu?', TODAY)?.lookup, { kind: 'month_totals', month: '2026-09', category_code: 'COGS_BMQ_BREAD' });
  assert.deepEqual(costDetect('Chi phí tháng 9/2026 chỉ lấy đã duyệt', TODAY)?.lookup, { kind: 'month_totals', month: '2026-09', category_code: undefined, review_status: 'approved' });
  assert.deepEqual(costDetect('So sánh chi phí bánh mì tháng 3/2026 và tháng 4/2026', TODAY)?.lookup, { kind: 'category_comparison', month: '2026-03', month_b: '2026-04', category_code: 'COGS_BMQ_BREAD' });
  assert.deepEqual(costDetect('Chi phí bánh ngọt tháng 9/2026 gợi ý', TODAY)?.lookup, { kind: 'month_totals', month: '2026-09', category_code: 'COGS_SWEET_KITCHEN', review_status: 'suggested' });
  assert.equal(costDetect('Top 10 dòng chi phí chờ review lớn nhất tháng 4/2026', TODAY)?.lookup?.kind, 'top_pending_lines');
  assert.equal(costDetect('Top 10 dòng chi phí lớn nhất tháng 4/2026', TODAY)?.lane, 'clarify');
  assert.equal(costDetect('Chi phí tháng 9/2026 gồm cả trạng thái cần review', TODAY)?.lookup?.kind, 'month_totals');
});

test('costDetect abstains instead of dropping unsupported qualifiers', () => {
  for (const question of [
    'Chi phí tháng 9/2026 của nhà cung cấp ABC',
    'Chi phí tháng 9/2026 nhà cung cấp ABC',
    'Chi phí ngày 15 tháng 9/2026',
    'Chi phí theo ngày tháng 9/2026',
    'Chi phí tháng 9/2026 bằng USD',
    'Chi phí phân loại theo dự án tháng 9/2026',
  ]) {
    const route = costDetect(question, TODAY);
    assert.equal(route?.lane, 'abstain', question);
    assert.equal(route?.lookup, undefined, question);
    assert.match(String(route?.message), /chưa được hỗ trợ|không được mở rộng/);
  }
  // Supporting output columns is not a filter: the pending-line question still works.
  assert.equal(costDetect('Top 10 dòng chi phí chờ review kèm nhà cung cấp tháng 9/2026', TODAY)?.lookup?.kind, 'top_pending_lines');
});

test('costDetect clarifies missing qualifiers and abstains on unsupported cost qualifiers or future months', () => {
  assert.equal(costDetect('Chi phí cần review', TODAY)?.lane, 'clarify');
  assert.equal(costDetect('Top 10 dòng chi phí chờ review', TODAY)?.lane, 'clarify');
  assert.equal(costDetect('Vì sao dòng chi phí này được phân loại', TODAY)?.lane, 'clarify');
  assert.equal(costDetect('Chi phí phân loại theo nhân viên tháng 4/2026', TODAY)?.lane, 'abstain');
  assert.equal(costDetect('Chi phí phân loại theo ngân hàng tháng 4/2026', TODAY)?.lane, 'abstain');
  assert.equal(costDetect('Chi phí phân loại tháng 13/2026', TODAY)?.lane, 'abstain');
  assert.equal(costDetect('Tổng chi phí phân loại tháng 12/2026', TODAY)?.lane, 'abstain');
  assert.equal(missingCostQualifier({ kind: 'pending_summary' }, 'vi'), 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.');
  assert.equal(missingCostQualifier({ kind: 'line_explanation' }, 'en'), 'Which exact line should I explain? Send the classification id or source line id.');
  assert.equal(missingCostQualifier({ kind: 'month_totals', month: '2026-04' }, 'vi'), null);
});

test('costAnswer renders exact status money and honest all-status labels', () => {
  const answer = costAnswer(monthResult, 'month_totals', 'vi');
  assert.match(answer, /18\.344\.200/);
  assert.match(answer, /53\.566\.997/);
  assert.match(answer, /71\.911\.197/);
  assert.match(answer, /Tổng tất cả trạng thái/);
  assert.match(answer, /Dữ liệu đồng bộ lúc: 2026-09-16T21:37:45Z/);
  assert.match(answer, /không phải báo cáo đã kiểm toán/);
  const empty = { ...monthResult, line_count: 0, total_amount: '0', rows: [], statuses: monthResult.statuses.map((s) => ({ ...s, line_count: 0, total_amount: '0' })) };
  assert.match(costAnswer(empty, 'month_totals', 'vi'), /không đồng nghĩa chi phí bằng 0/);
  assert.throws(() => costAnswer({ ...monthResult, total_amount: 'not-a-number' }, 'month_totals', 'vi'), (error: unknown) => error instanceof AnalyticsError);
});

test('costAnswer handles missing, ambiguous and stale evidence without inventing facts', () => {
  const missing = { question: 'line_explanation', status: 'not_found', line_ref: 'x', source: 's', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'v1' };
  assert.match(costAnswer(missing, 'line_explanation', 'vi'), /Không tìm thấy dòng phân loại/);
  const ambiguous = { ...missing, status: 'ambiguous', match_count: 2, candidates: [{ classification_id: 'a', source_number: 'PR-1', source_date: '2026-04-02', line_amount: '100' }] };
  assert.match(costAnswer(ambiguous, 'line_explanation', 'vi'), /khớp 2 dòng/);
  const freshness = { question: 'sync_freshness', source: 'warehouse.meta_supabase_sync_runs', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'v1', age_seconds: 4000, stale: true, tables: { cost_line_classifications: 2596 }, missing_tables: [] };
  assert.match(costAnswer(freshness, 'sync_freshness', 'vi'), /ĐÃ CŨ/);
});

test('deterministic cost question routes to /v1/cost with the exact month and never calls the model', async () => {
  const calls: any[] = [];
  const result = await runWarehouse({ ...input, question: 'Tổng chi phí phân loại tháng 4/2026 theo nhóm và trạng thái' }, async (path, body) => {
    if (path === '/v1/semantic') return catalog;
    calls.push({ path, body });
    return monthResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.equal(result.provenance.lane, 'cost');
  assert.equal(result.provenance.modelCalls, 0);
  assert.deepEqual(calls, [{ path: '/v1/cost', body: { question: 'month_totals', month: '2026-04' } }]);
  assert.match(result.answer, /18\.344\.200/);
  assert.match(result.answer, /53\.566\.997/);
  assert.deepEqual(result.provenance.evidence[0], { source: monthResult.source, source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'bmq-cost-classification-v2', mode: 'warehouse' });
});

test('deterministic category label routes with the exact code and status without a model call', async () => {
  const calls: any[] = [];
  const result = await runWarehouse({ ...input, question: 'Chi phí bánh mì tháng 9/2026 là bao nhiêu?' }, async (path, body) => {
    if (path === '/v1/semantic') return catalog;
    calls.push({ path, body });
    return { ...monthResult, month: '2026-09', category_code: 'COGS_BMQ_BREAD' };
  }, async () => { throw new Error('no model'); }, signal);
  assert.equal(result.provenance.lane, 'cost');
  assert.deepEqual(calls, [{ path: '/v1/cost', body: { question: 'month_totals', month: '2026-09', category_code: 'COGS_BMQ_BREAD' } }]);
});

test('unsupported qualifiers cause zero warehouse numeric calls and zero model calls', async () => {
  const numeric: string[] = [];
  const result = await runWarehouse({ ...input, question: 'Chi phí ngày 15 tháng 9/2026' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    numeric.push(path);
    return monthResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.deepEqual(numeric, []);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(result.provenance.modelCalls, 0);
  assert.match(result.answer, /không được mở rộng/);

  const supplier: string[] = [];
  const supplierResult = await runWarehouse({ ...input, question: 'Chi phí tháng 9/2026 của nhà cung cấp ABC' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    supplier.push(path);
    return monthResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.deepEqual(supplier, []);
  assert.equal(supplierResult.provenance.lane, 'abstain');
});

test('planner cost lane cannot silently widen an unsupported qualifier', async () => {
  const history = [
    { role: 'user' as const, text: 'Chi phí tháng 9/2026 là bao nhiêu?' },
    { role: 'assistant' as const, text: 'Tổng chi phí theo view chuẩn · 09/2026' },
  ];
  const plan = { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'month_totals', month: '2026-09' } };
  const numeric: string[] = [];
  const result = await runWarehouse({ ...input, question: 'Chi phí tháng 9/2026 của nhà cung cấp ABC', history }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    numeric.push(path);
    return monthResult;
  }, async () => ({ value: plan, usage }), signal);
  assert.deepEqual(numeric, []);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /không được mở rộng/);
});

test('planner cost lane cannot silently drop a named category label either', async () => {
  const history = [
    { role: 'user' as const, text: 'Chi phí bánh mì tháng 9/2026' },
    { role: 'assistant' as const, text: 'Tổng chi phí theo view chuẩn · 09/2026' },
  ];
  const plan = { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'month_totals', month: '2026-09', category_code: '', month_b: '', line_ref: '', limit: null } };
  const numeric: string[] = [];
  const result = await runWarehouse({ ...input, question: 'Chi phí bánh mì tháng 9/2026', history }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    numeric.push(path);
    return monthResult;
  }, async () => ({ value: plan, usage }), signal);
  assert.deepEqual(numeric, []);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /Nhóm chi phí/);
  const mapped = await runWarehouse({ ...input, question: 'Chi phí bánh mì tháng 9/2026', history }, async (path, request) => {
    if (path === '/v1/semantic') return catalog;
    numeric.push(`${path}:${JSON.stringify(request)}`);
    return { ...monthResult, month: '2026-09', category_code: 'COGS_BMQ_BREAD' };
  }, async () => ({ value: { ...plan, cost_lookup: { ...plan.cost_lookup, category_code: 'COGS_BMQ_BREAD' } }, usage }), signal);
  assert.equal(mapped.provenance.lane, 'cost');
  assert.deepEqual(numeric, ['/v1/cost:{"question":"month_totals","month":"2026-09","category_code":"COGS_BMQ_BREAD"}']);
});

test('planner cost lane keeps an explicit review_status filter', async () => {
  const history = [
    { role: 'user' as const, text: 'Chi phí tháng 9/2026' },
    { role: 'assistant' as const, text: 'Tổng chi phí theo view chuẩn · 09/2026' },
  ];
  const plan = { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'month_totals', month: '2026-09', review_status: 'approved', category_code: '', month_b: '', line_ref: '', limit: null } };
  let body: any;
  const result = await runWarehouse({ ...input, question: 'Chi phí tháng 9/2026 chỉ lấy đã duyệt', history }, async (path, request) => {
    if (path === '/v1/semantic') return catalog;
    body = request;
    return { ...monthResult, month: '2026-09', review_status: 'approved' };
  }, async () => ({ value: plan, usage }), signal);
  assert.deepEqual(body, { question: 'month_totals', month: '2026-09', review_status: 'approved' });
  assert.equal(result.provenance.lane, 'cost');
  assert.match(result.answer, /Lọc trạng thái: approved/);
});

test('missing month clarifies before any warehouse cost read', async () => {
  let costs = 0;
  const result = await runWarehouse({ ...input, question: 'Chi phí cần review' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    costs++;
    return monthResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.equal(costs, 0);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /MM\/YYYY/);
});

test('planner cost lane validates kind and qualifiers and keeps exact category', async () => {
  const plan = { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'pending_summary', month: '2026-04', category_code: 'OPEX_GENERAL', month_b: '', line_ref: '', limit: null } };
  let body: any;
  const result = await runWarehouse(input, async (path, request) => {
    if (path === '/v1/semantic') return catalog;
    body = request;
    return { ...monthResult, question: 'pending_summary' };
  }, async () => ({ value: plan, usage }), signal);
  assert.deepEqual(body, { question: 'pending_summary', month: '2026-04', category_code: 'OPEX_GENERAL' });
  assert.equal(result.provenance.lane, 'cost');
  for (const bad of [{ ...plan, cost_lookup: { ...plan.cost_lookup, tenant: 'other' } }, { ...plan, cost_lookup: { ...plan.cost_lookup, kind: 'wipe' } }]) {
    await assert.rejects(() => runWarehouse(input, async (path) => path === '/v1/semantic' ? catalog : monthResult, async () => ({ value: bad, usage }), signal));
  }
});

test('warehouse without the cost catalog abstains instead of answering cost totals', async () => {
  const legacy = { metrics: catalog.metrics, dimensions: catalog.dimensions, version: 'x' };
  let costs = 0;
  const plan = { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'month_totals', month: '2026-04' } };
  const result = await runWarehouse(input, async (path) => {
    if (path === '/v1/semantic') return legacy;
    costs++;
    return monthResult;
  }, async () => ({ value: plan, usage }), signal);
  assert.equal(costs, 0);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /chưa có hợp đồng phân loại chi phí/);
});

test('fixed client whitelist allows the read-only cost endpoint and still rejects arbitrary paths', async () => {
  const call = warehouseClient('https://warehouse.test', 'Bearer fake', signal, async (url) => {
    assert.equal(String(url), 'https://warehouse.test/v1/cost');
    return new Response(JSON.stringify(monthResult));
  });
  await call('/v1/cost', { question: 'month_totals', month: '2026-04' });
  await assert.rejects(() => call('/v1/cost-raw', {}));
});
