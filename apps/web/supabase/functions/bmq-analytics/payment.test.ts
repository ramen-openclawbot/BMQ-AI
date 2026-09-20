import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_QUESTIONS, paymentAnswer, paymentDetect, paymentRequest, paymentUnsupportedQualifier, purchaseCuePresent } from './payment.ts';
import { costDetect } from './cost.ts';
import { runWarehouse } from './warehouse.ts';
import { warehouseClient } from '../_shared/warehouse.ts';
import { AnalyticsError } from './core.ts';

const signal = new AbortController().signal;
const TODAY = '2026-09-20';
const usage = { input: 1, output: 1, cached: 0 };
const input = { question: 'x', language: 'vi', page: { route: '/payment-requests', label: 'Duyệt chi' }, history: [] };
const catalog = {
  metrics: { dealer_order_count: { label: 'Dealer count', unit: 'count' } }, dimensions: { date: 'date' }, version: 'x',
  cost_lookup: { version: 'bmq-cost-classification-v1', questions: [] },
  payment_lookup: { version: 'bmq-supplier-payment-v1', questions: PAYMENT_QUESTIONS.map((id) => ({ id })) },
};
const paymentResult = {
  question: 'supplier_payments', month: '2026-09', currency: 'VND', payment_date_basis: 'payments.payment_date',
  supplier_status: 'resolved', supplier: { id: 'sup_tv', name: 'TV Food', short_code: 'TVF' }, supplier_candidates: [],
  total_amount: '13500000', direct_total: '13500000', shared_allocated_total: '0', payment_count: 1,
  truncated: false, limit: 20,
  payments: [{ payment_number: 'PAY-000156', payment_date: '2026-09-10', amount: '13500000', attributed_amount: '13500000', payment_method: 'bank_transfer', shared: false }],
  item: { term: 'bo', mode: 'material', product_name: null, material: { id: 'mat_bo', material_code: 'NVL-BO', canonical_name: 'Bơ' } },
  item_candidates: [], item_status: 'unavailable', item_amount: null,
  unresolved_item_count: 1, candidate_items: ['BỘ PEERLESS'], mixed_allocation_count: 0, unresolved_allocation_count: 1,
  source: 'Supabase.payments + payment_allocations + payment_requests + payment_request_items + suppliers + sku_cogs_materials',
  source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'bmq-supplier-payment-v1',
};

test('literal T9 butter TV Food routes to the exact month, supplier and item', () => {
  const route = paymentDetect('T9 đã thanh toán bao nhiêu tiền bơ cho TV food', TODAY);
  assert.deepEqual(route, { lane: 'payment', measure: 'payment', lookup: { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' } });
  paymentRequest(route?.lookup);
});

test('paymentDetect preserves month, year, supplier and item qualifiers', () => {
  assert.deepEqual(paymentDetect('Tháng 9/2026 đã thanh toán bao nhiêu tiền bơ cho TV Food', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' });
  assert.deepEqual(paymentDetect('T9 2025 thanh toán cho TV Food bao nhiêu', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2025-09', supplier: 'tv food' });
  assert.deepEqual(paymentDetect('tháng trước đã thanh toán cho TV Food bao nhiêu', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-08', supplier: 'tv food' });
  assert.deepEqual(paymentDetect('T9 đã thanh toán bao nhiêu', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09' });
  // A generic "tiền hàng" is not an item qualifier.
  assert.deepEqual(paymentDetect('T9 đã thanh toán tiền hàng cho TV Food bao nhiêu', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food' });
  // An item asked without the "tiền" keyword is still preserved, never dropped.
  assert.deepEqual(paymentDetect('T9 đã thanh toán bơ cho TV Food', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' });
  // Redundant "cho nhà cung cấp X" markers describe one supplier, not two.
  assert.deepEqual(paymentDetect('T9 đã thanh toán cho nhà cung cấp TV Food', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food' });
  assert.deepEqual(paymentDetect('T9 đã thanh toán bao nhiêu cho NCC TV Food', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food' });
  // A supplier placed before the period, or introduced by "tại", is still kept.
  assert.deepEqual(paymentDetect('TV Food T9 đã thanh toán bao nhiêu tiền bơ', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' });
  assert.deepEqual(paymentDetect('T9 đã thanh toán bao nhiêu tiền bơ tại TV Food', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' });
  // A legal-form supplier name keeps its own words so the resolver can match exactly.
  assert.deepEqual(paymentDetect('T9 đã thanh toán bao nhiêu cho Công ty A', TODAY)?.lookup,
    { kind: 'supplier_payments', month: '2026-09', supplier: 'cong ty a' });
});

test('paymentDetect clarifies a missing month or supplier and abstains on unsupported qualifiers', () => {
  assert.equal(paymentDetect('Đã thanh toán bao nhiêu cho TV Food', TODAY)?.lane, 'clarify');
  assert.equal(paymentDetect('T9 đã thanh toán bao nhiêu cho', TODAY)?.lane, 'clarify');
  const unsupported = [
    'T9 đã thanh toán ngày 15 cho TV Food',
    'T9 đã thanh toán bằng USD cho TV Food',
    'T9 đã thanh toán bằng tiền mặt cho TV Food',
    'T9 đã thanh toán bằng chuyển khoản cho TV Food',
    'T9 đã thanh toán cho nhà cung cấp A và B',
    'T9 so với T8 đã thanh toán cho TV Food',
    'T9 đã thanh toán tháng 8 và tháng 9 cho TV Food',
  ];
  for (const question of unsupported) {
    const route = paymentDetect(question, TODAY);
    assert.equal(route?.lane, 'abstain', question);
    assert.match(String((route as any)?.message), /chưa được hỗ trợ|chưa cộng/);
  }
  assert.equal(paymentDetect('T9 công nợ TV Food bao nhiêu', TODAY), null);
  assert.equal(paymentDetect('Doanh thu hôm nay', TODAY), null);
  assert.equal(paymentDetect('T9 đã thanh toán tháng 12/2026 cho TV Food', TODAY)?.lane, 'abstain');
  assert.match(String(paymentUnsupportedQualifier('T9 đã thanh toán bằng USD cho TV Food')), /ngoại tệ/);
  assert.equal(paymentUnsupportedQualifier('T9 đã thanh toán cho TV Food'), null);
});

test('paymentRequest preserves exact qualifiers and rejects identity/extra/unsupported fields', () => {
  assert.deepEqual(paymentRequest({ kind: 'supplier_payments', month: '2026-09' }), { question: 'supplier_payments', month: '2026-09' });
  assert.deepEqual(paymentRequest({ kind: 'supplier_payments', month: '2026-09', supplier: 'TV Food', item: 'Bơ', limit: 5 }),
    { question: 'supplier_payments', month: '2026-09', supplier: 'TV Food', item: 'Bơ', limit: 5 });
  for (const bad of [
    { kind: 'supplier_payments' }, { kind: 'supplier_payments', month: '09/2026' },
    { kind: 'supplier_payments', month: '2026-09', tenant: 'other' },
    { kind: 'supplier_payments', month: '2026-09', sql: 'select 1' },
    { kind: 'supplier_payments', month: '2026-09', limit: 51 },
    { kind: 'supplier_payments', month: '2026-09', item: '   ' },
    { kind: 'wipe' }, { kind: '' }, null, [],
  ]) assert.throws(() => paymentRequest(bad), (error: unknown) => error instanceof AnalyticsError);
});

test('literal sentence reaches /v1/payment with the exact scope and no model call', async () => {
  const calls: any[] = [];
  const result = await runWarehouse({ ...input, question: 'T9 đã thanh toán bao nhiêu tiền bơ cho TV food' }, async (path, body) => {
    if (path === '/v1/semantic') return catalog;
    calls.push({ path, body });
    return paymentResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.equal(result.provenance.lane, 'payment');
  assert.equal(result.provenance.modelCalls, 0);
  assert.deepEqual(calls, [{ path: '/v1/payment', body: { question: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: 'bo' } }]);
  assert.match(result.answer, /13\.500\.000/);
  assert.match(result.answer, /PAY-000156/);
  assert.match(result.answer, /không xác định được/);
  assert.match(result.answer, /BỘ PEERLESS/);
  assert.deepEqual(result.provenance.evidence[0], { source: paymentResult.source, source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 's1', semantic_version: 'bmq-supplier-payment-v1', mode: 'warehouse' });
});

test('unsupported qualifiers cause zero warehouse and zero model calls', async () => {
  const paths: string[] = [];
  const result = await runWarehouse({ ...input, question: 'T9 đã thanh toán ngày 15 cho TV Food' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    paths.push(path);
    return paymentResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.deepEqual(paths, []);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(result.provenance.modelCalls, 0);
  assert.match(result.answer, /không được mở rộng/);
});

test('missing month clarifies before any warehouse payment read', async () => {
  let payments = 0;
  const result = await runWarehouse({ ...input, question: 'Đã thanh toán bao nhiêu cho TV Food' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    payments++;
    return paymentResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.equal(payments, 0);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /tháng/);
});

test('warehouse without the payment catalog abstains instead of answering a payment total', async () => {
  const legacy = { metrics: catalog.metrics, dimensions: catalog.dimensions, version: 'x', cost_lookup: catalog.cost_lookup };
  let payments = 0;
  const plan = { lane: 'payment', queries: [], search: '', clarification: '', payment_lookup: { kind: 'supplier_payments', month: '2026-09' } };
  const result = await runWarehouse(input, async (path) => {
    if (path === '/v1/semantic') return legacy;
    payments++;
    return paymentResult;
  }, async () => ({ value: plan, usage }), signal);
  assert.equal(payments, 0);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /chưa có hợp đồng thanh toán/);
});

test('a planner-proposed payment plan cannot answer a non-payment question', async () => {
  const plan = { lane: 'payment', queries: [], search: '', clarification: '', payment_lookup: { kind: 'supplier_payments', month: '2026-09', supplier: 'tv food', item: '', limit: null } };
  let payments = 0;
  const result = await runWarehouse({ ...input, question: 'Công nợ nhà cung cấp TV Food tháng 9/2026' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    payments++;
    return paymentResult;
  }, async () => ({ value: plan, usage }), signal);
  assert.equal(payments, 0);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /không phải tra cứu thanh toán/);
});

test('planner payment lookup is validated and unknown fields are rejected', async () => {
  const plan = { lane: 'payment', queries: [], search: '', clarification: '', payment_lookup: { kind: 'supplier_payments', month: '2026-09', tenant: 'other' } };
  await assert.rejects(() => runWarehouse(input, async (path) => path === '/v1/semantic' ? catalog : paymentResult,
    async () => ({ value: plan, usage }), signal), (error: unknown) => error instanceof AnalyticsError && error.code === 'invalid_plan');
});

test('paymentAnswer renders the supplier total distinctly from the unavailable item amount', () => {
  const vi = paymentAnswer(paymentResult, 'vi');
  assert.match(vi, /Tổng đã thanh toán/);
  assert.match(vi, /13\.500\.000/);
  assert.match(vi, /PAY-000156/);
  assert.match(vi, /10\/09\/2026/);
  assert.match(vi, /không xác định được/);
  assert.match(vi, /Bơ/);
  assert.match(vi, /không chia tỷ lệ/);
  assert.match(vi, /BỘ PEERLESS/);
  assert.match(vi, /Dữ liệu đồng bộ lúc: 2026-09-16T21:37:45Z/);
  assert.match(vi, /payments\.payment_date/);
  const en = paymentAnswer(paymentResult, 'en');
  assert.match(en, /13,500,000 VND/);
  assert.match(en, /not determinable/);
  assert.throws(() => paymentAnswer({ ...paymentResult, semantic_version: undefined }, 'vi'), (error: unknown) => error instanceof AnalyticsError);
});

test('paymentAnswer is exact when every allocation resolves, and honest when nothing is recorded', () => {
  const exact = { ...paymentResult, item_status: 'exact', item_amount: '1000000', total_amount: '1000000', direct_total: '1000000',
    payments: [{ payment_number: 'PAY-000157', payment_date: '2026-08-31', amount: '1000000', attributed_amount: '1000000', payment_method: 'cash', shared: false }], month: '2026-08' };
  const answer = paymentAnswer(exact, 'vi');
  assert.match(answer, /Giá trị theo mặt hàng/);
  assert.match(answer, /1\.000\.000/);
  assert.match(answer, /số khác/);
  const empty = { ...paymentResult, total_amount: '0', direct_total: '0', payments: [], payment_count: 0, item: null, item_status: 'not_requested', item_amount: null };
  assert.match(paymentAnswer(empty, 'vi'), /không đồng nghĩa/);
});

test('paymentAnswer shows unlinked candidate lines for an unmatched item without inventing identity', () => {
  const notFoundItem = { ...paymentResult, item: { term: 'duong', mode: null, product_name: null, material: null },
    item_candidates: [], item_status: 'not_found', item_amount: null, unresolved_item_count: 1, candidate_items: ['BỘ PEERLESS'] };
  const answer = paymentAnswer(notFoundItem, 'vi');
  assert.match(answer, /Không tìm thấy vật tư/);
  assert.match(answer, /BỘ PEERLESS/);
  assert.match(answer, /13\.500\.000/);
  assert.doesNotMatch(answer, /Giá trị theo mặt hàng/);
});

test('paymentAnswer clarifies an ambiguous or unknown supplier without a substitute total', () => {
  const ambiguous = { ...paymentResult, supplier_status: 'ambiguous', supplier: null,
    supplier_candidates: [{ id: 'a', name: 'TV Food', short_code: 'TVF' }, { id: 'b', name: 'TV Food Miền Nam', short_code: 'TVF2' }] };
  const answer = paymentAnswer(ambiguous, 'vi');
  assert.match(answer, /khớp 2 nhà cung cấp/);
  assert.doesNotMatch(answer, /Tổng đã thanh toán/);
  const notFound = { ...paymentResult, supplier_status: 'not_found', supplier: null, supplier_candidates: [] };
  assert.match(paymentAnswer(notFound, 'vi'), /Không tìm thấy nhà cung cấp/);
  assert.doesNotMatch(paymentAnswer(notFound, 'vi'), /Tổng đã thanh toán/);
});

// ── Purchase-cost / spend regression (production screenshot 4462) ──────────────
// "Chi phí T9 để mua bơ?" and "Chi phí mua bơ trong tháng 9" must NOT fall into the
// cost-classification generic clarification. No read-only purchase-cost contract
// exists, so they must NOT return an actual-payment total either (even with a
// disclaimer): they clarify with the interpreted item and month retained. Explicit
// payment wording keeps the existing payment flow.
const PURCHASE_PROMPTS = ['Chi phí T9 để mua bơ?', 'Chi phí mua bơ trong tháng 9'];

test('purchase-cost butter prompts clarify with item+month instead of substituting a payment total', () => {
  for (const question of PURCHASE_PROMPTS) {
    assert.equal(costDetect(question, TODAY), null, question);
    assert.equal(purchaseCuePresent(question), true, question);
    const route = paymentDetect(question, TODAY);
    assert.equal(route?.lane, 'clarify', question);
    assert.match(String((route as any).message), /chi phí mua hàng/, question);
    assert.match(String((route as any).message), /bo/i, question);
    assert.match(String((route as any).message), /2026-09/, question);
    assert.notEqual(route?.lane, 'payment', question);
  }
  // The generic cost classification clarification must never be produced for them.
  const generic = 'Anh nêu rõ câu hỏi phân loại chi phí theo tháng, nhóm, trạng thái duyệt hoặc mã dòng cụ thể nhé.';
  for (const question of PURCHASE_PROMPTS) assert.notEqual((costDetect(question, TODAY) as any)?.message, generic);
});

test('purchase-cost detection keeps an explicit item and never drops a month', () => {
  for (const question of ['Chi phí mua bơ cho TV Food trong tháng 9', 'Chi phí mua bơ tháng 9 cho TV Food', 'Chi phí T9 để mua bơ?']) {
    const route = paymentDetect(question, TODAY);
    assert.equal(route?.lane, 'clarify', question);
    assert.match(String((route as any).message), /bo/i, question);
    assert.match(String((route as any).message), /2026-09/, question);
  }
  // A purchase-cost question with no month still asks for one.
  const noMonth = paymentDetect('Chi phí mua bơ', TODAY);
  assert.equal(noMonth?.lane, 'clarify');
  assert.match(String((noMonth as any).message), /tháng/);
  // Generic "mua hàng" with no item clarifies for the item instead of returning a total.
  const genericGoods = paymentDetect('chi phí mua hàng tháng 9/2026', TODAY);
  assert.equal(genericGoods?.lane, 'clarify');
  assert.match(String((genericGoods as any).message), /mặt hàng/);
});

test('purchase-cost questions never mix in cost-classification semantics', () => {
  // A pure classification question is still claimed by the cost lane.
  assert.deepEqual(costDetect('Chi phí phân loại tháng 9/2026', TODAY),
    { lane: 'cost', lookup: { kind: 'month_totals', month: '2026-09', category_code: undefined } });
  assert.equal(paymentDetect('Chi phí phân loại tháng 9/2026', TODAY), null);
  // A question that mixes both meanings abstains rather than silently picking one.
  const mixed = paymentDetect('Chi phí mua bơ theo nhóm tháng 9', TODAY);
  assert.equal(mixed?.lane, 'abstain');
  assert.match(String((mixed as any).message), /phân loại chi phí/);
  // A supplier-debt question still cannot open the payment lane.
  assert.equal(paymentDetect('Công nợ nhà cung cấp TV Food tháng 9/2026', TODAY), null);
});

test('purchase-cost prompts make zero warehouse reads and are not answered as payments', async () => {
  for (const question of PURCHASE_PROMPTS) {
    const calls: any[] = [];
    const result = await runWarehouse({ ...input, question }, async (path, body) => {
      if (path === '/v1/semantic') return catalog;
      calls.push({ path, body });
      return paymentResult;
    }, async () => { throw new Error('no model'); }, signal);
    assert.deepEqual(calls, [], question);
    assert.equal(result.provenance.lane, 'abstain', question);
    assert.equal(result.provenance.modelCalls, 0, question);
    // Retains the interpreted item and month; never states a payment total.
    assert.match(result.answer, /bo/i, question);
    assert.match(result.answer, /2026-09/, question);
    assert.doesNotMatch(result.answer, /Tổng đã thanh toán/, question);
    assert.doesNotMatch(result.answer, /Tổng chi phí/, question);
  }
});

test('purchase-cost prompt without an item makes zero warehouse payment reads', async () => {
  const paths: string[] = [];
  const result = await runWarehouse({ ...input, question: 'chi phí mua hàng tháng 9/2026' }, async (path) => {
    if (path === '/v1/semantic') return catalog;
    paths.push(path);
    return paymentResult;
  }, async () => { throw new Error('no model'); }, signal);
  assert.deepEqual(paths, []);
  assert.equal(result.provenance.lane, 'abstain');
  assert.match(result.answer, /mặt hàng/);
});

test('fixed client whitelist allows the read-only payment endpoint and still rejects arbitrary paths', async () => {
  const call = warehouseClient('https://warehouse.test', 'Bearer fake', signal, async (url) => {
    assert.equal(String(url), 'https://warehouse.test/v1/payment');
    return new Response(JSON.stringify(paymentResult));
  });
  await call('/v1/payment', { question: 'supplier_payments', month: '2026-09' });
  await assert.rejects(() => call('/v1/payment-raw', {}));
});
