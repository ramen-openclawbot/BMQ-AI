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
export const JEV_PROMPT_VERSION = "jev-material-alias-2026-10-20.1";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

/** Choice option used when no candidate matches the invoice line. */
export const NONE_OPTION = "none";

/** Second choice question: goods to receive, or a non-goods VAT / fee / service line. */
export const LINE_TYPE_GOODS = "goods";
export const LINE_TYPE_NON_GOODS = "non_goods";
export const LINE_TYPE_OPTIONS = [LINE_TYPE_GOODS, LINE_TYPE_NON_GOODS] as const;
export type JevLineType = (typeof LINE_TYPE_OPTIONS)[number];

export interface MaterialAliasCandidate {
  id: string;
  name: string;
  unit: string;
  /** Deterministic matcher reason ('name_exact', 'name_contains', 'token'). */
  reason?: string;
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

/** Short choice key for the candidate at `index` (0-based): c1, c2, … */
export function matchOptionKey(index: number): string {
  return `c${index + 1}`;
}

/** One description per candidate, keyed c1..cN, plus the explicit "none" option. */
export function matchCriteria(candidates: readonly MaterialAliasCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  candidates.forEach((candidate, index) => {
    criteria[matchOptionKey(index)] = `${candidate.name} (${candidate.unit})`;
  });
  criteria[NONE_OPTION] = "Không có mặt hàng nào trong danh sách phù hợp với dòng hóa đơn.";
  return criteria;
}

export function matchOptions(candidates: readonly MaterialAliasCandidate[]): string[] {
  return [...candidates.map((_candidate, index) => matchOptionKey(index)), NONE_OPTION];
}

/**
 * Map a short Jev choice key ("c1".."cN") back to the candidate id. A null or
 * "none" choice, or an out-of-range key, maps to null.
 */
export function candidateIdFromChoice(
  candidates: readonly MaterialAliasCandidate[],
  choice: string | null,
): string | null {
  if (choice === null || choice === NONE_OPTION) return null;
  const match = /^c(\d+)$/.exec(choice);
  if (!match) return null;
  const candidate = candidates[Number(match[1]) - 1];
  return candidate ? candidate.id : null;
}

/**
 * Vietnamese instructions + the two fixed options for the second question. A
 * line that is not goods (VAT, tax, shipping / delivery fee, a service or a
 * discount) must never be received into stock.
 */
export function lineTypeInstructions(): string {
  return "Dòng hóa đơn `line` là hàng hóa / nguyên vật liệu phải nhập kho, hay là dòng không nhập kho (VAT, thuế, phí vận chuyển, phí giao hàng, dịch vụ, chiết khấu)?";
}

export function lineTypeCriteria(): Record<string, string> {
  return {
    [LINE_TYPE_GOODS]: "Hàng hóa, nguyên vật liệu, bao bì, vật tư mua về phải nhập kho.",
    [LINE_TYPE_NON_GOODS]: "VAT, thuế, phí vận chuyển, phí giao hàng, dịch vụ, chiết khấu, không nhập kho.",
  };
}

export function lineTypeOptions(): JevLineType[] {
  return [...LINE_TYPE_OPTIONS];
}

export function jevQuestions(state: MatchJevState) {
  return {
    match: {
      type: "choice",
      instructions: matchInstructions(),
      criteria: matchCriteria(state.candidates),
    },
    // Sent together with `match` in the same evaluation call.
    line_type: {
      type: "choice",
      instructions: lineTypeInstructions(),
      criteria: lineTypeCriteria(),
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
// Fixed non-stock rule (mirror of public.stock_line_auto_non_stock)
// ---------------------------------------------------------------------------

export type AutoNonStockReason = "vat" | "fee" | "service";

/**
 * Shared case table (same bytes as the SQL comment table and the smoke test):
 * a rule name maps to 'vat' / 'fee' / 'service' or null for a real material.
 */
export const STOCK_LINE_AUTO_NON_STOCK_TEST_CASES: ReadonlyArray<
  readonly [string, AutoNonStockReason | null]
> = [
  ["Thuế VAT 8%", "vat"],
  ["VAT", "vat"],
  ["Thuế GTGT", "vat"],
  ["Phí vận chuyển", "fee"],
  ["Phụ phí giao hàng", "fee"],
  ["Cước ship nội thành", "fee"],
  ["Vận chuyển hàng", "fee"],
  ["Xử lý côn trùng", "service"],
  ["Phí phân tích mẫu", "service"],
  ["Thuê máy", "service"],
  ["Tỏi phi", null],
  ["Bánh mì lớn 17", null],
  ["Phô mai Dairymont", null],
  ["Ship hàng", "fee"],
  ["Cước Rửa Chén TBP x 4 Miếng", null],
  ["Cước điện thoại_0966998998", "fee"],
  ["Thuê nhà Q.7 T9/26", "service"],
];

const VAT_TOKENS = [" vat ", " thue gtgt ", " thue vat ", " gtgt "];
const FEE_TOKENS = [
  " phi van chuyen ",
  " phi giao hang ",
  " phu phi ",
  " phi ship ",
  " cuoc van chuyen ",
  " cuoc ship ",
  " cuoc giao hang ",
  " cuoc dien thoai",
  " cuoc dau so",
  " cuoc internet",
  " van chuyen ",
  " giao hang ",
  " ship ",
];
const SERVICE_TOKENS = [
  " dich vu ",
  " xu ly con trung ",
  " phan tich mau ",
  " thue may ",
  " bao tri ",
  " sua chua ",
  " chiet khau ",
];

/** Mirror of `public.stock_line_auto_non_stock` (same bytes as the SQL). */
export function autoNonStockReason(name: string | null | undefined): AutoNonStockReason | null {
  const normalized = ` ${normalizeItemName(name)} `;
  // Rent is a service even though it starts with "thue" and carries a month number.
  if (normalized.startsWith(" thue nha ") || normalized.includes(" thue mat bang ") || normalized.includes(" tien nha ")) {
    return "service";
  }
  if (
    VAT_TOKENS.some((token) => normalized.includes(token))
    || (normalized.startsWith(" thue ") && (/[0-9]/.test(normalized) || normalized.includes("vat")))
  ) {
    return "vat";
  }
  if (FEE_TOKENS.some((token) => normalized.includes(token))) return "fee";
  if (SERVICE_TOKENS.some((token) => normalized.includes(token))) return "service";
  return null;
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
  // The bare "888" has no unit and no "x N": only the packed (25kg) counts.
  ["Bột mì 888 Cam (25kg)", 25, "kg", 1],
];

/** Pack / counting units, longest alternatives first so "gr" beats "g". */
const PACK_UNIT_PATTERN =
  "kg|gram|gr|g|lit|ml|l|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi";

/**
 * Read a pack size from a receipt name. A bare number is ignored unless it is
 * followed by a unit or is the "N" of an "x N" form, so "Bột mì 888 Cam (25kg)"
 * reads 25 kg and never 888.
 */
export function parsePackFromName(name: string | null | undefined): ParsedPack | null {
  const text = String(name ?? "");
  if (!text.trim()) return null;
  const pattern = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${PACK_UNIT_PATTERN})?\\s*(?:x\\s*(\\d+))?`, "gi");
  for (const match of text.matchAll(pattern)) {
    const rawUnit = match[2] ? match[2].toLowerCase() : null;
    const multiplier = match[3] !== undefined ? Number(match[3]) : 1;
    // Only a unit or an explicit "x N" makes the number a pack quantity.
    if (rawUnit === null && multiplier <= 1) continue;
    const baseQty = Number(match[1].replace(",", "."));
    if (!Number.isFinite(baseQty)) continue;
    return { label: text.trim(), baseQty, baseUnit: rawUnit, multiplier };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JevUsage = { input: number; output: number };

export interface JevMatchEvaluation {
  /** Candidate id, or null when the model picked "none". */
  choice: string | null;
  probability: number;
  /** Second answer: goods to receive, or non-goods (VAT / fee / service). */
  lineType: JevLineType;
  lineTypeProbability: number;
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

/** One strictly-validated choice answer. */
interface ValidatedChoice {
  choice: string;
  probability: number;
  confidence: number | null;
}

/**
 * Validate a single choice question. The option set is supplied by code, so an
 * unknown option, a missing/extra probability, a tied top choice or a
 * non-normalised distribution are all refused.
 */
function validateChoiceAnswer(value: unknown, allowed: readonly string[]): ValidatedChoice {
  if (!isRecord(value) || value.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(value, "confidence") && !finiteUnit(value.confidence)) throw new JevError("jev_invalid_response", 502);
  if (typeof value.choice !== "string" || !allowed.includes(value.choice)) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(value.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = value.probabilities;
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
  const chosen = value.choice;
  const chosenProbability = probabilities[chosen] as number;
  if (allowed.some((option) => option !== chosen && (probabilities[option] as number) >= chosenProbability)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);
  return {
    choice: chosen,
    probability: chosenProbability,
    confidence: Object.hasOwn(value, "confidence") ? (value.confidence as number) : null,
  };
}

/**
 * Strict validation of the two choice questions sent in one evaluation call:
 * `match` (candidate ids + "none") and `line_type` (`goods` / `non_goods`).
 * Both must be present, with no extra answer.
 */
export function validateJevResponse(allowed: readonly string[], body: unknown): JevMatchEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (allowed.length < 2 || !allowed.includes(NONE_OPTION)) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (
    Object.keys(answers).length !== 2
    || !Object.hasOwn(answers, "match")
    || !Object.hasOwn(answers, "line_type")
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  const match = validateChoiceAnswer(answers.match, allowed);
  const lineType = validateChoiceAnswer(answers.line_type, LINE_TYPE_OPTIONS);
  return {
    choice: match.choice === NONE_OPTION ? null : match.choice,
    probability: match.probability,
    lineType: lineType.choice as JevLineType,
    lineTypeProbability: lineType.probability,
    confidence: match.confidence,
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
      // The model ranks the short c1..cN keys; store the real candidate id.
      evaluation = { ...evaluation, choice: candidateIdFromChoice(state.candidates, evaluation.choice) };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
