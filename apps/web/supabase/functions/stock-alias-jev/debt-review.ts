// Jev debt review for the robot order desk (mode "debt_review").
//
// For one supplier it reads public.get_supplier_debt_candidates through the
// service client, then asks Jev one question per still-unmarked old document:
// "Phiếu này đã được chi ngoài hệ thống chưa?" The answer is one of
// settled_outside / real_debt / unsure with a probability. Results are written
// with public.set_supplier_debt_mark_ai (service_role only), which never
// overwrites a learned / manual mark.
//
// Transport is reused from jev.ts (same gateway contract, strict response
// validation and circuit breaker); the batching / quota helper is reused from
// new-items.ts so the shared 600 calls/day counter is charged the same way.

import {
  createJevCircuit,
  finiteUnit,
  gatewayCost,
  isRecord,
  JEV_ENDPOINT,
  JEV_MAX_TIMEOUT_MS,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JevError,
  validateUsage,
  type JevCircuit,
  type JevUsage,
} from "./jev.ts";
import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsOutcome,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";
import { runQuestionsWithQuota } from "./new-items.ts";

export const DEBT_REVIEW_PROMPT_VERSION = "jev-debt-review-2026-11-01.1";
// Bump when the question or criteria below change.
export const DEBT_REVIEW_BATCH_SIZE = 10;
export const DEBT_REVIEW_MAX_CONCURRENCY = 4;

export const DEBT_MARK_OPTIONS = ["settled_outside", "real_debt", "unsure"] as const;
export type DebtMark = (typeof DEBT_MARK_OPTIONS)[number];

export const DEBT_REVIEW_INSTRUCTIONS =
  "Phiếu công nợ cũ `debt` này đã được trả tiền ngoài hệ thống chưa? "
  + "Đọc kỹ số tuổi nợ, việc đã có phiếu nhập kho chưa, các lần trả gần đây "
  + "của nhà cung cấp và số phiếu trình chi gần nhất để đoán.";

export const DEBT_REVIEW_CRITERIA: Record<DebtMark, string> = {
  settled_outside:
    "Nhiều khả năng đã trả tiền ngoài hệ thống (trả tay / chuyển khoản riêng), "
    + "app chỉ còn giữ công nợ cũ chưa đối chiếu.",
  real_debt: "Còn nợ thật, chưa trả cho nhà cung cấp.",
  unsure: "Không đủ dữ kiện để kết luận phiếu này đã trả ngoài hay còn nợ thật.",
};

export interface DebtJevState {
  debt: {
    kind: string;
    number: string;
    amount: number;
    age_days: number;
    has_receipt: boolean;
    supplier_paid_90d: number;
    supplier_median_lag_days: number | null;
    newer_paid_exists: boolean;
    last_submission_number: string | null;
  };
}

export function debtJevQuestions() {
  return {
    debt_mark: {
      type: "choice",
      instructions: DEBT_REVIEW_INSTRUCTIONS,
      criteria: DEBT_REVIEW_CRITERIA,
    },
  };
}

export interface DebtJevEvaluation {
  mark: DebtMark | null;
  probability: number;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered ('openai' or the Jev fallback). */
  provider?: DecisionsProvider;
}

export interface DebtJevEvaluatorParams {
  state: DebtJevState;
  signal: AbortSignal;
  deadlineAt?: number;
}

export type DebtJevEvaluator = (params: DebtJevEvaluatorParams) => Promise<DebtJevEvaluation>;

function validateDebtMarkAnswer(body: Record<string, unknown>): { mark: DebtMark; probability: number } {
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "debt_mark")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const answer = answers.debt_mark;
  if (!isRecord(answer) || answer.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (typeof answer.choice !== "string" || !DEBT_MARK_OPTIONS.includes(answer.choice as DebtMark)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (!isRecord(answer.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = answer.probabilities;
  if (
    Object.keys(probabilities).length !== DEBT_MARK_OPTIONS.length
    || DEBT_MARK_OPTIONS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of DEBT_MARK_OPTIONS) {
    if (!finiteUnit(probabilities[option])) throw new JevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const mark = answer.choice as DebtMark;
  const chosen = probabilities[mark] as number;
  if (DEBT_MARK_OPTIONS.some((option) => option !== mark && (probabilities[option] as number) >= chosen)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);
  return { mark, probability: chosen };
}

export function validateDebtJevResponse(body: unknown): DebtJevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);
  const { mark, probability } = validateDebtMarkAnswer(body);
  return { mark, probability, usage, cost };
}

export interface DebtJevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export function createDebtJevEvaluator(config: DebtJevConfig): DebtJevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ state, signal, deadlineAt }): Promise<DebtJevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: debtJevQuestions(),
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    };
    let outcome: DecisionsOutcome;
    try {
      outcome = await evaluateDecisions(requestBody, {
        fetcher,
        gatewayUrl: JEV_ENDPOINT,
        gatewayKey: apiKey,
        timeoutMs: budget,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      circuit.recordFailure();
      const code = decisionsFailureCode(error);
      throw new JevError(
        code,
        code === "jev_timeout" ? 504 : code === "jev_invalid_response" ? 502 : 503,
        error instanceof DecisionsError ? error.detail : null,
      );
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      circuit.recordFailure();
      const detail = outcome.body == null
        ? `HTTP ${outcome.status}`
        : `HTTP ${outcome.status}: ${String(outcome.body).replace(/\s+/g, " ").slice(0, 300)}`;
      if (outcome.status === 429) throw new JevError("jev_rate_limited", 429, detail);
      throw new JevError("jev_http_error", 502, detail);
    }
    let evaluation: DebtJevEvaluation;
    try {
      evaluation = { ...validateDebtJevResponse(outcome.body), provider: outcome.provider };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}

// ---------------------------------------------------------------------------
// Candidate / mark shapes read from the RPCs
// ---------------------------------------------------------------------------

export interface SupplierDebtCandidateRow {
  kind: "pr" | "po";
  id: string;
  number: string | null;
  title?: string | null;
  doc_date: string;
  amount: number | null;
  remaining: number | null;
  purchase_order_id?: string | null;
  po_number?: string | null;
  goods_receipt_id?: string | null;
  last_submission_number?: string | null;
  age_days?: number | null;
  has_receipt?: boolean | null;
  mark?: string | null;
  mark_source?: string | null;
  probability?: number | null;
  before_cutover?: boolean | null;
}

export interface SupplierDebtCandidates {
  supplier_id: string;
  cutover: { kind: "pr" | "po"; id: string; number: string | null; start_date: string } | null;
  stats: {
    paid_90d?: number | null;
    median_lag_days?: number | null;
    /** Extra support field for newer_paid_exists; not part of the C contract. */
    last_paid_date?: string | null;
  };
  rows: SupplierDebtCandidateRow[];
}

export interface DebtMarkWriteRow {
  kind: "pr" | "po";
  id: string;
  mark: DebtMark;
  probability: number;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasLearnedOrManualMark(row: SupplierDebtCandidateRow): boolean {
  return row.mark_source === "learned" || row.mark_source === "manual";
}

/**
 * The facts Jev sees for one candidate row. `newer_paid_exists` is true when the
 * supplier has a paid request dated after this row.
 */
export function buildDebtJevState(
  row: SupplierDebtCandidateRow,
  candidates: SupplierDebtCandidates,
): DebtJevState {
  const stats = candidates.stats ?? {};
  const lastPaidDate = stats.last_paid_date ?? null;
  return {
    debt: {
      kind: row.kind,
      number: row.number ?? row.po_number ?? "",
      amount: asNumber(row.amount),
      age_days: asNumber(row.age_days),
      has_receipt: row.has_receipt === true,
      supplier_paid_90d: asNumber(stats.paid_90d),
      supplier_median_lag_days: stats.median_lag_days == null ? null : asNumber(stats.median_lag_days),
      newer_paid_exists: Boolean(lastPaidDate && row.doc_date && row.doc_date < lastPaidDate),
      last_submission_number: row.last_submission_number ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Service-client store: the only two RPCs this mode needs
// ---------------------------------------------------------------------------

export interface DebtReviewRpcClient {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}

export interface DebtReviewStore {
  getCandidates: (supplierId: string) => Promise<SupplierDebtCandidates>;
  writeMarks: (supplierId: string, rows: DebtMarkWriteRow[]) => Promise<void>;
}

export function createDebtReviewStore(client: DebtReviewRpcClient): DebtReviewStore {
  return {
    getCandidates: async (supplierId: string): Promise<SupplierDebtCandidates> => {
      const { data, error } = await client.rpc("get_supplier_debt_candidates", {
        p_supplier_id: supplierId,
      });
      if (error) throw new JevError("jev_unavailable", 503);
      return (data ?? { supplier_id: supplierId, cutover: null, stats: {}, rows: [] }) as SupplierDebtCandidates;
    },
    writeMarks: async (supplierId: string, rows: DebtMarkWriteRow[]): Promise<void> => {
      if (rows.length === 0) return;
      const { error } = await client.rpc("set_supplier_debt_mark_ai", {
        p_supplier_id: supplierId,
        p_rows: rows,
      });
      if (error) throw new JevError("jev_unavailable", 503);
    },
  };
}

// ---------------------------------------------------------------------------
// The mode handler
// ---------------------------------------------------------------------------

export interface DebtReviewUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface DebtReviewDeps {
  evaluator: () => DebtJevEvaluator | null;
  getCandidates: (supplierId: string) => Promise<SupplierDebtCandidates>;
  writeMarks: (supplierId: string, rows: DebtMarkWriteRow[]) => Promise<void>;
  incrementUsage: (usageDate: string, calls: number, cost: number) => Promise<void>;
}

export interface DebtReviewContext {
  signal: AbortSignal;
  deadlineAt: number;
  usageDate: string;
  remainingQuota: number;
}

export interface DebtReviewResult {
  supplier_id: string;
  evaluated: number;
  marked: number;
  stopped: "quota" | null;
}

function evaluationCost(evaluation: DebtJevEvaluation | null): number {
  return evaluation?.cost != null && Number.isFinite(evaluation.cost) ? evaluation.cost : 0;
}

/**
 * Evaluate every candidate row that has no learned / manual mark, in batches of
 * at most DEBT_REVIEW_BATCH_SIZE, charging the shared daily Jev quota per call
 * and stopping cleanly when the quota runs out. Writes go only through
 * set_supplier_debt_mark_ai.
 */
export async function runDebtReview(
  deps: DebtReviewDeps,
  supplierId: string,
  context: DebtReviewContext,
): Promise<DebtReviewResult> {
  const candidates = await deps.getCandidates(supplierId);
  const rows = Array.isArray(candidates?.rows) ? candidates.rows : [];
  const eligible = rows.filter((row) => !hasLearnedOrManualMark(row));

  const evaluator = deps.evaluator();
  if (!evaluator) throw new JevError("jev_unconfigured", 503);

  let evaluated = 0;
  let marked = 0;
  let stopped: "quota" | null = null;

  for (let from = 0; from < eligible.length; from += DEBT_REVIEW_BATCH_SIZE) {
    if (evaluated >= context.remainingQuota) {
      stopped = "quota";
      break;
    }
    const batch = eligible.slice(from, from + DEBT_REVIEW_BATCH_SIZE);
    const run = await runQuestionsWithQuota<SupplierDebtCandidateRow, DebtJevEvaluation>({
      items: batch,
      remaining: context.remainingQuota - evaluated,
      concurrency: DEBT_REVIEW_MAX_CONCURRENCY,
      ask: async (row) => evaluator({
        state: buildDebtJevState(row, candidates),
        signal: context.signal,
        deadlineAt: context.deadlineAt,
      }),
      onAnswered: async (_row, result) => {
        await deps.incrementUsage(context.usageDate, 1, evaluationCost(result));
      },
    });

    const writes: DebtMarkWriteRow[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const result = run.results[index];
      if (!result || result.mark === null) continue;
      writes.push({
        kind: batch[index].kind,
        id: batch[index].id,
        mark: result.mark,
        probability: result.probability,
      });
    }
    if (writes.length > 0) {
      await deps.writeMarks(supplierId, writes);
      marked += writes.length;
    }
    evaluated += run.asked;
    if (run.stopped) {
      stopped = "quota";
      break;
    }
  }

  return { supplier_id: supplierId, evaluated, marked, stopped };
}
