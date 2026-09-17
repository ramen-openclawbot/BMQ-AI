import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWarehouse } from './warehouse.ts';
import {
  COST_CONTEXT_TTL_MS, COST_ROUTE_FILTER_WHITELIST, createCostContext, readCostContext, previousMonth,
  isExampleRequest, isThisLineRequest, isPreviousMonthRequest, costFollowUp, resolveRouteFilter, routeCostScope, validMonth,
} from './context.ts';
import { COST_KINDS } from './cost.ts';

const signal = new AbortController().signal;
const usage = { input: 1, output: 1, cached: 0 };
const NOW = Date.parse('2026-09-17T03:00:00Z');
// Dedicated fixture secret (>= 32 chars). Never a bearer token or real secret.
const SECRET = 'unit-fixture-signing-secret-0123456789abcdef';
const OTHER_SECRET = 'unit-fixture-other-secret-0123456789abcdef';
const USER = 'owner-1';
const CONV = 'conv-unit-0001';
const options = { contextEnabled: true, signingSecret: SECRET, userId: USER, now: NOW };
const page = { route: '/finance-control/classification', label: 'Phân loại chi phí' };
const enCatalog = {
  metrics: { dealer_order_count: { label: 'Dealer count', unit: 'count' } },
  dimensions: { date: 'date' }, version: 'x',
  cost_lookup: { version: 'bmq-cost-classification-v2', questions: COST_KINDS.map((id) => ({ id })) },
};

const RULES = {
  rule1: { rule_name: 'BMQ bread keywords', match_scope: 'supplier_and_item', priority: '100', confidence: '0.90', effective_from: '2026-01-01', effective_to: null },
};

const SEPT = [
  { classification_id: 'c1', month: '2026-09-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'suggested', supplier_name: 'NCC Một', source_number: 'PR-001', source_date: '2026-09-10', product_name: 'Bánh mì que', line_amount: '10000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.90' },
  { classification_id: 'c2', month: '2026-09-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'needs_review', supplier_name: 'NCC Hai', source_number: 'PR-002', source_date: '2026-09-12', product_name: 'Pate gan', line_amount: '8000000', classification_source: 'fallback', rule_id: null, confidence: '0' },
  { classification_id: 'c3', month: '2026-09-01', category_code: 'OPEX_GENERAL', category_label: 'Chi phí vận hành chung', review_status: 'approved', supplier_name: 'NCC Ba', source_number: 'PR-003', source_date: '2026-09-08', product_name: 'Tiền điện', line_amount: '5000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.88' },
];
const AUGUST = [
  { classification_id: 'a1', month: '2026-08-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'needs_review', supplier_name: 'NCC Một', source_number: 'PR-101', source_date: '2026-08-20', product_name: 'Bánh mì que', line_amount: '3000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.90' },
];
const APRIL = [
  { classification_id: 'x1', month: '2026-04-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'approved', supplier_name: 'NCC Bốn', source_number: 'PR-401', source_date: '2026-04-11', product_name: 'Bánh mì April', line_amount: '4000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.90' },
];

// Minimal stateful warehouse fixture over a synthetic canonical view. The real
// SQL/parity is covered by the Python suite; this fixture exercises the Edge
// orchestration (routing, two-step reads, scope/snapshot recheck, state).
function fixture(lines: any[], snapshotId = 'snap-1', overrides: { explanationSnapshot?: string } = {}) {
  const parse = (amount: unknown) => Number(amount);
  const filter = (request: any) => lines.filter((line) => {
    if (request.month && line.month.slice(0, 7) !== request.month) return false;
    if (request.month_b && line.month.slice(0, 7) !== request.month_b) return false;
    if (request.category_code && line.category_code !== request.category_code) return false;
    if (request.review_status && line.review_status !== request.review_status) return false;
    return true;
  });
  const provenance = { source: 'Supabase.cost_classification_line_details', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: snapshotId, semantic_version: 'bmq-cost-classification-v2' };
  const ordered = (rows: any[]) => [...rows].sort((a, b) => parse(b.line_amount) - parse(a.line_amount)
    || String(b.source_date).localeCompare(String(a.source_date)) || String(a.classification_id).localeCompare(String(b.classification_id)));
  return async (path: string, request: any) => {
    if (path === '/v1/semantic') return enCatalog;
    assert.equal(path, '/v1/cost', `unexpected warehouse path ${path}`);
    if (request.question === 'example_line') {
      const matched = ordered(filter(request).filter((line) => line.month.slice(0, 7) === request.month));
      return { ...provenance, question: 'example_line', month: request.month, category_code: request.category_code ?? null, review_status: request.review_status ?? null, match_count: matched.length, rows: matched.slice(0, request.limit ?? 1), limit: request.limit ?? 1, truncated: matched.length > (request.limit ?? 1), selection_rule: 'largest_line_amount_then_source_date_then_classification_id' };
    }
    if (request.question === 'line_explanation') {
      const exact = lines.filter((line) => line.classification_id === request.line_ref);
      if (!exact.length) return { ...provenance, question: 'line_explanation', status: 'not_found', line_ref: request.line_ref };
      const line = exact[0];
      const snapshot = overrides.explanationSnapshot ?? snapshotId;
      return { ...provenance, snapshot_id: snapshot, question: 'line_explanation', status: 'ok', line_ref: request.line_ref, line, evidence: { rule: line.rule_id ? RULES[line.rule_id as keyof typeof RULES] : null, alias_mapping: null, alias_status: null } };
    }
    // month_totals / pending_summary
    const month = lines.filter((line) => line.month.slice(0, 7) === request.month);
    const matched = request.question === 'pending_summary'
      ? month.filter((line) => line.review_status === 'needs_review')
      : filter(request);
    const statuses = ['needs_review', 'suggested', 'approved', 'rejected'].map((status) => {
      const rows = month.filter((line) => line.review_status === status);
      return { review_status: status, line_count: rows.length, total_amount: String(rows.reduce((sum, line) => sum + parse(line.line_amount), 0)) };
    });
    return { ...provenance, question: request.question, month: request.month, category_code: request.category_code ?? null, review_status: request.review_status ?? null, rows: [], statuses, line_count: matched.length, total_amount: String(matched.reduce((sum, line) => sum + parse(line.line_amount), 0)) };
  };
}

const abstainModel = async () => ({ value: { lane: 'abstain', queries: [], search: '', clarification: 'Anh nêu rõ phạm vi cần tra nhé.' }, usage });
const explodeModel = async () => { throw new Error('model must not be called on the deterministic context path'); };

const turn = async (question: string, history: any[], call: any = fixture([...SEPT, ...AUGUST]), opts: any = options, model: any = explodeModel, conversationId: string | undefined = CONV) =>
  runWarehouse({ language: 'vi', question, conversationId, page, history }, call, model, signal, undefined, opts);

test('original complaint: scope -> example line -> why this line -> previous month, all deterministic and stateful', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', []);
  assert.equal(first.provenance.lane, 'cost');
  assert.equal(first.provenance.modelCalls, 0);
  const ctx1 = first.provenance.costContext;
  assert.ok(ctx1, 'first cost answer must issue bounded conversation state');
  assert.deepEqual([ctx1.scope.kind, ctx1.scope.month, ctx1.scope.review_status], ['pending_summary', '2026-09', 'needs_review']);

  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'user', text: 'x' }, { role: 'assistant', text: first.answer, costContext: ctx1 }]);
  assert.equal(example.provenance.lane, 'cost');
  assert.equal(example.provenance.modelCalls, 0);
  assert.match(example.answer, /Quy tắc chọn/);
  assert.match(example.answer, /Dòng chi phí ví dụ/);
  assert.match(example.answer, /c2/);
  assert.match(example.answer, /8\.000\.000/);
  const ctx2 = example.provenance.costContext;
  assert.equal(ctx2.scope.kind, 'pending_summary', 'the aggregate intent is preserved across the example turn');
  assert.equal(ctx2.scope.month, '2026-09');
  assert.equal(ctx2.scope.review_status, 'needs_review');
  assert.equal(ctx2.selection.line_ref, 'c2');

  const why = await turn('Vì sao dòng này?', [{ role: 'user', text: 'x' }, { role: 'assistant', text: example.answer, costContext: ctx2 }]);
  assert.equal(why.provenance.lane, 'cost');
  assert.equal(why.provenance.modelCalls, 0);
  assert.match(why.answer, /c2/);
  assert.match(why.answer, /lý do lịch sử không có sẵn/);
  assert.equal(why.provenance.costContext.selection.line_ref, 'c2');

  const previous = await turn('Còn tháng trước?', [{ role: 'user', text: 'x' }, { role: 'assistant', text: why.answer, costContext: why.provenance.costContext }]);
  assert.equal(previous.provenance.lane, 'cost');
  assert.equal(previous.provenance.modelCalls, 0);
  assert.match(previous.answer, /08\/2026/);
  assert.equal(previous.provenance.costContext.scope.month, '2026-08');
  assert.equal(previous.provenance.costContext.scope.kind, 'pending_summary');
  assert.equal(previous.provenance.costContext.selection, undefined, 'scope change must invalidate the selected row');
});

test('cost business block is bound to the exact shown row and a follow-up reads only the immediately preceding card', async () => {
  const call = fixture([...SEPT, ...AUGUST]);
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', [], call);
  // Aggregate answers never carry a single-line card.
  assert.equal(first.provenance.costBlock, undefined);
  const ctx1 = first.provenance.costContext;

  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: ctx1 }], call);
  const block = example.provenance.costBlock;
  assert.ok(block, 'an example line must publish a validated business block');
  assert.equal(block.mode, 'example');
  assert.equal(block.line.classificationId, 'c2');
  assert.equal(block.line.amount, 8000000);
  assert.equal(block.line.supplierName, 'NCC Hai');
  assert.equal(block.line.sourceDate, '2026-09-12');
  assert.equal(block.line.reviewStatus, 'needs_review');
  assert.equal(block.followUp, 'line_explanation');
  // The card and the signed state must name the same row.
  assert.equal(example.provenance.costContext.selection.line_ref, block.line.classificationId);
  const notes = block.notes.join(' ');
  assert.match(notes, /lý do lịch sử không có sẵn/);
  assert.doesNotMatch(notes, /NCC Hai|Pate gan|8\.000\.000/);

  // The resolver reads only the immediately preceding assistant turn. An older
  // card's signed state therefore cannot be replayed: the newest selection wins,
  // which is exactly why the widget disables every non-latest card.
  const stale = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' }, selection: { line_ref: 'c1', classification_id: 'c1' }, now: NOW });
  const why = await turn('Vì sao dòng này?', [
    { role: 'assistant', text: 'old card', costContext: stale },
    { role: 'user', text: 'x' },
    { role: 'assistant', text: example.answer, costContext: example.provenance.costContext },
  ], call);
  assert.equal(why.provenance.lane, 'cost');
  assert.equal(why.provenance.costBlock.mode, 'explanation');
  assert.equal(why.provenance.costBlock.line.classificationId, 'c2');
  assert.equal(why.provenance.costContext.selection.line_ref, 'c2');
});

test('explicit new scope wins and drops the remembered selection', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const ctx1 = first.provenance.costContext;
  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: ctx1 }]);
  const ctx2 = example.provenance.costContext;
  assert.ok(ctx2.selection);
  const changed = await turn('Chi phí bánh mì tháng 8/2026 đã duyệt', [{ role: 'assistant', text: example.answer, costContext: ctx2 }], fixture([...SEPT, ...AUGUST]), options, abstainModel);
  assert.equal(changed.provenance.lane, 'cost');
  assert.equal(changed.provenance.costContext.scope.month, '2026-08');
  assert.equal(changed.provenance.costContext.scope.category_code, 'COGS_BMQ_BREAD');
  assert.equal(changed.provenance.costContext.scope.review_status, 'approved');
  assert.equal(changed.provenance.costContext.selection, undefined);
});

test('example line with no matching scope fails honestly and never invents a row', async () => {
  const empty = await turn('Chi phí bánh mì tháng 8/2026 đã duyệt', [], fixture([...SEPT, ...AUGUST]));
  const ctx = empty.provenance.costContext;
  assert.equal(ctx.scope.review_status, 'approved');
  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: empty.answer, costContext: ctx }]);
  assert.equal(example.provenance.lane, 'cost');
  assert.match(example.answer, /Không có dòng chi phí nào khớp phạm vi này/);
  assert.equal(example.provenance.costContext.selection, undefined);
});

test('selected line is rechecked against the current scope and snapshot before evidence is shown', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const ctx1 = first.provenance.costContext;
  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: ctx1 }]);
  const ctx2 = example.provenance.costContext;
  // Refresh: c2 was approved in the new snapshot, so it no longer belongs to the needs_review scope.
  const refreshed = SEPT.map((line) => line.classification_id === 'c2' ? { ...line, review_status: 'approved' } : line);
  const why = await turn('Vì sao dòng này?', [{ role: 'assistant', text: example.answer, costContext: ctx2 }], fixture([...refreshed, ...AUGUST], 'snap-2'));
  assert.equal(why.provenance.lane, 'abstain');
  assert.match(why.answer, /không còn nằm trong phạm vi/);
  assert.equal(why.provenance.costContext, undefined, 'a refused recheck must not repopulate context');
});

test('missing line evidence is reported as unavailable, never invented', async () => {
  const first = await turn('Chi phí tháng 9/2026 theo từng nhóm', [], fixture([...SEPT, ...AUGUST]));
  const ctx = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'month_totals', month: '2026-09', category_code: null, review_status: null }, selection: { line_ref: 'missing', classification_id: 'missing' }, now: NOW });
  const why = await turn('Vì sao dòng này?', [{ role: 'assistant', text: first.answer, costContext: ctx }], fixture([...SEPT, ...AUGUST]));
  assert.equal(why.provenance.lane, 'cost');
  assert.match(why.answer, /Không tìm thấy dòng phân loại/);
  assert.equal(why.provenance.costContext, undefined);
});

test('flags off keeps the old flow: an example follow-up is not resolved from state', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const ctx1 = first.provenance.costContext;
  const off = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: ctx1 }], fixture([...SEPT, ...AUGUST]), { ...options, contextEnabled: false }, abstainModel);
  assert.equal(off.provenance.lane, 'abstain');
  assert.equal(off.provenance.modelCalls, 1);
  assert.equal(off.provenance.costContext, undefined);
});

test('unsupported qualifier on an example request abstains without a numeric read', async () => {
  let costReads = 0;
  const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', [], call);
  const ctx1 = first.provenance.costContext;
  costReads = 0;
  const result = await turn('Lấy một dòng làm ví dụ theo nhân viên', [{ role: 'assistant', text: first.answer, costContext: ctx1 }], call);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(costReads, 0);
});

test('expired, tampered, cross-user and cross-conversation state is never used', async () => {
  const scope = { kind: 'pending_summary' as const, month: '2026-09', category_code: null, review_status: 'needs_review' as const };
  const fresh = await createCostContext({ userId: USER, secret: SECRET, conversationId: 'conv-a-0001', snap: 'snap-1', scope, now: NOW });
  const read = (ctx: unknown, opts: any = {}) => readCostContext([{ role: 'assistant' as const, text: 'x', costContext: ctx }], { userId: USER, secret: SECRET, conversationId: 'conv-a-0001', now: NOW, ...opts });
  assert.ok(await read(fresh));

  assert.equal(await read(fresh, { userId: 'owner-2' }), null);
  assert.equal(await read({ ...fresh, scope: { ...scope, month: '2026-08' } }), null);
  assert.equal(await read(fresh, { secret: OTHER_SECRET }), null);
  assert.equal(await read(fresh, { conversationId: 'conv-b-0002' }), null);
  assert.equal(await read(fresh, { now: NOW + COST_CONTEXT_TTL_MS + 1 }), null);
  const other = await createCostContext({ userId: USER, secret: SECRET, conversationId: 'conv-b-0002', snap: 'snap-1', scope, now: NOW });
  assert.equal(await readCostContext([
    { role: 'assistant', text: 'x', costContext: fresh }, { role: 'user', text: 'y' }, { role: 'assistant', text: 'z', costContext: other },
  ], { userId: USER, secret: SECRET, conversationId: 'conv-a-0001', now: NOW }), null);
});

test('intent detectors stay bounded and do not hijack unrelated topics', () => {
  assert.ok(isExampleRequest('Lấy một dòng làm ví dụ'));
  assert.ok(isExampleRequest('Cho tôi một ví dụ'));
  assert.ok(!isExampleRequest('Ví dụ về doanh thu hôm nay'));
  assert.ok(isThisLineRequest('Vì sao dòng này?'));
  assert.ok(isThisLineRequest('Giải thích dòng này được xếp nhóm chi phí đó'));
  assert.ok(!isThisLineRequest('Doanh thu dòng này thế nào'));
  assert.ok(isPreviousMonthRequest('Còn tháng trước?'));
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-09'), '2026-08');
});

test('context validates its exact shape and surfaces a non-empty snapshot id', async () => {
  const scope = { kind: 'month_totals' as const, month: '2026-09', category_code: null, review_status: null };
  const ctx = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope, now: NOW });
  assert.match(ctx.sig, /^[a-f0-9]{64}$/);
  const read = (value: unknown, opts: any = {}) => readCostContext([{ role: 'assistant' as const, text: 'x', costContext: value }], { userId: USER, secret: SECRET, conversationId: CONV, now: NOW, ...opts });
  assert.equal(await read({ ...ctx, extra: 1 }), null);
  assert.equal(await read({ ...ctx, scope: { ...scope, kind: 'wipe' } }), null);
});

test('a month shift never hijacks a non-cost conversation, and the model cannot pick example_line', async () => {
  // No validated cost state: "còn tháng trước?" must fall through to the planner.
  assert.equal(await costFollowUp({ question: 'Còn tháng trước?', history: [{ role: 'assistant', text: 'Công nợ NPP Thanh tháng 9/2026' }], conversationId: CONV },
    { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' }), null);

  // A planner-chosen example_line (not from the deterministic resolver) abstains with zero reads.
  let costReads = 0;
  const call = async (path: string) => { if (path === '/v1/semantic') return enCatalog; costReads++; return {}; };
  const planner = async () => ({ value: { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'example_line', month: '2026-09' } }, usage });
  const result = await runWarehouse({ language: 'vi', question: 'Lấy một dòng làm ví dụ', conversationId: CONV, page, history: [{ role: 'user', text: 'xin chào' }] }, call, planner, signal, undefined, options);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(costReads, 0);
});

// --- Coordinator round-2 findings -------------------------------------------------

test('finding 1: a revenue previous-month question is never hijacked into cost', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const ctx = first.provenance.costContext;
  const history = [{ role: 'assistant', text: first.answer, costContext: ctx }];
  const follow = await costFollowUp({ question: 'doanh thu tháng trước', history, conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal(follow, null, 'a revenue question must fall through to the revenue planner, not cost');
  // Full orchestration: the planner (not the cost lane) decides.
  const result = await turn('doanh thu tháng trước', history, fixture([...SEPT, ...AUGUST]), options, abstainModel);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(result.provenance.modelCalls, 1);
  assert.equal(result.provenance.costContext, undefined);
  // An explicit cost previous-month follow-up still shifts inside the cost lane.
  const costPrior = await costFollowUp({ question: 'chi phí tháng trước', history, conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal(costPrior?.kind, 'cost');
  assert.equal((costPrior as any).source, 'previous_month');
  assert.equal((costPrior as any).lookup.month, '2026-08');
});

test('finding 2: an explicitly changed month/category/status invalidates the selected line', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }]);
  const ctx = example.provenance.costContext;
  assert.equal(ctx.selection.line_ref, 'c2');
  const changedMonth = await turn('vì sao dòng này trong tháng 4/2026?', [{ role: 'assistant', text: example.answer, costContext: ctx }], fixture([...SEPT, ...AUGUST, ...APRIL]));
  assert.equal(changedMonth.provenance.lane, 'abstain');
  assert.doesNotMatch(changedMonth.answer, /c2/);
  const changedStatus = await turn('vì sao dòng này đã duyệt?', [{ role: 'assistant', text: example.answer, costContext: ctx }]);
  assert.equal(changedStatus.provenance.lane, 'abstain');
  // The unchanged follow-up still resolves to the stored line.
  const same = await turn('vì sao dòng này?', [{ role: 'assistant', text: example.answer, costContext: ctx }]);
  assert.equal(same.provenance.lane, 'cost');
  assert.match(same.answer, /c2/);
});

test('finding 3: unsupported supplier/date/currency abstains before the example shortcut in full runWarehouse', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const history = [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }];
  for (const question of ['Lấy một dòng chi phí của nhà cung cấp ABC làm ví dụ', 'Lấy một dòng ví dụ theo ngày 12', 'Lấy một dòng ví dụ bằng USD']) {
    let costReads = 0;
    const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
    const result = await turn(question, history, call);
    assert.equal(result.provenance.lane, 'abstain', question);
    assert.equal(costReads, 0, `${question} must not read cost data`);
    assert.equal(result.provenance.costContext, undefined);
  }
});

test('round 3: a non-cost question after a cost answer defers instead of hitting the cost-only qualifier rule', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const history = [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }];
  for (const question of ['cho xem ảnh UNC ngân hàng ngày 12/9/2026', 'tài liệu hướng dẫn theo phòng ban']) {
    let costReads = 0;
    const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
    // The normal planner decides this turn; the cost rule must not abstain it first.
    const result = await turn(question, history, call, options, abstainModel);
    assert.equal(result.provenance.lane, 'abstain', `${question} must defer to the normal planner`);
    assert.equal(result.provenance.modelCalls, 1, `${question} must reach the planner`);
    assert.equal(result.provenance.costContext, undefined, `${question} must not issue cost state`);
    assert.equal(costReads, 0, `${question} must not read cost data`);
  }
  // A real cost follow-up carrying an unsupported filter must still abstain before any read.
  let costReads = 0;
  const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
  const blocked = await turn('Lấy một dòng làm ví dụ theo nhân viên', history, call);
  assert.equal(blocked.provenance.lane, 'abstain');
  assert.equal(blocked.provenance.modelCalls, 0);
  assert.equal(costReads, 0);
  assert.equal(blocked.provenance.costContext, undefined);
});

test('finding 4: explicit all-groups/all-statuses clear the inherited qualifiers', async () => {
  const first = await turn('Chi phí bánh mì tháng 9/2026 cần review', []);
  const ctx = first.provenance.costContext;
  assert.equal(ctx.scope.category_code, 'COGS_BMQ_BREAD');
  assert.equal(ctx.scope.review_status, 'needs_review');
  const history = [{ role: 'assistant', text: first.answer, costContext: ctx }];
  const allGroups = await costFollowUp({ question: 'Lấy một dòng ví dụ trong tất cả nhóm', history, conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal(allGroups?.kind, 'cost');
  assert.equal((allGroups as any).lookup.category_code, undefined, 'all-groups must clear the old category');
  const allStatuses = await costFollowUp({ question: 'Lấy một dòng ví dụ cho tất cả trạng thái', history, conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal(allStatuses?.kind, 'cost');
  assert.equal((allStatuses as any).lookup.review_status, undefined, 'all-statuses must clear the old status');
  // The cleared qualifiers persist into the next turn's issued state.
  const example = await turn('Lấy một dòng ví dụ trong tất cả nhóm', [{ role: 'assistant', text: first.answer, costContext: ctx }]);
  assert.equal(example.provenance.lane, 'cost');
  assert.equal(example.provenance.costContext.scope.category_code, null);
  assert.equal(example.provenance.costContext.scope.review_status, 'needs_review');
  const prior = await turn('còn tháng trước?', [{ role: 'assistant', text: example.answer, costContext: example.provenance.costContext }]);
  assert.equal(prior.provenance.costContext.scope.month, '2026-08');
  assert.equal(prior.provenance.costContext.scope.category_code, null, 'the cleared category must not be re-inherited');
});

test('finding 5: state is bound to the current conversation id and server secret, not a bearer digest', async () => {
  const scope = { kind: 'pending_summary' as const, month: '2026-09', category_code: null, review_status: 'needs_review' as const };
  const ctxA = await createCostContext({ userId: USER, secret: SECRET, conversationId: 'conv-aaaa-0001', snap: 'snap-1', scope, now: NOW });
  // Same user, brand-new conversation: the old conversation's state is rejected.
  assert.equal(await readCostContext([{ role: 'assistant', text: 'x', costContext: ctxA }], { userId: USER, secret: SECRET, conversationId: 'conv-bbbb-0002', now: NOW }), null);
  // A client-known/derived key (short or different) can never validate the state.
  await assert.rejects(() => createCostContext({ userId: USER, secret: 'short', conversationId: 'conv-aaaa-0001', snap: 'snap-1', scope, now: NOW }));
  assert.equal(await readCostContext([{ role: 'assistant', text: 'x', costContext: ctxA }], { userId: USER, secret: 'a'.repeat(64), conversationId: 'conv-aaaa-0001', now: NOW }), null);
});

test('finding 6: pending_summary/top_pending_lines imply needs_review and never carry an unsupported status', async () => {
  // Context was approved; asking the pending branch must switch to needs_review.
  const approved = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'month_totals', month: '2026-09', category_code: null, review_status: 'approved' }, now: NOW });
  const pending = await costFollowUp({ question: 'Còn bao nhiêu dòng cần review tháng 9/2026?', history: [{ role: 'assistant', text: 'x', costContext: approved }], conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal(pending?.kind, 'cost');
  const scope = (pending as any).lookup;
  assert.equal(scope.kind, 'pending_summary');
  assert.equal(scope.review_status, undefined, 'pending_summary must not send a rejected/unused review_status');
  // Previous month of a pending scope stays pending_summary without the field.
  const prior = await costFollowUp({ question: 'còn tháng trước?', history: [{ role: 'assistant', text: 'x', costContext: approved }], conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal((prior as any).lookup.kind, 'month_totals', 'approved month_totals keeps the status it accepts');
  assert.equal((prior as any).lookup.review_status, 'approved');
  const pendingCtx = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'pending_summary', month: '2026-09', category_code: 'COGS_BMQ_BREAD', review_status: 'needs_review' }, now: NOW });
  const priorPending = await costFollowUp({ question: 'còn tháng trước?', history: [{ role: 'assistant', text: 'x', costContext: pendingCtx }], conversationId: CONV }, { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17' });
  assert.equal((priorPending as any).lookup.kind, 'pending_summary');
  assert.equal((priorPending as any).lookup.month, '2026-08');
  assert.equal((priorPending as any).lookup.review_status, undefined);
});

test('finding 7: invalid months, epoch ordering and TTL bounds are rejected', async () => {
  assert.equal(validMonth('2026-13'), false);
  assert.equal(validMonth('2026-00'), false);
  assert.equal(validMonth('2026-12'), true);
  const scope = { kind: 'month_totals' as const, month: '2026-09', category_code: null, review_status: null };
  // Invalid month can never be stored or read back.
  await assert.rejects(() => createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { ...scope, month: '2026-13' }, now: NOW }));
  await assert.rejects(() => createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope, now: NOW, ttlMs: COST_CONTEXT_TTL_MS + 1 }));
  await assert.rejects(() => createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope, now: NOW, ttlMs: 1 }));
  const ctx = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope, now: NOW });
  // exp must be strictly after iat.
  assert.equal(await readCostContext([{ role: 'assistant', text: 'x', costContext: { ...ctx, exp: ctx.iat } }], { userId: USER, secret: SECRET, conversationId: CONV, now: NOW }), null);
  assert.equal(await readCostContext([{ role: 'assistant', text: 'x', costContext: { ...ctx, iat: ctx.exp + 1 } }], { userId: USER, secret: SECRET, conversationId: CONV, now: NOW }), null);
});

test('finding 8: route filters are an explicit allow-list and fail closed', () => {
  assert.deepEqual(Object.keys(COST_ROUTE_FILTER_WHITELIST), ['/finance-control/classification']);
  // No cost-route filter is source-verified today, so any page filter abstains.
  assert.deepEqual(routeCostScope('/finance-control/classification', { period: '2026-09' }, '2026-09-17'), { kind: 'abstain' });
  assert.deepEqual(routeCostScope('/finance-control/classification', {}, '2026-09-17'), null);
  assert.equal(routeCostScope('/some/other/route', { period: '2026-09' }, '2026-09-17'), null);
  // The mapping mechanism itself only accepts a known key with a valid value.
  assert.deepEqual(resolveRouteFilter({ period: 'month' }, 'period', '2026-09', '2026-09-17'), { key: 'month', value: '2026-09' });
  assert.equal(resolveRouteFilter({ period: 'month' }, 'period', '2026-13', '2026-09-17'), null);
  assert.equal(resolveRouteFilter({ period: 'month' }, 'period', '2027-01', '2026-09-17'), null);
  assert.deepEqual(resolveRouteFilter({ status: 'review_status' }, 'status', 'approved', '2026-09-17'), { key: 'review_status', value: 'approved' });
  assert.equal(resolveRouteFilter({ status: 'review_status' }, 'status', 'whatever', '2026-09-17'), null);
  assert.equal(resolveRouteFilter({}, 'period', '2026-09', '2026-09-17'), null);
});

test('finding 8: full runWarehouse abstains on page filters before any cost read', async () => {
  let costReads = 0;
  const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
  const filteredPage = { route: '/finance-control/classification', label: 'Phân loại chi phí', filters: { period: '2026-09' } };
  const result = await runWarehouse({ language: 'vi', question: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', conversationId: CONV, page: filteredPage, history: [] }, call, explodeModel, signal, undefined, options);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(costReads, 0);
});

test('finding 8: route scope is only the lowest-priority fallback', async () => {
  const routeScope = { month: '2026-01', review_status: 'approved' as const };
  const callOptions = { userId: USER, signingSecret: SECRET, now: NOW, today: '2026-09-17', routeScope };
  // Explicit question wins over the route.
  const explicit = await costFollowUp({ question: 'Chi phí tháng 9/2026 cần review', history: [], conversationId: CONV }, callOptions);
  assert.equal((explicit as any).lookup.month, '2026-09');
  assert.equal((explicit as any).lookup.kind, 'pending_summary');
  // Validated conversation wins over the route.
  const ctx = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'month_totals', month: '2026-08', category_code: null, review_status: null }, now: NOW });
  const prior = await costFollowUp({ question: 'còn tháng trước?', history: [{ role: 'assistant', text: 'x', costContext: ctx }], conversationId: CONV }, callOptions);
  assert.equal((prior as any).lookup.month, '2026-07');
  // With neither, the route supplies the month.
  const routeOnly = await costFollowUp({ question: 'Lấy một dòng làm ví dụ', history: [], conversationId: CONV }, callOptions);
  assert.equal((routeOnly as any).lookup.month, '2026-01');
});

test('finding 9/10: example pick and explanation must share a snapshot and both calls are audited', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const history = [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }];
  const call = fixture([...SEPT, ...AUGUST], 'snap-1', { explanationSnapshot: 'snap-2' });
  const example = await turn('Lấy một dòng làm ví dụ', history, call);
  assert.equal(example.provenance.lane, 'cost');
  // Evidence from another snapshot must not be merged; the picked row is still shown.
  assert.match(example.answer, /c2/);
  assert.match(example.answer, /Chưa lấy được bằng chứng phân loại/);
  const queries = example.provenance.queries as any[];
  // Every actually attempted cost read is audited, including the single bounded
  // snapshot-mismatch retry (pick, explain, re-pick, re-explain).
  assert.equal(queries.length, 4, 'every attempted pick/explanation read, including the bounded retry, is audited');
  assert.deepEqual(queries.map((entry) => entry.question), ['example_line', 'line_explanation', 'example_line', 'line_explanation']);
  assert.equal(queries[1].line_ref, 'c2');
  assert.equal(queries[3].line_ref, 'c2');
});

test('finding 11: an explicit new line_ref overrides the old selection; prose cannot resurrect it', async () => {
  const ref = '11111111-1111-4111-8111-111111111111';
  const lines = [
    ...SEPT, ...AUGUST,
    { classification_id: ref, month: '2026-09-01', category_code: 'COGS_BMQ_BREAD', category_label: 'Chi phí bánh mì', review_status: 'needs_review', supplier_name: 'NCC Sáu', source_number: 'PR-011', source_date: '2026-09-15', product_name: 'Bánh mì mới', line_amount: '2000000', classification_source: 'rule', rule_id: 'rule1', confidence: '0.80' },
  ];
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', [], fixture(lines));
  const example = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }], fixture(lines));
  const ctx = example.provenance.costContext;
  assert.equal(ctx.selection.line_ref, 'c2');
  // A different explicit classification id in the current question wins over the
  // stored selection instead of being vetoed by it.
  const explicit = await turn(`Vì sao dòng này ${ref} được xếp nhóm chi phí?`, [{ role: 'assistant', text: example.answer, costContext: ctx }], fixture(lines));
  assert.equal(explicit.provenance.lane, 'cost');
  assert.match(explicit.answer, new RegExp(ref));
  assert.equal(explicit.provenance.costContext.selection.line_ref, ref);
  // With no valid context, a planner-proposed id that is not in the question is refused.
  let costReads = 0;
  const call = async (path: string, request: any) => { if (path === '/v1/cost') costReads++; return fixture([...SEPT, ...AUGUST])(path, request); };
  const planner = async () => ({ value: { lane: 'cost', queries: [], search: '', clarification: '', cost_lookup: { kind: 'line_explanation', line_ref: 'c1' } }, usage });
  const result = await runWarehouse({ language: 'vi', question: 'Vì sao dòng này?', conversationId: CONV, page, history: [{ role: 'assistant', text: 'Dòng c1 trước đây' }] }, call, planner, signal, undefined, options);
  assert.equal(result.provenance.lane, 'abstain');
  assert.equal(costReads, 0);
});

// --- Round-4 coordinator findings (first-turn example, cleared status, retry trace) ----

test('round 4: a fully explicit first-turn example resolves to a row and keeps its qualifiers; flag off keeps the aggregate path', async () => {
  const enabled = await turn('Lấy một dòng chi phí tháng 9/2026 đã duyệt làm ví dụ', []);
  assert.equal(enabled.provenance.lane, 'cost');
  assert.equal(enabled.provenance.modelCalls, 0);
  const query = enabled.provenance.queries[0] as any;
  assert.equal(query.question, 'example_line', 'an explicit first-turn example must select a row, not aggregate');
  assert.equal(query.month, '2026-09');
  assert.equal(query.review_status, 'approved', 'the explicit approved qualifier must be preserved');
  assert.equal(enabled.provenance.costContext.scope.kind, 'month_totals', 'the aggregate intent behind the example is kept for later follow-ups');
  // Flag off: the pre-change aggregate path is untouched (no example resolution).
  const off = await turn('Lấy một dòng chi phí tháng 9/2026 đã duyệt làm ví dụ', [], fixture([...SEPT, ...AUGUST]), { ...options, contextEnabled: false }, abstainModel);
  assert.equal(off.provenance.lane, 'cost');
  assert.equal(off.provenance.modelCalls, 0);
  assert.equal((off.provenance.queries[0] as any).question, 'month_totals');
  assert.equal(off.provenance.costContext, undefined);
});

test('round 4: clearing all statuses persists across the next example and a previous-month follow-up', async () => {
  const scoped = await createCostContext({ userId: USER, secret: SECRET, conversationId: CONV, snap: 'snap-1', scope: { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' }, now: NOW });
  const cleared = await turn('Lấy một dòng ví dụ trong tất cả trạng thái', [{ role: 'assistant', text: 'pending', costContext: scoped }]);
  assert.equal((cleared.provenance.queries[0] as any).question, 'example_line');
  assert.equal((cleared.provenance.queries[0] as any).review_status, undefined);
  assert.equal(cleared.provenance.costContext.scope.review_status, null, 'the cleared status is stored');
  assert.equal(cleared.provenance.costContext.scope.kind, 'month_totals', 'the effective aggregate replaces the stale pending kind');
  const next = await turn('Lấy một dòng làm ví dụ', [{ role: 'assistant', text: cleared.answer, costContext: cleared.provenance.costContext }]);
  assert.equal((next.provenance.queries[0] as any).question, 'example_line');
  assert.equal((next.provenance.queries[0] as any).review_status, undefined, 'the old pending kind must not reinstate needs_review');
  const prior = await turn('Còn tháng trước?', [{ role: 'assistant', text: next.answer, costContext: next.provenance.costContext }]);
  assert.equal(prior.provenance.lane, 'cost');
  const priorQuery = prior.provenance.queries[0] as any;
  assert.equal(priorQuery.month, '2026-08');
  assert.equal(priorQuery.review_status, undefined, 'the cleared status persists into the previous month too');
  assert.equal(prior.provenance.costContext.scope.kind, 'month_totals');
});

test('round 4: provenance.queries records the real attempted cost reads, including the bounded retry', async () => {
  const first = await turn('Tháng 9/2026 còn bao nhiêu dòng cần review?', []);
  const history = [{ role: 'assistant', text: first.answer, costContext: first.provenance.costContext }];
  // Same snapshot: exactly the pick + explanation pair.
  const stable = await turn('Lấy một dòng làm ví dụ', history, fixture([...SEPT, ...AUGUST]));
  assert.deepEqual((stable.provenance.queries as any[]).map((entry) => entry.question), ['example_line', 'line_explanation']);
  // Snapshot mismatch: the bounded re-pick and re-explain are recorded too.
  const retried = await turn('Lấy một dòng làm ví dụ', history, fixture([...SEPT, ...AUGUST], 'snap-1', { explanationSnapshot: 'snap-2' }));
  const questions = (retried.provenance.queries as any[]).map((entry) => entry.question);
  assert.deepEqual(questions, ['example_line', 'line_explanation', 'example_line', 'line_explanation']);
});
