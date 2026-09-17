// Golden multi-turn evaluation for the cost conversation-context slice.
//
// Runs the SAME scripted conversations through the real Edge orchestration
// (runWarehouse) twice:
//   baseline: context flag off and no structured state in history (pre-change flow)
//   new:      context flag on and the issued bounded state echoed in history
//
// The warehouse side is a deterministic in-memory fixture of the canonical view
// (the real SQL contract is covered by sme-data-platform/tests/test_bmq_cost.py).
// The planner stub is deliberately deterministic and mostly abstaining: with no
// structured state it can only clarify a follow-up. This measures DETERMINISTIC
// FIXTURE COVERAGE ONLY, never real LLM accuracy; token/cost are unmeasured because
// no provider call happens. The end-to-end handler+auth+warehouse contract lives in
// supabase/functions/bmq-analytics/handler.test.ts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runWarehouse } from '../supabase/functions/bmq-analytics/warehouse.ts';
import { COST_KINDS } from '../supabase/functions/bmq-analytics/cost.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../generated/chat-context');
mkdirSync(outDir, { recursive: true });

const signal = new AbortController().signal;
const usage = { input: 1, output: 1, cached: 0 };
const NOW = Date.parse('2026-09-17T03:00:00Z');
const USER = 'golden-owner';
const SECRET = 'golden-fixture-signing-secret-0123456789abcdef';
const CONV = 'conv-golden-0001';
const page = { route: '/finance-control/classification', label: 'Phân loại chi phí' };
const catalog = {
  metrics: { dealer_order_count: { label: 'Dealer count', unit: 'count' } }, dimensions: { date: 'date' }, version: 'x',
  cost_lookup: { version: 'bmq-cost-classification-v2', questions: COST_KINDS.map((id) => ({ id })) },
};
const RULES = { rule1: { rule_name: 'BMQ bread keywords', match_scope: 'supplier_and_item', priority: '100', confidence: '0.90', effective_from: '2026-01-01', effective_to: null } };
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

function fixture(lines, snapshotId = 'snap-1', tally = { cost: 0 }) {
  const num = (v) => Number(v);
  const provenance = { source: 'Supabase.cost_classification_line_details', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: snapshotId, semantic_version: 'bmq-cost-classification-v2' };
  const ordered = (rows) => [...rows].sort((a, b) => num(b.line_amount) - num(a.line_amount)
    || String(b.source_date).localeCompare(String(a.source_date)) || String(a.classification_id).localeCompare(String(b.classification_id)));
  return async (path, request) => {
    if (path === '/v1/semantic') return catalog;
    tally.cost++;
    if (request.question === 'example_line') {
      const matched = ordered(lines.filter((line) => line.month.slice(0, 7) === request.month && (!request.category_code || line.category_code === request.category_code) && (!request.review_status || line.review_status === request.review_status)));
      return { ...provenance, question: 'example_line', month: request.month, category_code: request.category_code ?? null, review_status: request.review_status ?? null, match_count: matched.length, rows: matched.slice(0, request.limit ?? 1), limit: request.limit ?? 1, truncated: matched.length > (request.limit ?? 1), selection_rule: 'largest_line_amount_then_source_date_then_classification_id' };
    }
    if (request.question === 'line_explanation') {
      const line = lines.find((entry) => entry.classification_id === request.line_ref);
      if (!line) return { ...provenance, question: 'line_explanation', status: 'not_found', line_ref: request.line_ref };
      return { ...provenance, question: 'line_explanation', status: 'ok', line_ref: request.line_ref, line, evidence: { rule: line.rule_id ? RULES[line.rule_id] : null, alias_mapping: null, alias_status: null } };
    }
    const month = lines.filter((line) => line.month.slice(0, 7) === request.month);
    const matched = request.question === 'pending_summary' ? month.filter((line) => line.review_status === 'needs_review') : month.filter((line) => (!request.category_code || line.category_code === request.category_code) && (!request.review_status || line.review_status === request.review_status));
    const statuses = ['needs_review', 'suggested', 'approved', 'rejected'].map((status) => {
      const rows = month.filter((line) => line.review_status === status);
      return { review_status: status, line_count: rows.length, total_amount: String(rows.reduce((sum, line) => sum + num(line.line_amount), 0)) };
    });
    return { ...provenance, question: request.question, month: request.month, category_code: request.category_code ?? null, review_status: request.review_status ?? null, rows: [], statuses, line_count: matched.length, total_amount: String(matched.reduce((sum, line) => sum + num(line.line_amount), 0)) };
  };
}

const clarifyModel = async () => ({ value: { lane: 'abstain', queries: [], search: '', clarification: 'Anh nêu rõ phạm vi cần tra nhé.' }, usage });

const SCENARIOS = [
  {
    name: 'original_complaint', lines: [...SEPT, ...AUGUST],
    turns: [
      { q: 'Tháng 9/2026 còn bao nhiêu dòng cần review, tổng tiền bao nhiêu?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09' } },
      { q: 'Lấy một dòng làm ví dụ', expect: { lane: 'cost', kind: 'example_line', ref: 'c2' } },
      { q: 'Vì sao dòng này?', expect: { lane: 'cost', kind: 'line_explanation', ref: 'c2' } },
      { q: 'Còn tháng trước?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-08' } },
    ],
  },
  {
    name: 'explicit_scope_change', lines: [...SEPT, ...AUGUST],
    turns: [
      { q: 'Chi phí tháng 9/2026 theo từng nhóm', expect: { lane: 'cost', kind: 'month_totals', month: '2026-09' } },
      { q: 'Lấy một dòng làm ví dụ', expect: { lane: 'cost', kind: 'example_line', ref: 'c1' } },
      { q: 'Chi phí bánh mì tháng 8/2026 đã duyệt', expect: { lane: 'cost', kind: 'month_totals', month: '2026-08', category: 'COGS_BMQ_BREAD', status: 'approved', noSelection: true } },
    ],
  },
  {
    name: 'no_records', lines: [...SEPT, ...AUGUST],
    turns: [
      { q: 'Chi phí bánh mì tháng 8/2026 đã duyệt', expect: { lane: 'cost', kind: 'month_totals', month: '2026-08' } },
      { q: 'Lấy một dòng làm ví dụ', expect: { lane: 'cost', kind: 'example_line', empty: true } },
    ],
  },
  {
    name: 'stale_evidence', lines: [...SEPT, ...AUGUST], refresh: SEPT.map((line) => line.classification_id === 'c2' ? { ...line, review_status: 'approved' } : line),
    turns: [
      { q: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09' } },
      { q: 'Lấy một dòng làm ví dụ', expect: { lane: 'cost', kind: 'example_line', ref: 'c2' } },
      { q: 'Vì sao dòng này?', expect: { lane: 'abstain', abstain: true }, refreshed: true },
    ],
  },
  {
    name: 'unsupported_input', lines: [...SEPT],
    turns: [
      { q: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09' } },
      { q: 'Lấy một dòng làm ví dụ theo nhân viên', expect: { lane: 'abstain', abstain: true } },
    ],
  },
  {
    name: 'revenue_not_hijacked', lines: [...SEPT, ...AUGUST],
    turns: [
      { q: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09' } },
      { q: 'doanh thu tháng trước', expect: { lane: 'abstain', abstain: true } },
    ],
  },
  {
    name: 'changed_month_invalidates_selection', lines: [...SEPT, ...AUGUST, ...APRIL],
    turns: [
      { q: 'Tháng 9/2026 còn bao nhiêu dòng cần review?', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09' } },
      { q: 'Lấy một dòng làm ví dụ', expect: { lane: 'cost', kind: 'example_line', ref: 'c2' } },
      { q: 'vì sao dòng này trong tháng 4/2026?', expect: { lane: 'abstain', abstain: true } },
    ],
  },
  {
    name: 'all_groups_clears_category', lines: [...SEPT, ...AUGUST],
    turns: [
      { q: 'Chi phí bánh mì tháng 9/2026 cần review', expect: { lane: 'cost', kind: 'pending_summary', month: '2026-09', category: 'COGS_BMQ_BREAD' } },
      { q: 'Lấy một dòng ví dụ trong tất cả nhóm', expect: { lane: 'cost', kind: 'example_line', noCategory: true } },
    ],
  },
];

function observe(result, expect) {
  const provenance = result.provenance;
  const costContext = provenance.costContext;
  const observed = {
    lane: provenance.lane,
    kind: provenance.queries?.[0]?.question ?? costContext?.scope?.kind ?? null,
    month: provenance.queries?.[0]?.month ?? costContext?.scope?.month ?? null,
    category: costContext?.scope?.category_code ?? null,
    status: costContext?.scope?.review_status ?? null,
    ref: costContext?.selection?.line_ref ?? null,
    hasSelection: Boolean(costContext?.selection),
    empty: /Không có dòng chi phí nào khớp phạm vi này/.test(result.answer),
    modelCalls: provenance.modelCalls ?? 0,
  };
  let expectationMatched = observed.lane === expect.lane;
  if (expect.kind) expectationMatched = expectationMatched && observed.kind === expect.kind;
  if (expect.month) expectationMatched = expectationMatched && observed.month === expect.month;
  if (expect.category) expectationMatched = expectationMatched && observed.category === expect.category;
  if (expect.status) expectationMatched = expectationMatched && observed.status === expect.status;
  if (expect.ref) expectationMatched = expectationMatched && observed.ref === expect.ref;
  if (expect.noSelection) expectationMatched = expectationMatched && observed.hasSelection === false;
  if (expect.noCategory) expectationMatched = expectationMatched && observed.category === null;
  if (expect.empty) expectationMatched = expectationMatched && observed.empty === true;
  if (expect.abstain) expectationMatched = expectationMatched && observed.lane === 'abstain';
  return { observed, expectationMatched, abstained: observed.lane === 'abstain' };
}

async function runScenario(scenario, mode) {
  const contextEnabled = mode === 'new';
  const tally = { cost: 0 };
  const baseCall = fixture(scenario.lines, 'snap-1', tally);
  const freshCall = scenario.refresh ? fixture(scenario.refresh, 'snap-2', tally) : baseCall;
  let history = [];
  const rows = [];
  for (const turnSpec of scenario.turns) {
    const call = turnSpec.refreshed ? freshCall : baseCall;
    const started = performance.now();
    const result = await runWarehouse(
      { language: 'vi', question: turnSpec.q, conversationId: CONV, page, history },
      call, clarifyModel, signal, undefined,
      { contextEnabled, signingSecret: SECRET, userId: USER, now: NOW },
    );
    const latencyMs = performance.now() - started;
    const outcome = observe(result, turnSpec.expect);
    rows.push({ question: turnSpec.q, expect: turnSpec.expect, ...outcome.observed, expectationMatched: outcome.expectationMatched, abstained: outcome.abstained, latencyMs: Math.round(latencyMs * 1000) / 1000 });
    history = [...history, { role: 'user', text: turnSpec.q }, { role: 'assistant', text: result.answer, ...(contextEnabled && result.provenance.costContext ? { costContext: result.provenance.costContext } : {}) }];
  }
  return { mode, rows, costCalls: tally.cost };
}

const report = { generatedAt: new Date().toISOString(), baselineMode: 'context flag off, no structured history state', newMode: 'context flag on, bounded signed state echoed', metric: 'fixture expectation match rate — deterministic fixture coverage only, NOT real LLM accuracy', tokensMeasured: false, costMeasured: false, scenarios: [] };
for (const scenario of SCENARIOS) {
  const baseline = await runScenario(scenario, 'baseline');
  const next = await runScenario(scenario, 'new');
  report.scenarios.push({ name: scenario.name, baseline, new: next });
}
const summarize = (key) => {
  const rows = report.scenarios.flatMap((scenario) => scenario[key].rows);
  return {
    turns: rows.length,
    expectationMatched: rows.filter((row) => row.expectationMatched).length,
    expectationMatchRate: Math.round((rows.filter((row) => row.expectationMatched).length / rows.length) * 1000) / 1000,
    abstainTurns: rows.filter((row) => row.abstained).length,
    costCalls: report.scenarios.reduce((sum, scenario) => sum + scenario[key].costCalls, 0),
    meanLatencyMs: Math.round((rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length) * 1000) / 1000,
    modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0),
    tokens: 'unmeasured',
    cost: 'unmeasured',
  };
};
report.summary = { baseline: summarize('baseline'), new: summarize('new') };

writeFileSync(resolve(outDir, 'golden-eval.json'), JSON.stringify(report, null, 2));
const lines = [
  '# Golden multi-turn evaluation — cost conversation context', '',
  `Baseline: ${report.baselineMode}`, `New: ${report.newMode}`, '',
  '| mode | turns | fixture expectation matched | fixture expectation match rate | abstain turns | /v1/cost calls | model calls | mean latency (ms) | tokens | cost |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  `| baseline | ${report.summary.baseline.turns} | ${report.summary.baseline.expectationMatched} | ${report.summary.baseline.expectationMatchRate} | ${report.summary.baseline.abstainTurns} | ${report.summary.baseline.costCalls} | ${report.summary.baseline.modelCalls} | ${report.summary.baseline.meanLatencyMs} | unmeasured | unmeasured |`,
  `| new | ${report.summary.new.turns} | ${report.summary.new.expectationMatched} | ${report.summary.new.expectationMatchRate} | ${report.summary.new.abstainTurns} | ${report.summary.new.costCalls} | ${report.summary.new.modelCalls} | ${report.summary.new.meanLatencyMs} | unmeasured | unmeasured |`, '',
  'This table measures DETERMINISTIC FIXTURE COVERAGE ONLY against scripted expectations. It is not real LLM accuracy, not a production quality score and not a token/cost measurement: the planner here is a deterministic stub and no provider call is made.',
  'The end-to-end handler + fixture auth + real warehouse-call contract is covered separately by supabase/functions/bmq-analytics/handler.test.ts.', '',
];
for (const scenario of report.scenarios) {
  lines.push(`## ${scenario.name}`, '', '| turn | expect | baseline | new |', '| --- | --- | --- | --- |');
  scenario.baseline.rows.forEach((row, index) => {
    const next = scenario.new.rows[index];
    const show = (entry) => `${entry.lane}/${entry.kind ?? '-'}/${entry.month ?? '-'}${entry.ref ? `/${entry.ref}` : ''}${entry.expectationMatched ? ' ✓' : ' ✗'}`;
    lines.push(`| ${index + 1} | ${JSON.stringify(row.expect)} | ${show(row)} | ${show(next)} |`);
  });
  lines.push('');
}
writeFileSync(resolve(outDir, 'golden-eval.md'), lines.join('\n'));
console.log(JSON.stringify(report.summary, null, 2));
