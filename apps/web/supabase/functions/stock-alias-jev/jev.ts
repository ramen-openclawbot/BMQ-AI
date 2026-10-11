// Server-side Jev evaluator for stock-material alias learning (Giai đoạn 2).
//
// Self-contained on purpose: it does not import across functions and holds no
// database client. The transport copies the verified Vercel AI Gateway contract
// already used by stock-catalog-jev/jev.ts: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and one
// deadline per call with no retry. The model only ranks a candidate list code
// already built; it never selects its own candidates.
//
// Contract reference (verified): https://docs.typesafe.ai/api.md and
// https://docs.typesafe.ai/primitives/choice.md.

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the question or the criteria below change.
export const JEV_PROMPT_VERSION = "jev-material-alias-2026-10-16.1";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

/** Choice option used when no candidate matches the invoice line. */
export const NONE_OPTION = "none";

export interface MaterialAliasCandidate {
  id: string;
  name: string;
  unit: string;
}

export interface MatchLine {
  name: string;
  unit: string | null;
  supplier: string | null;
}

/** State sent to Jev: the invoice line and the code-built candidate list. */
export interface MatchJevState {
  line: MatchLine;
  candidates: MaterialAliasCandidate[];
}

export function matchInstructions(): string {
  return "Dòng hóa đơn `line` (tên, đơn vị, nhà cung cấp) là mặt hàng nào trong `candidates`, hoặc không có?";
}

/** One description per candidate id plus the explicit "none" option. */
export function matchCriteria(candidates: readonly MaterialAliasCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.id] = `${candidate.name} (${candidate.unit})`;
  }
  criteria[NONE_OPTION] = "Không có mặt hàng nào trong danh sách phù hợp với dòng hóa đơn.";
  return criteria;
}

export function matchOptions(candidates: readonly MaterialAliasCandidate[]): string[] {
  return [...candidates.map((candidate) => candidate.id), NONE_OPTION];
}

export function jevQuestions(state: MatchJevState) {
  return {
    match: {
      type: "choice",
      instructions: matchInstructions(),
      criteria: matchCriteria(state.candidates),
    },
  };
}

// ---------------------------------------------------------------------------
// Mirror of public.normalize_stock_item_name / material_alias_candidates_hash
// ---------------------------------------------------------------------------

const DIACRITICS_FROM =
  "aáàảãạăắằẳẵặâấầẩẫậeéèẻẽẹêếềểễệiíìỉĩịoóòỏõọôốồổỗộơớờởỡợuúùủũụưứừửữựyýỳỷỹỵdđ";
const DIACRITICS_TO =
  "aaaaaaaaaaaaaaaaaaeeeeeeeeeeeeiiiiiioooooooooooooooooouuuuuuuuuuuuyyyyyydd";
const DIACRITIC_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const from = Array.from(DIACRITICS_FROM);
  const to = Array.from(DIACRITICS_TO);
  for (let i = 0; i < from.length; i += 1) map.set(from[i], to[i] ?? from[i]);
  return map;
})();

/** Mirror of `public.normalize_stock_item_name` (same bytes as the SQL). */
export function normalizeItemName(name: string | null | undefined): string {
  let mapped = "";
  for (const char of (name ?? "").toLowerCase()) mapped += DIACRITIC_MAP.get(char) ?? char;
  return mapped
    .replace(/\s+/g, " ")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/\s*(ngay\s*[0-9]+|[0-9]+)\s*$/, "")
    .trim();
}

/**
 * Canonical cache key for one candidate set. Mirrors
 * `public.material_alias_candidates_hash`: sorted ids joined by '|'.
 */
export function candidatesHash(ids: readonly string[]): string {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim() !== ""))]
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// Pack reader (same regex as public.q7_pack_from_name / purchase-forecast.ts)
// ---------------------------------------------------------------------------

export interface ParsedPack {
  label: string;
  baseQty: number | null;
  baseUnit: string | null;
  multiplier: number;
}

export const PACK_PARSE_TEST_CASES: ReadonlyArray<readonly [string, number | null, string | null, number]> = [
  ["Bột mì (25kg)", 25, "kg", 1],
  ["Dầu ăn 5L x 4 chai", 5, "l", 4],
  ["Nước tương x 6 chai", 6, "chai", 1],
];

export function parsePackFromName(name: string | null | undefined): ParsedPack | null {
  const text = String(name ?? "");
  if (!text.trim()) return null;
  const match = text.match(
    /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gram|l|lit|ml|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi)?\s*(?:x\s*(\d+))?/i,
  );
  if (!match) return null;
  const baseQty = match[1] !== undefined ? Number(match[1].replace(",", ".")) : null;
  const rawUnit = match[2] ? match[2].toLowerCase() : null;
  const multiplier = match[3] !== undefined ? Number(match[3]) : 1;
  if ((baseQty === null || !Number.isFinite(baseQty)) && multiplier <= 1) return null;
  return { label: text.trim(), baseQty, baseUnit: rawUnit, multiplier };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JevUsage = { input: number; output: number };

export interface JevMatchEvaluation {
  /** Candidate id, or null when the model picked "none". */
  choice: string | null;
  probability: number;
  confidence: number | null;
  usage: JevUsage;
  cost: number | null;
}

export interface JevEvaluatorParams {
  state: MatchJevState;
  signal: AbortSignal;
  deadlineAt?: number;
}

export type JevEvaluator = (params: JevEvaluatorParams) => Promise<JevMatchEvaluation>;

export interface JevCircuit {
  canAttempt: () => boolean;
  isOpen: () => boolean;
  recordSuccess: () => void;
  recordFailure: () => void;
  reset: () => void;
}

export class JevError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly detail: string | null = null) {
    super(code);
    this.name = "JevError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function gatewayCost(metadata: unknown): number | null {
  if (!isRecord(metadata) || !isRecord(metadata.gateway)) return null;
  const raw = metadata.gateway.cost;
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function validateUsage(body: Record<string, unknown>): JevUsage {
  if (!isRecord(body.usage)) throw new JevError("jev_invalid_response", 502);
  const input = body.usage.inputTokens;
  const output = body.usage.outputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) throw new JevError("jev_invalid_response", 502);
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) throw new JevError("jev_invalid_response", 502);
  return { input, output };
}

/**
 * Strict validation of the single 'match' choice question. The option set is
 * supplied by code (`allowed` = candidate ids + "none"), so an unknown option,
 * a missing/extra probability, a tied top choice or a non-normalised
 * distribution are all refused.
 */
export function validateJevResponse(allowed: readonly string[], body: unknown): JevMatchEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (allowed.length < 2 || !allowed.includes(NONE_OPTION)) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "match")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const choice = answers.match;
  if (!isRecord(choice) || choice.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(choice)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(choice, "confidence") && !finiteUnit(choice.confidence)) throw new JevError("jev_invalid_response", 502);
  if (typeof choice.choice !== "string" || !allowed.includes(choice.choice)) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(choice.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = choice.probabilities;
  if (
    Object.keys(probabilities).length !== allowed.length
    || allowed.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of allowed) {
    if (!finiteUnit(probabilities[option])) throw new JevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const chosen = choice.choice as string;
  const chosenProbability = probabilities[chosen] as number;
  if (allowed.some((option) => option !== chosen && (probabilities[option] as number) >= chosenProbability)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);
  return {
    choice: chosen === NONE_OPTION ? null : chosen,
    probability: chosenProbability,
    confidence: Object.hasOwn(choice, "confidence") ? (choice.confidence as number) : null,
    usage,
    cost,
  };
}

async function readBoundedBody(
  response: Response,
  combined: AbortSignal,
  parent: AbortSignal,
  deadline: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new JevError("jev_invalid_response", 502);
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* already released */ } };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Jev request aborted", "AbortError"));
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const read = reader.read();
      read.catch(() => undefined);
      const part = await Promise.race([read, aborted]);
      if (part.done) break;
      size += part.value.length;
      if (size > JEV_BODY_LIMIT) { cancel(); throw new JevError("jev_invalid_response", 502); }
      chunks.push(part.value);
    }
  } catch (error) {
    cancel();
    if (parent.aborted) throw error;
    if (deadline.aborted) throw new JevError("jev_timeout", 504);
    if (error instanceof JevError) throw error;
    throw new JevError("jev_unavailable", 503);
  } finally {
    if (onAbort) combined.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* outstanding read handled by cancel() */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new JevError("jev_invalid_response", 502); }
}

export interface JevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export function createJevCircuit(options: { threshold?: number; cooldownMs?: number; now?: () => number } = {}): JevCircuit {
  const threshold = options.threshold ?? JEV_CIRCUIT_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? JEV_CIRCUIT_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  let failures = 0, openUntil = 0;
  return {
    canAttempt: () => openUntil <= now(),
    isOpen: () => openUntil > now(),
    recordSuccess: () => { failures = 0; openUntil = 0; },
    recordFailure: () => { failures += 1; if (failures >= threshold) openUntil = now() + cooldownMs; },
    reset: () => { failures = 0; openUntil = 0; },
  };
}

export function createJevEvaluator(config: JevConfig): JevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ state, signal, deadlineAt }): Promise<JevMatchEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const allowed = matchOptions(state.candidates);
    const body = JSON.stringify({
      model: JEV_MODEL,
      state,
      questions: jevQuestions(state),
      // Server-side key only; no caller bearer token is sent to the provider.
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    });
    const deadline = AbortSignal.timeout(budget);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await fetcher(JEV_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch {
      signal.throwIfAborted();
      circuit.recordFailure();
      throw new JevError(deadline.aborted ? "jev_timeout" : "jev_unavailable", deadline.aborted ? 504 : 503);
    }
    if (!response.ok) {
      circuit.recordFailure();
      let detail: string | null = null;
      try {
        detail = `HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 300)}`;
      } catch {
        detail = `HTTP ${response.status}`;
      }
      if (response.status === 429) throw new JevError("jev_rate_limited", 429, detail);
      throw new JevError("jev_http_error", 502, detail);
    }
    const parsed = await readBoundedBody(response, combined, signal, deadline);
    let evaluation: JevMatchEvaluation;
    try {
      evaluation = validateJevResponse(allowed, parsed);
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
