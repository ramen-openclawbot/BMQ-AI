// Offline/opt-in benchmark harness for the selective Jev planner.
//
// Compares three lanes on the same synthetic dataset, interleaved case-by-case so a
// budget stop cannot silently favour one lane:
//   A — the EXISTING warehouse pipeline (deterministic routes first, then the Luna
//       planner) with Jev disabled. This is the real production path.
//   B — the ACTUAL enabled deterministic bounded matcher (`matchExactBounded`), the
//       same function the runtime uses to bypass Jev for regex-known answers.
//   C — the Jev-gated path: conservative screen -> anchored exact rule -> one batched
//       Jev request -> validated plan, falling back to the EXISTING planner otherwise.
//
// Honesty rules enforced by this module:
//   * Lane A and lane C make real, paid provider calls. They only run when
//     `enabled === true` (env `BMQ_JEV_BENCH_ENABLED=true`).
//   * The request budget is a shared object reserved BEFORE every provider dispatch,
//     inside the gated fetch used by both the Jev client and the planner model. A
//     failing, timed-out or erroring attempt still consumes its reservation, so the
//     hard cap (default and hard maximum 60) cannot be exceeded or disabled by a NaN.
//   * Latency is measured wall-clock per case; a failed or timed-out provider attempt
//     still contributes its real elapsed time (never 0); token usage comes from real
//     provider responses. Cost is split because the providers report differently:
//     `jevCost` is the Gateway-reported Jev cost when present, else null, while the
//     planner path reports no cost, so the total pipeline cost is unknown (`null`) and
//     the Jev-only figure is never labelled as the total. Nothing is estimated. The
//     measured number is a server-side warehouse-call duration in a synthetic stub,
//     NOT browser end-to-end latency.
//   * The emitted report contains synthetic questions and measured numbers only —
//     never an API key, JWT, prompt body or real business row.
import type { WarehouseCall } from "../_shared/warehouse.ts";
import { openAIModel, type ModelCall } from "./service.ts";
import { runWarehouse } from "./warehouse.ts";
import { createJevCircuit, matchExactBounded, type JevOptions } from "./jev.ts";
import { casesForSplit, type JevDatasetCase } from "./jev-dataset.ts";

export const BENCHMARK_DEFAULT_MAX_REQUESTS = 60;
export const BENCHMARK_HARD_MAX_REQUESTS = 60;
export type BenchmarkLane = "A" | "B" | "C";
export type BenchmarkOutcome = "bounded" | "fallback" | "error" | "skipped";
// How the plan was produced. This is what distinguishes a Jev plan from an LLM
// fallback plan and from a deterministic exact-rule answer.
export type BenchmarkPath = "jev" | "planner" | "deterministic" | "exact_rule" | "none";
export type LaneOutcome = {
  outcome: BenchmarkOutcome;
  path: BenchmarkPath;
  metric: string | null;
  period: string | null;
  reason: string | null;
  latencyMs: number;
  providerMs: number | null;
  usage: { input: number; output: number } | null;
  // Gateway-reported Jev cost when the provider metadata carries it, else null.
  jevCost: number | null;
  // The OpenAI planner path does not report a per-request cost in this harness, so
  // this is null (unknown) and must never be treated as zero or folded into `jevCost`.
  plannerCost: number | null;
  jevDecided?: boolean;
};
// A shared, hard request budget. Every provider dispatch must reserve first.
export class BenchmarkBudgetExhausted extends Error {
  constructor() { super("benchmark_request_budget_exhausted"); this.name = "BenchmarkBudgetExhausted"; }
}
export class BenchmarkRequestBudget {
  max: number;
  used = 0;
  constructor(max: number) { this.max = max; }
  get usedRequests() { return this.used; }
  get remaining() { return Math.max(0, this.max - this.used); }
  get exhausted() { return this.used >= this.max; }
  reserve(): boolean { if (this.used >= this.max) return false; this.used += 1; return true; }
}
export type BenchmarkRunnerContext = { budget: BenchmarkRequestBudget };
export type LaneRunner = (testCase: JevDatasetCase, context: BenchmarkRunnerContext) => Promise<LaneOutcome>;
export type BenchmarkOptions = {
  cases: JevDatasetCase[];
  lanes?: BenchmarkLane[];
  enabled?: boolean;
  runners?: Partial<Record<BenchmarkLane, LaneRunner>>;
  maxRequests?: number;
  includeQuestions?: boolean;
};
export type BenchmarkRecord = {
  id: string;
  split: "tune" | "holdout";
  language: "vi" | "en";
  tags: string[];
  question?: string;
  expected: JevDatasetCase["expected"];
  lane: BenchmarkLane;
  outcome: BenchmarkOutcome;
  path: BenchmarkPath;
  metric: string | null;
  period: string | null;
  reason: string | null;
  correct: boolean;
  latencyMs: number;
  providerMs: number | null;
  usage: { input: number; output: number } | null;
  jevCost: number | null;
  plannerCost: number | null;
  providerCalls: number;
};
export type LaneReport = {
  lane: BenchmarkLane;
  cases: number;
  ran: number;
  skipped: number;
  correct: number;
  accuracy: number | null;
  bounded: number;
  fallback: number;
  errors: number;
  providerCalls: number;
  latencyMs: { p50: number | null; p95: number | null; mean: number | null };
  tokens: { input: number; output: number };
  // Cost is split because the two providers report differently: `jev` is the summed
  // Gateway-reported Jev cost (null when unknown or unused), `planner` is always null
  // here (the planner does not report cost), and `total` is only a number when BOTH
  // components are known. A Jev-only figure is therefore never reported as the total
  // pipeline cost — when the planner cost is unknown the total stays null (unknown).
  cost: { jev: number | null; planner: number | null; total: number | null };
  // Correctness split by how the answer was produced (Jev plan vs LLM fallback vs
  // deterministic rule), so a lane is never credited for the wrong mechanism.
  paths: Record<string, { ran: number; correct: number; bounded: number; fallback: number }>;
};
export type BenchmarkReport = {
  benchmarkVersion: string;
  mode: "dry_run" | "live";
  dataset: { cases: number; tune: number; holdout: number };
  budget: { maxRequests: number; used: number; exhausted: boolean };
  lanes: LaneReport[];
  // Cases where every requested lane produced a non-skipped result; only these are
  // directly comparable.
  paired: { cases: number; lanes: Record<string, { ran: number; correct: number; accuracy: number | null }> };
  results: BenchmarkRecord[];
  notes: string[];
};

export const JEV_BENCHMARK_VERSION = "jev-bmq-benchmark-2026-09-20.3";

// Lane B is exactly the runtime's enabled deterministic matcher; there is no second,
// disconnected comparator that could drift from the shipped rule.
export const deterministicBounded = matchExactBounded;

function scoreOutcome(expected: JevDatasetCase["expected"], outcome: BenchmarkOutcome, metric: string | null, period: string | null): boolean {
  if (outcome === "bounded") return expected.kind === "bounded" && metric === expected.metric && period === expected.period;
  if (outcome === "fallback") return expected.kind === "fallback";
  return false;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))];
}
function summarize(lane: BenchmarkLane, records: BenchmarkRecord[]): LaneReport {
  const ran = records.filter((record) => record.outcome !== "skipped");
  const scored = ran.filter((record) => record.outcome !== "error");
  // Every attempted case contributes its real wall-clock duration, including a failed
  // or timed-out provider attempt: an error must not vanish from the latency/failure
  // analysis and must never be reported as zero.
  const latencies = ran.map((record) => record.latencyMs).filter((value) => Number.isFinite(value) && value >= 0);
  const jevCosts = records.map((record) => record.jevCost).filter((value): value is number => typeof value === "number");
  const plannerCosts = records.map((record) => record.plannerCost).filter((value): value is number => typeof value === "number");
  const jevCost = jevCosts.length ? jevCosts.reduce((sum, value) => sum + value, 0) : null;
  const plannerCost = plannerCosts.length ? plannerCosts.reduce((sum, value) => sum + value, 0) : null;
  const paths: LaneReport["paths"] = {};
  for (const record of ran) {
    const entry = (paths[record.path] ??= { ran: 0, correct: 0, bounded: 0, fallback: 0 });
    entry.ran += 1;
    if (record.correct) entry.correct += 1;
    if (record.outcome === "bounded") entry.bounded += 1;
    if (record.outcome === "fallback") entry.fallback += 1;
  }
  return {
    lane,
    cases: records.length,
    ran: ran.length,
    skipped: records.filter((record) => record.outcome === "skipped").length,
    correct: scored.filter((record) => record.correct).length,
    accuracy: scored.length ? scored.filter((record) => record.correct).length / scored.length : null,
    bounded: ran.filter((record) => record.outcome === "bounded").length,
    fallback: ran.filter((record) => record.outcome === "fallback").length,
    errors: ran.filter((record) => record.outcome === "error").length,
    providerCalls: records.reduce((sum, record) => sum + record.providerCalls, 0),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null },
    tokens: ran.reduce((sum, record) => ({ input: sum.input + (record.usage?.input ?? 0), output: sum.output + (record.usage?.output ?? 0) }), { input: 0, output: 0 }),
    cost: { jev: jevCost, planner: plannerCost, total: jevCost !== null && plannerCost !== null ? jevCost + plannerCost : null },
    paths,
  };
}
function safeLimit(value: unknown): number {
  const requested = Number(value);
  return Number.isFinite(requested) ? Math.min(Math.max(1, Math.floor(requested)), BENCHMARK_HARD_MAX_REQUESTS) : BENCHMARK_DEFAULT_MAX_REQUESTS;
}

export function laneBRunner(): LaneRunner {
  return async (testCase) => {
    const started = Date.now();
    const match = matchExactBounded(testCase.question);
    return {
      outcome: match ? "bounded" : "fallback",
      path: match ? "exact_rule" : "none",
      metric: match?.metric ?? null,
      period: match?.time_range ?? null,
      reason: match ? null : "no_deterministic_match",
      latencyMs: Date.now() - started,
      providerMs: null,
      usage: null,
      jevCost: null,
      plannerCost: null,
    };
  };
}

// Lane orchestration + scoring. Pure: all provider access lives in the injected
// runners and the shared budget, so this function is testable offline.
export async function runJevBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const lanes = options.lanes ?? ["A", "B", "C"];
  const maxRequests = safeLimit(options.maxRequests);
  const live = options.enabled === true;
  const budget = new BenchmarkRequestBudget(maxRequests);
  const results: BenchmarkRecord[] = [];
  // Case-major: each case is attempted in every requested lane before moving on, so a
  // budget stop produces an explicit paired subset instead of a lane-biased sample.
  for (const testCase of options.cases) {
    for (const lane of lanes) {
      const runner = lane === "B" ? (options.runners?.B ?? laneBRunner()) : options.runners?.[lane];
      const base: BenchmarkRecord = {
        id: testCase.id, split: testCase.split, language: testCase.language, tags: testCase.tags,
        ...(options.includeQuestions ? { question: testCase.question } : {}),
        expected: testCase.expected, lane,
        outcome: "skipped", path: "none", metric: null, period: null, reason: null, correct: false,
        latencyMs: 0, providerMs: null, usage: null, jevCost: null, plannerCost: null, providerCalls: 0,
      };
      if (!runner) { results.push({ ...base, reason: "runner_unavailable" }); continue; }
      if (lane !== "B" && !live) { results.push({ ...base, reason: "paid_opt_in_required" }); continue; }
      // Fast path check; the authoritative enforcement is reserve() before dispatch.
      if (lane !== "B" && budget.exhausted) { results.push({ ...base, reason: "request_budget_exhausted" }); continue; }
      const before = budget.usedRequests;
      const attemptStarted = Date.now();
      let outcome: LaneOutcome;
      try {
        outcome = await runner(testCase, { budget });
      } catch (error) {
        if (error instanceof BenchmarkBudgetExhausted) {
          results.push({ ...base, reason: "request_budget_exhausted", latencyMs: Date.now() - attemptStarted, providerCalls: budget.usedRequests - before });
          continue;
        }
        // Never surface a raw runner/provider message in the sanitized report. The
        // real wall-clock duration of the failed attempt is kept so a failure/timeout
        // is visible in latency and is never reported as a zero-latency run.
        outcome = { outcome: "error", path: "none", metric: null, period: null, reason: "runner_error", latencyMs: Date.now() - attemptStarted, providerMs: null, usage: null, jevCost: null, plannerCost: null };
      }
      results.push({
        ...base,
        outcome: outcome.outcome, path: outcome.path, metric: outcome.metric, period: outcome.period, reason: outcome.reason,
        correct: scoreOutcome(testCase.expected, outcome.outcome, outcome.metric, outcome.period),
        latencyMs: outcome.latencyMs, providerMs: outcome.providerMs, usage: outcome.usage,
        jevCost: outcome.jevCost ?? null, plannerCost: outcome.plannerCost ?? null,
        // Actual provider requests are counted from the shared budget reservation.
        providerCalls: budget.usedRequests - before,
      });
    }
  }
  const laneReports = lanes.map((lane) => summarize(lane, results.filter((record) => record.lane === lane)));
  // A case is only directly comparable when EVERY requested lane produced a real,
  // non-skipped and non-error result. A budget stop or a failed lane therefore drops
  // the whole case, so every lane's paired denominator is exactly the same count and
  // an error can never be hidden from the paired accuracy.
  const pairedCases = options.cases.filter((testCase) => lanes.every((lane) => {
    const record = results.find((entry) => entry.id === testCase.id && entry.lane === lane);
    return record !== undefined && record.outcome !== "skipped" && record.outcome !== "error";
  }));
  const pairedLanes: BenchmarkReport["paired"]["lanes"] = {};
  for (const lane of lanes) {
    const records = results.filter((record) => record.lane === lane && pairedCases.some((testCase) => testCase.id === record.id));
    pairedLanes[lane] = { ran: records.length, correct: records.filter((record) => record.correct).length, accuracy: records.length ? records.filter((record) => record.correct).length / records.length : null };
  }
  return {
    benchmarkVersion: JEV_BENCHMARK_VERSION,
    mode: live ? "live" : "dry_run",
    dataset: { cases: options.cases.length, tune: options.cases.filter((entry) => entry.split === "tune").length, holdout: options.cases.filter((entry) => entry.split === "holdout").length },
    budget: { maxRequests, used: budget.usedRequests, exhausted: budget.exhausted },
    lanes: laneReports,
    paired: { cases: pairedCases.length, lanes: pairedLanes },
    results,
    notes: [
      live ? "Live mode: lane A and lane C made real paid provider calls." : "Dry run: no provider call was made; lanes A and C are skipped until BMQ_JEV_BENCH_ENABLED=true.",
      "Lane latency is server-side warehouse-call wall-clock in a synthetic stub, not browser end-to-end latency. Every attempt, including a failed or timed-out provider call, contributes its real elapsed time and is never reported as zero.",
      "Cost is split: cost.jev is the summed Gateway-reported Jev cost (null when unknown or unused) and cost.planner is null because the planner does not report per-request cost. cost.total is only a number when both components are known, so a Jev-only figure is never presented as the total pipeline cost.",
      "Synthetic-warehouse/subset test only: the catalog is a stub that mirrors the real BMQ metric units (count for dealer order count and kiosk report count, VND for dealer ordered value and controlled revenue); no real BMQ customer, product or financial data is present and no production or browser end-to-end performance is claimed.",
      "Lane C is scored on the paired subset and split by path (jev vs planner vs exact_rule) so a fallback answer is never credited as a Jev plan. A case is paired only when every requested lane produced a non-skipped, non-error result.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Live runners. Lane A = existing pipeline (Jev off). Lane C = Jev-gated pipeline.
// Both use a synthetic, non-production warehouse stub so no real data is read, and a
// budget-gated fetch that reserves one request before every provider dispatch.
// ---------------------------------------------------------------------------
// Synthetic stub catalog with the REAL BMQ operational descriptors and units, copied
// from sme-data-platform/src/sme_platform/bmq_semantic.py (`dealer_order_count`,
// `dealer_order_value`, `kiosk_report_count`) plus the controlled-revenue ledger
// descriptor from bmq_business.py. The three operational metrics are non-test
// SUBMITTED dealer orders by submitted date in Vietnam time (count / VND) and
// SUBMITTED kiosk reports by report_date (count); none of them is a generic count.
// controlled_revenue is approved gross revenue in VND and is never added to the
// operational ledgers. This is still a synthetic stub, not a live warehouse read.
export const BENCHMARK_CATALOG = {
  metrics: {
    dealer_order_count: {
      label: "Dealer order count", label_vi: "Số đơn đại lý", unit: "count",
      description: "Non-test submitted dealer orders, by submitted_at in Vietnam time; not purchase orders or completed sales.",
      description_vi: "Đơn đại lý đã gửi, loại đơn test, theo ngày gửi giờ Việt Nam; không phải PO hay số đơn đã giao.",
    },
    dealer_order_value: {
      label: "Dealer ordered value", label_vi: "Giá trị đơn đặt đại lý", unit: "VND",
      description: "SUM total_amount_vnd of non-test submitted orders, by Vietnam submission date; not revenue, collections or receivables.",
      description_vi: "Tổng total_amount_vnd của đơn đã gửi, loại test, theo ngày gửi; không phải doanh thu, tiền thu hay công nợ.",
    },
    kiosk_report_count: {
      label: "Submitted kiosk reports", label_vi: "Số báo cáo điểm bán đã gửi", unit: "count",
      description: "Count submitted kiosk_daily_reports by report_date; not customer orders or staff attendance.",
      description_vi: "Đếm báo cáo điểm bán trạng thái submitted theo report_date; không phải đơn khách hay chấm công.",
    },
    controlled_revenue: {
      label: "Controlled revenue", label_vi: "Doanh thu đã kiểm soát", unit: "VND",
      description: "Sum approved gross_revenue joined to controlled/trusted source documents. Not net or audited revenue. Never add dealer orders or kiosk reports to this ledger.",
      description_vi: "Tổng gross_revenue của dòng approved, chứng từ controlled/trusted; không phải doanh thu thuần hay đã kiểm toán. Không cộng thêm đơn đại lý hoặc báo cáo điểm bán.",
    },
  },
  dimensions: { date: "date" },
  version: "jev-benchmark-stub",
};
function benchmarkWarehouseCall(): WarehouseCall {
  return async (path: string, body?: any) => {
    if (path === "/v1/semantic") return structuredClone(BENCHMARK_CATALOG);
    if (path === "/v1/query") return { rows: [{ [body.metric]: "1", currency: "VND" }], source: "benchmark-synthetic", source_observed_at: "2026-09-20T00:00:00Z", snapshot_id: "benchmark", definition: "synthetic benchmark fixture", period: { start: "2026-09-01", end: "2026-09-30" } };
    if (path === "/v1/knowledge/search") return { chunks: [] };
    return { status: "ok", rows: [], line_count: 0, total_amount: "0", statuses: [], source: "benchmark-synthetic", source_observed_at: "2026-09-20T00:00:00Z", snapshot_id: "benchmark", semantic_version: "benchmark" };
  };
}
function gatedFetch(budget: BenchmarkRequestBudget, real: typeof fetch): typeof fetch {
  return (async (input: any, init?: any) => {
    if (!budget.reserve()) throw new BenchmarkBudgetExhausted();
    return real(input, init);
  }) as typeof fetch;
}
function runnerFrom(config: { call: WarehouseCall; model: ModelCall; jev?: JevOptions }): LaneRunner {
  return async (testCase) => {
    const started = Date.now();
    const signal = AbortSignal.timeout(20000);
    const result: any = await runWarehouse(
      { language: testCase.language, question: testCase.question, page: { route: "/", label: "Jev benchmark" }, history: [] },
      config.call, config.model, signal, undefined, config.jev ? { jev: config.jev } : {},
    );
    const telemetry = result?.provenance?.jev ?? null;
    const query = Array.isArray(result?.provenance?.queries) && result.provenance.queries.length === 1 ? result.provenance.queries[0] : null;
    const bounded = result?.provenance?.lane === "semantic" && query && typeof query.metric === "string" && typeof query.time_range === "string" && !String(query.time_range).includes("/");
    const path: BenchmarkPath = telemetry?.decided ? "jev"
      : telemetry?.screen === "exact_rule" ? "exact_rule"
      : (result?.provenance?.modelCalls ?? 0) > 0 ? "planner"
      : bounded ? "deterministic" : "none";
    return {
      outcome: bounded ? "bounded" : "fallback",
      path,
      metric: bounded ? query.metric : null,
      period: bounded ? query.time_range : null,
      reason: bounded ? null : telemetry?.fallback ?? result?.provenance?.lane ?? "unknown",
      latencyMs: Date.now() - started,
      providerMs: telemetry?.timings?.evaluateMs ?? null,
      usage: {
        input: (telemetry?.usage?.input ?? 0) + (result?.provenance?.usage?.input ?? 0),
        output: (telemetry?.usage?.output ?? 0) + (result?.provenance?.usage?.output ?? 0),
      },
      // Jev cost is Gateway-reported; the planner (OpenAI Responses) reports no cost
      // here, so the total pipeline cost stays unknown rather than being the Jev part.
      jevCost: telemetry?.cost ?? null,
      plannerCost: null,
      jevDecided: Boolean(telemetry?.decided),
    };
  };
}
export function createWarehouseRunners(config: { openAIKey: string; gatewayKey: string; fetcher?: typeof fetch; timeoutMs?: number }): { A: LaneRunner; C: LaneRunner } {
  const realFetch = config.fetcher ?? fetch;
  return {
    A: async (testCase, { budget }) => runnerFrom({
      call: benchmarkWarehouseCall(),
      model: openAIModel(config.openAIKey, gatedFetch(budget, realFetch)),
    })(testCase, { budget }),
    C: async (testCase, { budget }) => runnerFrom({
      call: benchmarkWarehouseCall(),
      model: openAIModel(config.openAIKey, gatedFetch(budget, realFetch)),
      jev: { enabled: () => true, apiKey: () => config.gatewayKey, fetcher: gatedFetch(budget, realFetch), timeoutMs: config.timeoutMs, circuit: createJevCircuit() },
    })(testCase, { budget }),
  };
}

export type BenchmarkEnvConfig = { enabled: boolean; split: "tune" | "holdout" | "both"; lanes: BenchmarkLane[]; maxRequests: number; openAIKey: string; gatewayKey: string };
export function benchmarkConfigFromEnv(env: Record<string, string | undefined>): BenchmarkEnvConfig {
  const requested = (env.BMQ_JEV_BENCH_SPLIT ?? "tune") as BenchmarkEnvConfig["split"];
  const split: BenchmarkEnvConfig["split"] = requested === "holdout" || requested === "both" ? requested : "tune";
  const lanes = (env.BMQ_JEV_BENCH_LANES ?? "A,B,C").split(",").map((entry) => entry.trim().toUpperCase()).filter((entry): entry is BenchmarkLane => entry === "A" || entry === "B" || entry === "C");
  return {
    enabled: env.BMQ_JEV_BENCH_ENABLED === "true",
    split,
    lanes: lanes.length ? lanes : ["A", "B", "C"],
    maxRequests: safeLimit(env.BMQ_JEV_BENCH_MAX_REQUESTS),
    openAIKey: env.OPENAI_API_KEY ?? "",
    gatewayKey: env.AI_GATEWAY_API_KEY ?? "",
  };
}
export async function main(env: Record<string, string | undefined>, log: (line: string) => void): Promise<BenchmarkReport> {
  const config = benchmarkConfigFromEnv(env);
  const cases = casesForSplit(config.split);
  const runners = config.enabled ? createWarehouseRunners({ openAIKey: config.openAIKey, gatewayKey: config.gatewayKey }) : {};
  const report = await runJevBenchmark({ cases, lanes: config.lanes, enabled: config.enabled, runners, maxRequests: config.maxRequests, includeQuestions: true });
  log(JSON.stringify(report, null, 2));
  return report;
}
