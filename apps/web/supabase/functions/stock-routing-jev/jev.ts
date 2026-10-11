// Server-side Jev evaluator for stock routing (Giai đoạn 3).
//
// Self-contained on purpose: it does not import across functions and holds no
// database client. The transport copies the verified Vercel AI Gateway contract
// already used by stock-alias-jev/jev.ts: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and one
// deadline per call with no retry.
//
// Two choice questions:
//   * route:    the supplier ships to q7, tan_tao or non_stock.
//   * category: the canonical material belongs to one stock_material_categories
//               code, with one Vietnamese criterion per group.
//
// Contract reference (verified): https://docs.typesafe.ai/api.md and
// https://docs.typesafe.ai/primitives/choice.md.

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the question or the criteria below change.
export const JEV_PROMPT_VERSION = "jev-stock-routing-2026-10-17.1";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

export const ROUTE_OPTIONS = ["q7", "tan_tao", "non_stock"] as const;
export type RouteOption = (typeof ROUTE_OPTIONS)[number];

export type JevMode = "route" | "category";

export interface SupplierRoutingItem {
  name: string;
  line_count: number;
}

/** State sent to Jev for the `route` question. */
export interface SupplierRoutingState {
  supplier: {
    name: string;
    category: string | null;
    top_items: SupplierRoutingItem[];
    receipt_count: number;
  };
}

/** One fixed material category group offered to the `category` question. */
export interface MaterialCategoryOption {
  code: string;
  label_vi: string;
}

/** State sent to Jev for the `category` question. */
export interface MaterialRoutingState {
  material: {
    name: string;
    default_unit: string;
    aliases: string[];
  };
  categories: MaterialCategoryOption[];
}

export const ROUTE_INSTRUCTIONS =
  "Nhà cung cấp `supplier` (tên, nhóm, các mặt hàng đã giao) giao hàng về kho nào?";

export const ROUTE_CRITERIA: Record<RouteOption, string> = {
  q7: "Kho Q7: nguyên vật liệu, gia vị, bao bì, vật tư cho bếp sản xuất bánh mì và pate.",
  tan_tao: "Kho Tân Tạo: bánh mì, bánh mì que, pate thành phẩm cho kho đại lý Tân Tạo.",
  non_stock: "Không nhập kho: dịch vụ, phí, vận chuyển, xử lý côn trùng, phân tích mẫu, thuê.",
};

export const CATEGORY_INSTRUCTIONS =
  "Mã nguyên vật liệu `material` (tên chuẩn, đơn vị mặc định, các tên hàng gốc đã map) thuộc nhóm nào?";

/** Vietnamese criterion per fixed category code (mirrors the seeded catalog). */
export const MATERIAL_CATEGORY_CRITERIA: Record<string, string> = {
  flour: "Bột và ngũ cốc: bột mì, bột gạo, bột ngô, ngũ cốc, yến mạch.",
  dairy_fat: "Sữa, bơ, chất béo: sữa, bơ, margarine, dầu ăn, shortening.",
  eggs: "Trứng: trứng gà, trứng vịt, lòng đỏ, lòng trắng trứng.",
  sugar_additives: "Đường và phụ gia: đường, muối, bột nở, men, hương liệu, phụ gia thực phẩm.",
  meat_filling: "Nhân thịt, chả, pate: thịt heo, thịt gà, chả, pate, xúc xích làm nhân.",
  cheese: "Phô mai: phô mai lát, phô mai kem, phô mai bột.",
  vegetables: "Rau củ, gia vị: hành, tỏi, rau, củ, tiêu, ớt, gia vị khô.",
  packaging: "Bao bì: túi, hộp, khay, nhãn, màng bọc, sticker.",
  supplies: "Vật tư, dụng cụ: găng tay, giấy, dụng cụ bếp, vật tư tiêu hao.",
  service: "Dịch vụ, phí: vận chuyển, xử lý côn trùng, phân tích mẫu, thuê ngoài.",
  other: "Khác: nguyên vật liệu không thuộc các nhóm trên.",
};

export function routeInstructions(): string {
  return ROUTE_INSTRUCTIONS;
}

export function routeCriteria(): Record<string, string> {
  return { ...ROUTE_CRITERIA };
}

export function categoryInstructions(): string {
  return CATEGORY_INSTRUCTIONS;
}

export function categoryCriteria(categories: readonly MaterialCategoryOption[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const category of categories) {
    criteria[category.code] = MATERIAL_CATEGORY_CRITERIA[category.code] ?? category.label_vi;
  }
  return criteria;
}

export function routeOptions(): string[] {
  return [...ROUTE_OPTIONS];
}

export function categoryOptions(categories: readonly MaterialCategoryOption[]): string[] {
  return categories.map((category) => category.code);
}

export function allowedOptions(mode: JevMode, state: SupplierRoutingState | MaterialRoutingState): string[] {
  if (mode === "route") return routeOptions();
  return categoryOptions((state as MaterialRoutingState).categories);
}

export function jevQuestions(mode: JevMode, state: SupplierRoutingState | MaterialRoutingState) {
  if (mode === "route") {
    return {
      route: {
        type: "choice" as const,
        instructions: routeInstructions(),
        criteria: routeCriteria(),
      },
    };
  }
  const categories = (state as MaterialRoutingState).categories;
  return {
    category: {
      type: "choice" as const,
      instructions: categoryInstructions(),
      criteria: categoryCriteria(categories),
    },
  };
}

export function questionKey(mode: JevMode): string {
  return mode === "route" ? "route" : "category";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JevUsage = { input: number; output: number };

export interface JevEvaluation {
  mode: JevMode;
  choice: string;
  probability: number;
  confidence: number | null;
  usage: JevUsage;
  cost: number | null;
}

export interface JevEvaluatorParams {
  mode: JevMode;
  state: SupplierRoutingState | MaterialRoutingState;
  signal: AbortSignal;
  deadlineAt?: number;
}

export type JevEvaluator = (params: JevEvaluatorParams) => Promise<JevEvaluation>;

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
 * Strict validation of the single choice question for the requested mode. The
 * option set is supplied by code (`allowed`), so an unknown option, a
 * missing/extra probability, a tied top choice or a non-normalised distribution
 * are all refused.
 */
export function validateJevResponse(mode: JevMode, allowed: readonly string[], body: unknown): JevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (allowed.length < 2) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  const key = questionKey(mode);
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, key)) {
    throw new JevError("jev_invalid_response", 502);
  }
  const choice = answers[key];
  if (!isRecord(choice) || choice.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const field of Object.keys(choice)) {
    if (field !== "type" && field !== "choice" && field !== "probabilities" && field !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(choice, "confidence") && !finiteUnit(choice.confidence)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (typeof choice.choice !== "string" || !allowed.includes(choice.choice)) {
    throw new JevError("jev_invalid_response", 502);
  }
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
    mode,
    choice: chosen,
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

  return async ({ mode, state, signal, deadlineAt }): Promise<JevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const allowed = allowedOptions(mode, state);
    const body = JSON.stringify({
      model: JEV_MODEL,
      state,
      questions: jevQuestions(mode, state),
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
    let evaluation: JevEvaluation;
    try {
      evaluation = validateJevResponse(mode, allowed, parsed);
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
