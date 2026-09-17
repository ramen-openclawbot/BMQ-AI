// End-to-end createHandler tests: fixture auth (never a fake owner token that
// bypasses the real flow) + a scripted warehouse HTTP contract, so the whole
// handler -> runWarehouse -> warehouseClient path is exercised, including the
// audit event shape and the actual JSON bodies sent to /v1/cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './handler.ts';
import { AnalyticsError } from './core.ts';
import { COST_KINDS } from './cost.ts';

const SECRET = 'handler-fixture-signing-secret-0123456789abcdef';
const USER = 'owner-fixture';
const CONV = 'conv-handler-0001';
const page = { route: '/finance-control/classification', label: 'Phân loại chi phí' };
const usage = { input: 1, output: 1, cached: 0 };

const RULES = { rule1: { rule_name: 'BMQ bread keywords', match_scope: 'supplier_and_item', priority: '100', confidence: '0.90', effective_from: '2026-01-01', effective_to: null } };
const LINES = [
  { classification_id: 'c1', month: '2026-09-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'suggested', supplier_name: 'NCC Một', source_number: 'PR-001', source_date: '2026-09-10', product_name: 'Bánh mì que', line_amount: '10000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.90' },
  { classification_id: 'c2', month: '2026-09-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'needs_review', supplier_name: 'NCC Hai', source_number: 'PR-002', source_date: '2026-09-12', product_name: 'Pate gan', line_amount: '8000000', classification_source: 'fallback', rule_id: null, confidence: '0' },
  { classification_id: 'c3', month: '2026-09-01', category_code: 'OPEX_GENERAL', category_label: 'Chi phí vận hành chung', review_status: 'approved', supplier_name: 'NCC Ba', source_number: 'PR-003', source_date: '2026-09-08', product_name: 'Tiền điện', line_amount: '5000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.88' },
];
const CATALOG = {
  metrics: { dealer_order_count: { label: 'Dealer count', unit: 'count' } }, dimensions: { date: 'date' }, version: 'x',
  cost_lookup: { version: 'bmq-cost-classification-v2', questions: COST_KINDS.map((id) => ({ id })) },
};

// Global-fetch stub: scripts the warehouse HTTP contract and records the bodies.
function warehouseFetch(requests: any[]) {
  return async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/semantic') return json(CATALOG);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, body, authorization: init.headers?.Authorization });
    assert.equal(url.pathname, '/v1/cost');
    const provenance = { source: 'Supabase.cost_classification_line_details', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 'snap-1', semantic_version: 'bmq-cost-classification-v2' };
    const filter = (line: any) => (!body.month || line.month.slice(0, 7) === body.month)
      && (!body.category_code || line.category_code === body.category_code)
      && (!body.review_status || line.review_status === body.review_status);
    if (body.question === 'example_line') {
      const matched = LINES.filter(filter).sort((a, b) => Number(b.line_amount) - Number(a.line_amount));
      return json({ ...provenance, question: 'example_line', month: body.month, category_code: body.category_code ?? null, review_status: body.review_status ?? null, match_count: matched.length, rows: matched.slice(0, body.limit ?? 1), limit: body.limit ?? 1, truncated: matched.length > (body.limit ?? 1), selection_rule: 'largest_line_amount_then_source_date_then_classification_id' });
    }
    if (body.question === 'line_explanation') {
      const line = LINES.find((entry) => entry.classification_id === body.line_ref);
      if (!line) return json({ ...provenance, question: 'line_explanation', status: 'not_found', line_ref: body.line_ref });
      return json({ ...provenance, question: 'line_explanation', status: 'ok', line_ref: body.line_ref, line, evidence: { rule: line.rule_id ? RULES.rule1 : null, alias_mapping: null, alias_status: null } });
    }
    const month = LINES.filter((line) => line.month.slice(0, 7) === body.month);
    const matched = body.question === 'pending_summary' ? month.filter((line) => line.review_status === 'needs_review') : month.filter(filter);
    const statuses = ['needs_review', 'suggested', 'approved', 'rejected'].map((status) => {
      const rows = month.filter((line) => line.review_status === status);
      return { review_status: status, line_count: rows.length, total_amount: String(rows.reduce((sum, line) => sum + Number(line.line_amount), 0)) };
    });
    return json({ ...provenance, question: body.question, month: body.month, category_code: body.category_code ?? null, review_status: body.review_status ?? null, rows: [], statuses, line_count: matched.length, total_amount: String(matched.reduce((sum, line) => sum + Number(line.line_amount), 0)) });
  };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

function makeHandler(overrides: { contextEnabled?: boolean; authenticate?: any; model?: any; requests?: any[]; audit?: any[] } = {}) {
  const requests = overrides.requests ?? [];
  const audit = overrides.audit ?? [];
  const handler = createHandler({
    enabled: () => true,
    warehouse: { enabled: () => true, url: () => 'https://warehouse.example/' },
    context: { enabled: () => overrides.contextEnabled !== false },
    model: overrides.model ?? (async () => { throw new Error('model must not be called on the deterministic cost path'); }),
    authenticate: overrides.authenticate ?? (async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer fixture-owner') throw new AnalyticsError('unauthorized', 401);
      return { scope: { tenant: 'tenant-fixture', user: USER, permission: 'owner:rls:v1' }, signingSecret: SECRET, query: async () => { throw new Error('live query not used'); } };
    }),
    audit: (event) => audit.push(event),
  });
  return { handler, requests, audit };
}

function post(handler: any, body: unknown, authorization = 'Bearer fixture-owner') {
  return handler(new Request('https://ai.banhmique.vn/functions/v1/bmq-analytics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body),
  }));
}

test('end-to-end: fixture auth -> pending -> example -> why keeps the signed conversation state', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests });
    const first = await (await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', conversationId: CONV, page, history: [] })).json();
    assert.equal(first.provenance.lane, 'cost');
    assert.ok(first.provenance.costContext, 'the handler must return the signed state');
    assert.match(first.provenance.costContext.sig, /^[a-f0-9]{64}$/);
    assert.equal(requests.filter((r) => r.path === '/v1/cost').length, 1);

    const example = await (await post(handler, {
      language: 'vi', question: 'Lấy một dòng làm ví dụ', conversationId: CONV, page,
      history: [{ role: 'user', text: 'x' }, { role: 'assistant', text: first.answer, costContext: first.provenance.costContext }],
    })).json();
    assert.equal(example.provenance.lane, 'cost');
    assert.match(example.answer, /c2/);
    const costCalls = requests.filter((r) => r.path === '/v1/cost');
    assert.equal(costCalls.at(-2).body.question, 'example_line');
    assert.equal(costCalls.at(-1).body.question, 'line_explanation');
    assert.equal(costCalls.at(-1).body.line_ref, 'c2');
    assert.equal(example.provenance.queries.length, 2);

    const why = await (await post(handler, {
      language: 'vi', question: 'Vì sao dòng này?', conversationId: CONV, page,
      history: [{ role: 'assistant', text: example.answer, costContext: example.provenance.costContext }],
    })).json();
    assert.equal(why.provenance.lane, 'cost');
    assert.match(why.answer, /c2/);
  } finally { globalThis.fetch = originalFetch; }
});

test('warehouse contract probe: pending_summary and example bodies send only accepted qualifiers', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests });
    const first = await (await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', conversationId: CONV, page, history: [] })).json();
    const pending = requests.find((r) => r.body?.question === 'pending_summary');
    assert.ok(pending, 'pending_summary must be requested');
    assert.deepEqual(Object.keys(pending.body).sort(), ['month', 'question']);
    assert.equal(pending.body.month, '2026-09');
    assert.equal(pending.authorization, 'Bearer fixture-owner');

    // An all-status example follow-up must not carry an inherited status.
    const example = await (await post(handler, {
      language: 'vi', question: 'Lấy một dòng ví dụ trong tất cả nhóm, tất cả trạng thái', conversationId: CONV, page,
      history: [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }],
    })).json();
    assert.equal(example.provenance.lane, 'cost');
    const exampleBody = requests.find((r) => r.body?.question === 'example_line')?.body;
    assert.ok(exampleBody);
    // Only accepted qualifiers: no inherited category/status, no invented limit
    // (the warehouse defaults example_line limit to 1).
    assert.deepEqual(Object.keys(exampleBody).sort(), ['month', 'question']);
    assert.equal(exampleBody.month, '2026-09');
  } finally { globalThis.fetch = originalFetch; }
});

test('auth is required before any warehouse call and audit never logs the secret or question', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  const audit: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests, audit });
    const unauthorized = await post(handler, { language: 'vi', question: 'x', conversationId: CONV, page, history: [] }, 'Bearer wrong');
    assert.equal(unauthorized.status, 401);
    assert.equal(requests.length, 0, 'no warehouse call before authentication');

    await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', conversationId: CONV, page, history: [] });
    const logged = JSON.stringify(audit);
    assert.ok(!logged.includes(SECRET), 'signing secret must never be logged');
    assert.ok(!logged.includes('cần review'), 'raw question text must never be logged');
    assert.ok(audit.some((event) => event.event === 'bmq_analytics' && event.context?.lane === 'cost'));
  } finally { globalThis.fetch = originalFetch; }
});

test('a mismatched conversation id cannot reuse signed state from another conversation', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests, model: async () => ({ value: { lane: 'abstain', queries: [], search: '', clarification: 'Anh nêu rõ phạm vi cần tra nhé.' }, usage }) });
    const first = await (await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', conversationId: CONV, page, history: [] })).json();
    const costCallsBefore = requests.filter((r) => r.path === '/v1/cost').length;
    const mismatch = await (await post(handler, {
      language: 'vi', question: 'Lấy một dòng làm ví dụ', conversationId: 'conv-other-0002', page,
      history: [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }],
    })).json();
    assert.equal(mismatch.provenance.lane, 'abstain');
    assert.equal(mismatch.provenance.costContext, undefined);
    assert.equal(requests.filter((r) => r.path === '/v1/cost').length, costCallsBefore, 'no cost read from mismatched state');
  } finally { globalThis.fetch = originalFetch; }
});

test('context flag off preserves the old flow and never returns state', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests, contextEnabled: false, model: async () => ({ value: { lane: 'abstain', queries: [], search: '', clarification: 'Anh nêu rõ phạm vi cần tra nhé.' }, usage }) });
    const result = await (await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', conversationId: CONV, page, history: [] })).json();
    assert.equal(result.provenance.costContext, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('round 3: after a cost answer an unrelated UNC/knowledge question reaches the planner; a real cost filter still abstains', async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  const audit: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const model = async () => ({ value: { lane: 'abstain', queries: [], search: '', clarification: 'Anh nêu rõ phạm vi cần tra nhé.' }, usage });
    const { handler } = makeHandler({ requests, audit, model });
    const first = await (await post(handler, { language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', conversationId: CONV, page, history: [] })).json();
    assert.equal(first.provenance.lane, 'cost');
    const history = [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }];

    for (const question of ['cho xem ảnh UNC ngân hàng ngày 12/9/2026', 'tài liệu hướng dẫn theo phòng ban']) {
      const costCallsBefore = requests.filter((r) => r.path === '/v1/cost').length;
      const result = await (await post(handler, { language: 'vi', question, conversationId: CONV, page, history })).json();
      assert.equal(result.provenance.lane, 'abstain', question);
      assert.equal(result.provenance.modelCalls, 1, `${question} must reach the normal planner, not the cost rule`);
      assert.equal(result.provenance.costContext, undefined, `${question} must not issue cost state`);
      assert.equal(requests.filter((r) => r.path === '/v1/cost').length, costCallsBefore, `${question} must not read cost data`);
      assert.equal(audit.at(-1).context, null, `${question} must audit no cost context`);
    }

    // A genuine cost follow-up with an unsupported employee filter still abstains
    // deterministically: no model call and no cost read.
    const costCallsBefore = requests.filter((r) => r.path === '/v1/cost').length;
    const blocked = await (await post(handler, { language: 'vi', question: 'Lấy một dòng làm ví dụ theo nhân viên', conversationId: CONV, page, history })).json();
    assert.equal(blocked.provenance.lane, 'abstain');
    assert.equal(blocked.provenance.modelCalls, 0);
    assert.equal(requests.filter((r) => r.path === '/v1/cost').length, costCallsBefore);
    assert.equal(blocked.provenance.costContext, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('round 4: a fully explicit first-turn example reaches the warehouse as example_line; flag off keeps the aggregate path', async () => {
  const originalFetch = globalThis.fetch;
  const question = 'Lấy một dòng chi phí tháng 9/2026 đã duyệt làm ví dụ';

  const requests: any[] = [];
  globalThis.fetch = warehouseFetch(requests) as any;
  try {
    const { handler } = makeHandler({ requests });
    const enabled = await (await post(handler, { language: 'vi', question, conversationId: CONV, page, history: [] })).json();
    assert.equal(enabled.provenance.lane, 'cost');
    assert.equal(enabled.provenance.queries[0].question, 'example_line');
    assert.deepEqual(requests.find((r) => r.body?.question === 'example_line')?.body, { question: 'example_line', month: '2026-09', review_status: 'approved' });
  } finally { globalThis.fetch = originalFetch; }

  const requestsOff: any[] = [];
  globalThis.fetch = warehouseFetch(requestsOff) as any;
  try {
    const { handler } = makeHandler({ requests: requestsOff, contextEnabled: false });
    const off = await (await post(handler, { language: 'vi', question, conversationId: CONV, page, history: [] })).json();
    assert.equal(off.provenance.lane, 'cost');
    assert.equal(off.provenance.queries[0].question, 'month_totals');
    assert.equal(requestsOff.some((r) => r.body?.question === 'example_line'), false, 'the flag-off path must never resolve an example');
    assert.deepEqual(requestsOff.filter((r) => r.path === '/v1/cost').map((r) => r.body.question), ['month_totals']);
  } finally { globalThis.fetch = originalFetch; }
});
