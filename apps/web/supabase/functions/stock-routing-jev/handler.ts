// HTTP shell for the stock routing Jev suggestions (Giai đoạn 3).
//
// It authenticates the caller server-side (owner or Q7 stock editor only),
// enforces a body budget, enforces the shared daily Jev quota stored in
// stock_catalog_jev_usage and writes only supplier_routing_suggestions /
// material_category_suggestions. For `suppliers` it proposes the receiving
// warehouse (q7 / tan_tao / non_stock) and applies it automatically at
// probability >= 0.9 when the deterministic rule_hint agrees. For `materials` it
// proposes a stock_material_categories code and applies it automatically at
// probability >= 0.85. Jev never selects its own options.

import {
  allowedOptions,
  categoryCriteria,
  categoryInstructions,
  JevError,
  JEV_PROMPT_VERSION,
  routeCriteria,
  routeInstructions,
  validateJevResponse,
  type JevEvaluator,
  type MaterialCategoryOption,
  type SupplierRoutingState,
} from "./jev.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

export const STOCK_ROUTING_REQUEST_BODY_LIMIT = 32_768;
export const STOCK_ROUTING_REQUEST_BUDGET_MS = 110_000;
export const STOCK_ROUTING_DAILY_CALL_LIMIT = 600;
export const STOCK_ROUTING_MAX_LIMIT = 50;
export const STOCK_ROUTING_ROUTE_THRESHOLD = 0.9;
export const STOCK_ROUTING_CATEGORY_THRESHOLD = 0.85;

export type StockRoutingMode = "suppliers" | "materials";

export class StockRoutingError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "StockRoutingError";
  }
}

export interface StockRoutingUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface SupplierRoutingEvidence {
  supplier_id: string;
  supplier_name: string | null;
  category: string | null;
  receipt_count: number;
  top_items: { name: string; line_count: number }[];
  rule_hint: "q7" | "tan_tao" | "non_stock" | null;
}

export interface SupplierRoutingCandidate {
  supplier_id: string;
  receipt_count: number;
  /** True when the supplier's receiving warehouse was assigned by hand. */
  manual: boolean;
  evidence: SupplierRoutingEvidence;
}

export interface MaterialCategoryCandidate {
  material_id: string;
  material_code: string;
  canonical_name: string;
  default_unit: string;
  alias_names: string[];
}

export interface MaterialCategoryRow {
  code: string;
  label_vi: string;
  sort_order: number;
}

export interface SupplierSuggestionInput {
  supplierId: string;
  proposedLocation: string;
  probability: number;
  jevAnswer: Record<string, unknown>;
  evidence: Record<string, unknown>;
  promptVersion: string;
  cost: number | null;
}

export interface MaterialSuggestionInput {
  materialId: string;
  proposedCategory: string;
  probability: number;
  jevAnswer: Record<string, unknown>;
  promptVersion: string;
  cost: number | null;
}

export interface StockRoutingHandlerDeps {
  killSwitch: () => boolean;
  evaluator: () => JevEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string; admin: boolean }>;
  getUsage: (usageDate: string) => Promise<StockRoutingUsage>;
  recordUsage: (usage: StockRoutingUsage) => Promise<void>;
  listSupplierCandidates: (promptVersion: string, limit: number) => Promise<SupplierRoutingCandidate[]>;
  putSupplierSuggestion: (input: SupplierSuggestionInput) => Promise<{ id: string }>;
  applySupplierRouting: (
    supplierId: string,
    location: string,
    source: string,
    suggestionId: string,
  ) => Promise<Record<string, unknown>>;
  listMaterialCandidates: (promptVersion: string, limit: number) => Promise<MaterialCategoryCandidate[]>;
  listCategories: () => Promise<MaterialCategoryRow[]>;
  putMaterialSuggestion: (input: MaterialSuggestionInput) => Promise<{ id: string }>;
  decideMaterialCategory: (suggestionId: string, action: "approve" | "reject") => Promise<Record<string, unknown>>;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  mode: StockRoutingMode;
  limit: number;
}

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng gợi ý kho nhận bằng Jev đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng gợi ý kho nhận chỉ dành cho chủ hoặc người có quyền sửa kho NVL Q7.",
  invalid_content_type: "Yêu cầu gợi ý kho nhận phải là JSON.",
  invalid_json: "Nội dung yêu cầu gợi ý kho nhận không hợp lệ.",
  invalid_request: "Yêu cầu gợi ý kho nhận không hợp lệ.",
  body_limit: "Yêu cầu gợi ý kho nhận quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  scan_failed: "Chưa thể xếp hạng kho nhận. Không có thay đổi nào được ghi ngoài gợi ý.",
  timeout: "Gợi ý kho nhận vượt thời gian cho phép. Không có thay đổi nào được ghi.",
};

const VN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant in Vietnam time (UTC+7). */
export function vietnamDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = VN_DATE.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new StockRoutingError("invalid_content_type", 415);
  }
  if (!req.body) throw new StockRoutingError("invalid_request", 400);
  const reader = req.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > STOCK_ROUTING_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new StockRoutingError("body_limit", 413);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!jsonBody(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new StockRoutingError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (field !== "mode" && field !== "limit") {
      throw new StockRoutingError("invalid_request", 400);
    }
  }
  const mode = raw.mode;
  if (mode !== "suppliers" && mode !== "materials") {
    throw new StockRoutingError("invalid_request", 400);
  }
  let limit = STOCK_ROUTING_MAX_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      throw new StockRoutingError("invalid_request", 400);
    }
    limit = Math.min(raw.limit, STOCK_ROUTING_MAX_LIMIT);
  }
  return { mode, limit };
}

function evaluationCost(cost: number | null | undefined): number {
  return cost != null && Number.isFinite(cost) ? cost : 0;
}

function supplierState(evidence: SupplierRoutingEvidence): SupplierRoutingState {
  return {
    supplier: {
      name: evidence.supplier_name ?? "",
      category: evidence.category,
      top_items: Array.isArray(evidence.top_items) ? evidence.top_items : [],
      receipt_count: evidence.receipt_count,
    },
  };
}

function categoryOptionsForRows(rows: readonly MaterialCategoryRow[]): MaterialCategoryOption[] {
  return rows.map((row) => ({ code: row.code, label_vi: row.label_vi }));
}

export function createStockRoutingHandler(deps: StockRoutingHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      ...getCorsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(STOCK_ROUTING_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + STOCK_ROUTING_REQUEST_BUDGET_MS;
    try {
      const { admin } = await deps.authenticate(req, signal);
      signal.throwIfAborted();
      if (!admin) throw new StockRoutingError("forbidden", 403);
      if (deps.killSwitch()) throw new StockRoutingError("disabled", 503);
      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      signal.throwIfAborted();

      const usageDate = vietnamDate(now().toISOString());
      const usage = await deps.getUsage(usageDate);
      const callLimit = Number.isFinite(usage.call_limit) && usage.call_limit > 0
        ? usage.call_limit
        : STOCK_ROUTING_DAILY_CALL_LIMIT;
      const remainingQuota = Math.max(0, callLimit - usage.calls);

      let evaluator: JevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }

      let candidates = 0;
      let suggestions = 0;
      let applied = 0;
      let pending = 0;
      let failed = 0;
      let calls = 0;
      let cost = 0;

      if (input.mode === "suppliers") {
        const rows = await deps.listSupplierCandidates(JEV_PROMPT_VERSION, input.limit);
        candidates = rows.length;
        for (const row of rows) {
          // A supplier already routed by hand is never re-asked.
          if (row.manual) continue;
          if (!evaluator || calls >= remainingQuota) {
            failed += 1;
            break;
          }
          const evidence = row.evidence;
          if (!evidence || evidence.receipt_count < 1) continue;
          const state = supplierState(evidence);
          const evaluation = await evaluator({ mode: "route", state, signal, deadlineAt });
          calls += 1;
          cost += evaluationCost(evaluation.cost);
          const ruleHint = evidence.rule_hint;
          const conflict = ruleHint !== null && ruleHint !== evaluation.choice;
          const suggestion = await deps.putSupplierSuggestion({
            supplierId: row.supplier_id,
            proposedLocation: evaluation.choice,
            probability: evaluation.probability,
            jevAnswer: {
              question: "route",
              choice: evaluation.choice,
              probability: evaluation.probability,
              confidence: evaluation.confidence,
            },
            evidence: {
              supplier_name: evidence.supplier_name,
              category: evidence.category,
              receipt_count: evidence.receipt_count,
              top_items: evidence.top_items,
              rule_hint: ruleHint,
              conflict,
            },
            promptVersion: JEV_PROMPT_VERSION,
            cost: evaluation.cost,
          });
          suggestions += 1;
          if (
            evaluation.probability >= STOCK_ROUTING_ROUTE_THRESHOLD
            && (ruleHint === null || ruleHint === evaluation.choice)
          ) {
            await deps.applySupplierRouting(row.supplier_id, evaluation.choice, "jev", suggestion.id);
            applied += 1;
          } else {
            pending += 1;
          }
        }
        if (calls > 0 || cost > 0) {
          await deps.recordUsage({
            usage_date: usageDate,
            calls: usage.calls + calls,
            cost: usage.cost + cost,
            call_limit: callLimit,
          });
        }
        const stopped = remainingQuota <= 0 ? "daily_limit" : null;
        deps.audit?.({ event: "stock_routing_jev", mode: "suppliers", candidates, suggestions, applied, pending, calls, cost, failed });
        return json({
          mode: "suppliers",
          candidates,
          suggestions,
          applied,
          pending,
          failed,
          calls,
          cost,
          usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
          stopped,
        });
      }

      // materials
      const categories = await deps.listCategories();
      const options = categoryOptionsForRows(categories);
      const rows = await deps.listMaterialCandidates(JEV_PROMPT_VERSION, input.limit);
      candidates = rows.length;
      for (const row of rows) {
        if (!evaluator || calls >= remainingQuota) {
          failed += 1;
          break;
        }
        if (options.length < 2) break;
        const state = {
          material: {
            name: row.canonical_name,
            default_unit: row.default_unit,
            aliases: row.alias_names,
          },
          categories: options,
        };
        const evaluation = await evaluator({ mode: "category", state, signal, deadlineAt });
        calls += 1;
        cost += evaluationCost(evaluation.cost);
        const suggestion = await deps.putMaterialSuggestion({
          materialId: row.material_id,
          proposedCategory: evaluation.choice,
          probability: evaluation.probability,
          jevAnswer: {
            question: "category",
            choice: evaluation.choice,
            probability: evaluation.probability,
            confidence: evaluation.confidence,
          },
          promptVersion: JEV_PROMPT_VERSION,
          cost: evaluation.cost,
        });
        suggestions += 1;
        if (evaluation.probability >= STOCK_ROUTING_CATEGORY_THRESHOLD) {
          await deps.decideMaterialCategory(suggestion.id, "approve");
          applied += 1;
        } else {
          pending += 1;
        }
      }
      if (calls > 0 || cost > 0) {
        await deps.recordUsage({
          usage_date: usageDate,
          calls: usage.calls + calls,
          cost: usage.cost + cost,
          call_limit: callLimit,
        });
      }
      const stopped = remainingQuota <= 0 ? "daily_limit" : null;
      deps.audit?.({ event: "stock_routing_jev", mode: "materials", candidates, suggestions, applied, pending, calls, cost, failed });
      return json({
        mode: "materials",
        candidates,
        suggestions,
        applied,
        pending,
        failed,
        calls,
        cost,
        usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
        stopped,
      });
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof StockRoutingError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof StockRoutingError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "stock_routing_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}

// Re-exported for the tests that build a fake fetch response.
export { allowedOptions, categoryCriteria, categoryInstructions, routeCriteria, routeInstructions, validateJevResponse };
