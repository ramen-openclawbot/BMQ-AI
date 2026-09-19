// Offline tests for the synthetic dataset and the opt-in benchmark harness.
// No provider call is made here: lanes A/C are always injected mocks and the hard
// budget, scoring, pairing and sanitization logic is exercised deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JEV_DATASET, JEV_DATASET_VERSION, JEV_FRESH_HOLDOUT_IDS, casesForIds, casesForSplit, type JevDatasetCase } from './jev-dataset.ts';
import { matchExactBounded, screenBoundedQuestion } from './jev.ts';
import {
  BENCHMARK_CATALOG, BENCHMARK_DEFAULT_MAX_REQUESTS, BENCHMARK_HARD_MAX_REQUESTS, BenchmarkBudgetExhausted,
  benchmarkConfigFromEnv, deterministicBounded, laneBRunner, main, runJevBenchmark,
} from './jev-benchmark.ts';

const outcome = (over: Record<string, unknown> = {}) => ({
  outcome: 'bounded', path: 'jev', metric: 'dealer_order_count', period: 'previous_week', reason: null,
  latencyMs: 12, providerMs: 8, usage: { input: 10, output: 2 }, jevCost: 0.00002, plannerCost: null, ...over,
}) as any;
const paidRunner = (over: Record<string, unknown> = {}) => (async (_testCase: JevDatasetCase, { budget }: any) => {
  if (!budget.reserve()) throw new BenchmarkBudgetExhausted();
  return outcome(over);
}) as any;

test('dataset is synthetic, versioned, balanced and split into tune and holdout', () => {
  assert.ok(JEV_DATASET.length >= 24);
  assert.equal(JEV_DATASET_VERSION.startsWith('jev-bmq-dataset-'), true);
  const tune = casesForSplit('tune'), holdout = casesForSplit('holdout');
  assert.ok(tune.length >= 8 && holdout.length >= 8);
  assert.equal(casesForSplit('both').length, JEV_DATASET.length);
  assert.equal(new Set(JEV_DATASET.map((entry) => entry.id)).size, JEV_DATASET.length);
  assert.ok(JEV_DATASET.some((entry) => entry.expected.kind === 'bounded'));
  assert.ok(JEV_DATASET.some((entry) => entry.expected.kind === 'fallback'));
  assert.ok(JEV_DATASET.every((entry) => entry.question.length > 0 && (entry.split === 'tune' || entry.split === 'holdout')));
});

test('every dataset case carries the screen reason its expectation allows', () => {
  // A bounded case must reach Jev (screen ok); a fallback case either pins the exact
  // deterministic rejection or explicitly allows the model to decide (`screen: null`).
  for (const entry of JEV_DATASET) {
    const screen = screenBoundedQuestion(entry.question).reason;
    if (entry.expected.kind === 'bounded') {
      assert.equal(screen, 'ok', `${entry.id} must be eligible, got ${screen}`);
    } else if (entry.expected.screen !== null) {
      assert.equal(screen, entry.expected.screen, `${entry.id} screen mismatch`);
    }
  }
});

test('fresh frozen holdout is separate, synthetic and mixes clean paraphrases with tricky unsupported questions', () => {
  const fresh = casesForIds(JEV_FRESH_HOLDOUT_IDS);
  assert.equal(fresh.length, JEV_FRESH_HOLDOUT_IDS.length);
  assert.equal(new Set(JEV_FRESH_HOLDOUT_IDS).size, JEV_FRESH_HOLDOUT_IDS.length, 'frozen ids must be unique');
  // Fresh: no id was part of the earlier tune/diagnosis set.
  const earlier = new Set(['t02', 't03', 't05', 't07', 'h05', 'h07', 'h08', 'h09']);
  for (const entry of fresh) assert.equal(earlier.has(entry.id), false, `${entry.id} must be a fresh case`);
  for (const entry of fresh) assert.equal(entry.split, 'holdout');
  const clean = fresh.filter((entry) => entry.expected.kind === 'bounded');
  const tricky = fresh.filter((entry) => entry.expected.kind === 'fallback');
  assert.ok(clean.length >= 4, 'fresh holdout needs clean bounded paraphrases');
  assert.ok(tricky.length >= 6, 'fresh holdout needs tricky unsupported questions');
  // Every clean case must pass the conservative screen; every tricky case must be
  // rejected either by the screen or by the model's own support answer.
  for (const entry of clean) assert.equal(screenBoundedQuestion(entry.question).eligible, true, entry.id);
  assert.ok(tricky.some((entry) => entry.expected.kind === 'fallback' && entry.expected.screen === null), 'at least one tricky case must be decided by the model');
});

test('lane B reuses the actual enabled deterministic matcher and misses paraphrases', () => {
  assert.equal(deterministicBounded, matchExactBounded, 'lane B must be the runtime matcher, not a second comparator');
  assert.deepEqual(deterministicBounded('số đơn đại lý hôm qua'), { metric: 'dealer_order_count', time_range: 'yesterday' });
  assert.deepEqual(deterministicBounded('giá trị đơn đại lý hôm qua'), { metric: 'dealer_order_value', time_range: 'yesterday' });
  assert.deepEqual(deterministicBounded('kiosk reports last month'), { metric: 'kiosk_report_count', time_range: 'previous_month' });
  assert.equal(deterministicBounded('Cho anh tổng giá trị đơn đại lý của tháng vừa rồi'), null);
  assert.equal(deterministicBounded('báo cáo điểm bán tuần rồi'), null);
  assert.equal(deterministicBounded('what is the dealer ordered value this month'), null);
  assert.equal(deterministicBounded('số đơn đại lý tuần này theo chi nhánh'), null);
});

test('synthetic benchmark catalog uses the real BMQ units and definitions instead of all-count', () => {
  const metrics = BENCHMARK_CATALOG.metrics as Record<string, { unit: string; description: string }>;
  assert.deepEqual(Object.keys(metrics).sort(), ['controlled_revenue', 'dealer_order_count', 'dealer_order_value', 'kiosk_report_count']);
  assert.equal(metrics.dealer_order_count.unit, 'count');
  assert.equal(metrics.dealer_order_value.unit, 'VND');
  assert.equal(metrics.kiosk_report_count.unit, 'count');
  assert.equal(metrics.controlled_revenue.unit, 'VND');
  // Definitions must keep the real operational/source distinctions, not a generic count.
  assert.match(metrics.dealer_order_count.description, /submitted_at/);
  assert.match(metrics.dealer_order_value.description, /total_amount_vnd/);
  assert.match(metrics.kiosk_report_count.description, /report_date/);
  assert.match(metrics.controlled_revenue.description, /approved/);
});

test('dry run never calls a paid runner and skips lanes A and C', async () => {
  const cases = casesForSplit('both');
  const calls: string[] = [];
  const runner = (async (c: JevDatasetCase, { budget }: any) => { calls.push(c.id); budget.reserve(); return outcome(); }) as any;
  const report = await runJevBenchmark({ cases, lanes: ['A', 'B', 'C'], enabled: false, runners: { A: runner, C: runner } });
  assert.equal(report.mode, 'dry_run');
  assert.equal(calls.length, 0);
  assert.equal(report.budget.used, 0);
  assert.ok(report.results.filter((record) => record.lane !== 'B').every((record) => record.reason === 'paid_opt_in_required'));
  assert.equal(report.lanes.find((lane) => lane.lane === 'B')!.skipped, 0);
});

test('the hard budget is reserved before every dispatch so a max of 1 admits exactly one call', async () => {
  const cases = casesForSplit('tune').slice(0, 3);
  // A runner that tries two provider dispatches per case: the second must be refused.
  const runner = (async (_c: JevDatasetCase, { budget }: any) => {
    assert.equal(budget.reserve(), true);
    assert.equal(budget.reserve(), false, 'the second dispatch must be refused');
    throw new BenchmarkBudgetExhausted();
  }) as any;
  const report = await runJevBenchmark({ cases, lanes: ['A'], enabled: true, maxRequests: 1, runners: { A: runner } });
  assert.equal(report.budget.maxRequests, 1);
  assert.equal(report.budget.used, 1, 'a runner cannot exceed its one reserved request');
  assert.equal(report.lanes[0].providerCalls, 1);
  assert.equal(report.results[0].reason, 'request_budget_exhausted');
  assert.equal(report.results.filter((record) => record.reason === 'request_budget_exhausted').length, cases.length);
});

test('a NaN or missing limit never disables the cap', async () => {
  const cases: JevDatasetCase[] = casesForSplit('tune');
  const nan = await runJevBenchmark({ cases, lanes: ['A'], enabled: true, maxRequests: Number.NaN, runners: { A: paidRunner() } });
  assert.equal(nan.budget.maxRequests, BENCHMARK_DEFAULT_MAX_REQUESTS);
  const huge = await runJevBenchmark({ cases, lanes: ['A'], enabled: true, maxRequests: 100000, runners: { A: paidRunner() } });
  assert.equal(huge.budget.maxRequests, BENCHMARK_HARD_MAX_REQUESTS);
});

test('cases are interleaved lane-by-lane and a budget stop yields an explicit paired subset', async () => {
  const cases = casesForSplit('tune').slice(0, 2);
  const full = await runJevBenchmark({ cases, lanes: ['A', 'B', 'C'], enabled: true, runners: { A: paidRunner(), C: paidRunner() } });
  assert.deepEqual(full.results.slice(0, 3).map((record) => `${record.id}:${record.lane}`), [`${cases[0].id}:A`, `${cases[0].id}:B`, `${cases[0].id}:C`]);
  assert.equal(full.paired.cases, 2);
  assert.equal(full.paired.lanes.C.ran, 2);

  const stopped = await runJevBenchmark({ cases, lanes: ['A', 'C'], enabled: true, maxRequests: 1, runners: { A: paidRunner(), C: paidRunner() } });
  assert.equal(stopped.budget.used, 1);
  assert.equal(stopped.paired.cases, 0, 'a partially run case is not comparable');
});

test('lane C correctness is split by the actual path (jev vs planner vs exact_rule)', async () => {
  const cases = casesForSplit('tune').slice(0, 3);
  const runner = (async (testCase: JevDatasetCase, { budget }: any) => {
    budget.reserve();
    if (testCase.id === cases[0].id) return outcome({ path: 'jev', metric: 'dealer_order_count', period: 'previous_week' });
    if (testCase.id === cases[1].id) return outcome({ path: 'planner', outcome: 'fallback' });
    return outcome({ path: 'exact_rule' });
  }) as any;
  const report = await runJevBenchmark({ cases, lanes: ['C'], enabled: true, runners: { C: runner } });
  const c = report.lanes[0];
  assert.equal(c.paths.jev.ran, 1);
  assert.equal(c.paths.planner.ran, 1);
  assert.equal(c.paths.exact_rule.ran, 1);
  assert.equal(c.providerCalls, 3);
});

test('sanitized report omits questions by default and never surfaces a runner error message', async () => {
  const cases: JevDatasetCase[] = casesForSplit('tune').slice(0, 3);
  const report = await runJevBenchmark({
    cases, lanes: ['A'], enabled: true, runners: { A: (async () => { throw new Error('bearer super-secret-key leaked'); }) as any },
  });
  assert.equal(report.results.every((record) => record.question === undefined), true);
  assert.equal(JSON.stringify(report).includes('super-secret'), false);
  assert.equal(report.results.every((record) => record.reason === 'runner_error'), true);
  assert.equal(report.lanes[0].errors, cases.length);
  assert.equal(JSON.stringify(report).includes('AI_GATEWAY_API_KEY'), false);
  assert.ok(report.notes.some((note) => note.includes('not browser end-to-end latency')));
});

test('a failed provider attempt keeps its real wall-clock latency instead of zero', async () => {
  const cases: JevDatasetCase[] = casesForSplit('tune').slice(0, 1);
  const report = await runJevBenchmark({
    cases, lanes: ['A'], enabled: true,
    runners: { A: (async () => { await new Promise((resolve) => setTimeout(resolve, 15)); throw new Error('provider down'); }) as any },
  });
  const record = report.results[0];
  assert.equal(record.outcome, 'error');
  assert.ok(record.latencyMs >= 10, `a failure must record real elapsed time, got ${record.latencyMs}`);
  assert.equal(report.lanes[0].errors, 1);
  assert.ok((report.lanes[0].latencyMs.p50 ?? 0) >= 10, 'a failed attempt must stay in the latency summary');
});

test('Jev cost is reported separately and never as the unknown total pipeline cost', async () => {
  const cases: JevDatasetCase[] = casesForSplit('tune').slice(0, 1);
  const report = await runJevBenchmark({ cases, lanes: ['C'], enabled: true, runners: { C: paidRunner() } });
  const lane = report.lanes[0];
  assert.deepEqual(lane.cost, { jev: 0.00002, planner: null, total: null });
  assert.equal(report.results[0].jevCost, 0.00002);
  assert.equal(report.results[0].plannerCost, null);
  assert.ok(report.notes.some((note) => note.includes('never presented as the total pipeline cost')));
});

test('an errored lane drops the whole case from the paired subset instead of hiding it', async () => {
  const cases = casesForSplit('tune').slice(0, 2);
  const report = await runJevBenchmark({
    cases, lanes: ['A', 'C'], enabled: true,
    runners: { A: paidRunner(), C: (async () => { throw new Error('lane down'); }) as any },
  });
  assert.equal(report.paired.cases, 0, 'a case with one errored lane is not comparable');
  assert.equal(report.paired.lanes.A.ran, 0);
  assert.equal(report.paired.lanes.C.ran, 0);
});

test('benchmark env parsing is fail-closed, NaN-safe and split/lane bounded', () => {
  assert.deepEqual(benchmarkConfigFromEnv({}), { enabled: false, split: 'tune', lanes: ['A', 'B', 'C'], maxRequests: 60, openAIKey: '', gatewayKey: '' });
  const parsed = benchmarkConfigFromEnv({ BMQ_JEV_BENCH_ENABLED: 'true', BMQ_JEV_BENCH_SPLIT: 'holdout', BMQ_JEV_BENCH_LANES: 'b,c', BMQ_JEV_BENCH_MAX_REQUESTS: '45', OPENAI_API_KEY: 'sk-x', AI_GATEWAY_API_KEY: 'gw-y' });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.split, 'holdout');
  assert.deepEqual(parsed.lanes, ['B', 'C']);
  assert.equal(parsed.maxRequests, 45);
  assert.equal(benchmarkConfigFromEnv({ BMQ_JEV_BENCH_SPLIT: 'nonsense' }).split, 'tune');
  assert.equal(benchmarkConfigFromEnv({ BMQ_JEV_BENCH_MAX_REQUESTS: 'nope' }).maxRequests, BENCHMARK_DEFAULT_MAX_REQUESTS);
});

test('main in dry-run mode emits a sanitized report and makes no provider call', async () => {
  let printed = '';
  const report = await main({}, (line) => { printed = line; });
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.budget.used, 0);
  assert.ok(printed.includes('"mode": "dry_run"'));
  assert.equal(printed.includes('AI_GATEWAY_API_KEY'), false);
  assert.equal(printed.includes('sk-'), false);
  assert.equal(typeof laneBRunner, 'function', 'lane B must be available without a provider');
});
