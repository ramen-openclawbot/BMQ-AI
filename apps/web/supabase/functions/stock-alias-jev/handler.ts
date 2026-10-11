// HTTP shell for the stock-material alias Jev ranking (Giai đoạn 2).
//
// It authenticates the caller server-side, enforces a body budget, enforces the
// shared daily Jev quota stored in stock_catalog_jev_usage and writes only the
// material_alias_jev_cache. For `lines` it ranks the candidate list code built
// for each receipt line; for `backlog` (Q7 editor only) it ranks the confirmed
// receipt names that still have no alias. Jev never selects its own candidates
// and no alias, PO, receipt, payment or allocation is written here.

import {
  autoNonStockReason,
  candidatesHash,
  LINE_TYPE_NON_GOODS,
  NONE_OPTION,
  normalizeItemName,
  parsePackFromName,
  JevError,
  JEV_PROMPT_VERSION,
  type JevEvaluator,
  type JevLineType,
  type JevMatchEvaluation,
  type MaterialAliasCandidate,
} from "./jev.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

export const MATERIAL_ALIAS_REQUEST_BODY_LIMIT = 32_768;
export const MATERIAL_ALIAS_REQUEST_BUDGET_MS = 110_000;
export const MATERIAL_ALIAS_DAILY_CALL_LIMIT = 600;
export const MATERIAL_ALIAS_BACKLOG_LIMIT = 200;
export const MATERIAL_ALIAS_MAX_CANDIDATES = 50;

export type MaterialAliasMode = "lines" | "backlog";

export class MaterialAliasError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "MaterialAliasError";
  }
}

export interface MaterialAliasUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface MaterialAliasCacheKey {
  supplierId: string | null;
  normalizedName: string;
  location: string;
  promptVersion: string;
  candidatesHash: string;
}

export interface CachedJevAnswer {
  choice: string | null;
  item_id: string | null;
  probability: number;
  /** Second Jev answer: goods to receive or a non-goods VAT / fee / service line. */
  line_type: JevLineType | null;
  line_type_probability: number | null;
  confidence: number | null;
  pack: { label: string; base_qty: number | null; base_unit: string | null; multiplier: number } | null;
}

export interface MaterialAliasBacklogRow {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  raw_unit: string | null;
  location: string;
}

export interface MaterialAliasLineInput {
  line_key: string;
  raw_name: string;
  raw_unit: string | null;
  candidates: MaterialAliasCandidate[];
}

export interface MaterialAliasHandlerDeps {
  killSwitch: () => boolean;
  evaluator: () => JevEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string; q7Editor: boolean }>;
  getCache: (key: MaterialAliasCacheKey) => Promise<{ answer: CachedJevAnswer; cost: number | null } | null>;
  putCache: (key: MaterialAliasCacheKey, answer: CachedJevAnswer, cost: number | null) => Promise<void>;
  getUsage: (usageDate: string) => Promise<MaterialAliasUsage>;
  recordUsage: (usage: MaterialAliasUsage) => Promise<void>;
  listBacklog: (location: string, limit: number) => Promise<MaterialAliasBacklogRow[]>;
  candidatesFor: (name: string, location: string, limit: number) => Promise<MaterialAliasCandidate[]>;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedLinesInput {
  mode: "lines";
  supplierId: string | null;
  location: string;
  lines: MaterialAliasLineInput[];
}

interface ParsedBacklogInput {
  mode: "backlog";
  location: string;
}

type ParsedInput = ParsedLinesInput | ParsedBacklogInput;

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng học bí danh NVL bằng Jev đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng học bí danh NVL chỉ dành cho người có quyền sửa kho NVL Q7 hoặc sửa đơn hàng / phiếu chi.",
  invalid_content_type: "Yêu cầu học bí danh NVL phải là JSON.",
  invalid_json: "Nội dung yêu cầu học bí danh NVL không hợp lệ.",
  invalid_request: "Yêu cầu học bí danh NVL không hợp lệ.",
  body_limit: "Yêu cầu học bí danh NVL quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  scan_failed: "Chưa thể xếp hạng bí danh NVL. Không có thay đổi nào được ghi ngoài cache Jev.",
  timeout: "Xếp hạng bí danh NVL vượt thời gian cho phép. Không có thay đổi nào được ghi.",
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
    throw new MaterialAliasError("invalid_content_type", 415);
  }
  if (!req.body) throw new MaterialAliasError("invalid_request", 400);
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
      if (size > MATERIAL_ALIAS_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new MaterialAliasError("body_limit", 413);
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
    throw new MaterialAliasError("invalid_json", 400);
  }
}

function asCandidateList(raw: unknown): MaterialAliasCandidate[] {
  if (!Array.isArray(raw) || raw.length > MATERIAL_ALIAS_MAX_CANDIDATES) {
    throw new MaterialAliasError("invalid_request", 400);
  }
  return raw.map((entry) => {
    if (!jsonBody(entry)) throw new MaterialAliasError("invalid_request", 400);
    const id = entry.id;
    const name = entry.name;
    const unit = entry.unit;
    if (typeof id !== "string" || id.trim() === "" || id === NONE_OPTION) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    if (typeof name !== "string" || typeof unit !== "string") {
      throw new MaterialAliasError("invalid_request", 400);
    }
    return { id, name, unit };
  });
}

function asLine(entry: unknown): MaterialAliasLineInput {
  if (!jsonBody(entry)) throw new MaterialAliasError("invalid_request", 400);
  for (const field of Object.keys(entry)) {
    if (!["line_key", "raw_name", "raw_unit", "candidates"].includes(field)) {
      throw new MaterialAliasError("invalid_request", 400);
    }
  }
  const lineKey = entry.line_key;
  const rawName = entry.raw_name;
  const rawUnit = entry.raw_unit === undefined ? null : entry.raw_unit;
  if (typeof lineKey !== "string" || lineKey.trim() === "") throw new MaterialAliasError("invalid_request", 400);
  if (typeof rawName !== "string" || rawName.trim() === "") throw new MaterialAliasError("invalid_request", 400);
  if (rawUnit !== null && typeof rawUnit !== "string") throw new MaterialAliasError("invalid_request", 400);
  return {
    line_key: lineKey,
    raw_name: rawName,
    raw_unit: rawUnit,
    candidates: asCandidateList(entry.candidates ?? []),
  };
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (!["mode", "supplier_id", "location", "lines"].includes(field)) {
      throw new MaterialAliasError("invalid_request", 400);
    }
  }
  const location = raw.location;
  if (location !== "q7" && location !== "tan_tao") throw new MaterialAliasError("invalid_request", 400);
  const mode = raw.mode;
  if (mode === "backlog") return { mode: "backlog", location };

  if (mode !== "lines") throw new MaterialAliasError("invalid_request", 400);
  const supplierId = raw.supplier_id === undefined ? null : raw.supplier_id;
  if (supplierId !== null && typeof supplierId !== "string") throw new MaterialAliasError("invalid_request", 400);
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 200) {
    throw new MaterialAliasError("invalid_request", 400);
  }
  const lines = raw.lines.map(asLine);
  return { mode: "lines", supplierId, location, lines };
}

function evaluationCost(evaluation: JevMatchEvaluation | undefined): number {
  return evaluation?.cost != null && Number.isFinite(evaluation.cost) ? evaluation.cost : 0;
}

function buildAnswer(
  evaluation: JevMatchEvaluation | null,
  rawName: string,
  choice: string | null,
): CachedJevAnswer {
  const parsedPack = parsePackFromName(rawName);
  return {
    choice,
    item_id: choice,
    probability: evaluation?.probability ?? 0,
    line_type: evaluation?.lineType ?? null,
    line_type_probability: evaluation?.lineTypeProbability ?? null,
    confidence: evaluation?.confidence ?? null,
    pack: parsedPack,
  };
}

/**
 * Deterministic answer for a line the fixed rule already calls non-goods
 * (VAT / fee / service): the handler answers from code and never calls Jev.
 */
function ruleAnswer(rawName: string): CachedJevAnswer {
  return {
    choice: null,
    item_id: null,
    probability: 0,
    line_type: LINE_TYPE_NON_GOODS,
    line_type_probability: 1,
    confidence: null,
    pack: parsePackFromName(rawName),
  };
}

function candidateIds(candidates: readonly MaterialAliasCandidate[]): string[] {
  return candidates.map((candidate) => candidate.id);
}

export function createMaterialAliasHandler(deps: MaterialAliasHandlerDeps) {
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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(MATERIAL_ALIAS_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + MATERIAL_ALIAS_REQUEST_BUDGET_MS;
    try {
      const { q7Editor } = await deps.authenticate(req, signal);
      signal.throwIfAborted();
      if (deps.killSwitch()) throw new MaterialAliasError("disabled", 503);
      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      if (input.mode === "backlog" && !q7Editor) throw new MaterialAliasError("forbidden", 403);
      signal.throwIfAborted();

      const usageDate = vietnamDate(now().toISOString());
      const usage = await deps.getUsage(usageDate);
      const callLimit = Number.isFinite(usage.call_limit) && usage.call_limit > 0
        ? usage.call_limit
        : MATERIAL_ALIAS_DAILY_CALL_LIMIT;
      const remainingQuota = Math.max(0, callLimit - usage.calls);

      let evaluator: JevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }

      let calls = 0;
      let cost = 0;
      let failed = 0;
      let cached = 0;

      if (input.mode === "lines") {
        const results: unknown[] = [];
        for (const line of input.lines) {
          const normalizedName = normalizeItemName(line.raw_name);
          // The fixed rule already knows VAT / fee / service: answer from code
          // and never spend a Jev call on it.
          if (autoNonStockReason(line.raw_name) !== null) {
            results.push({
              line_key: line.line_key,
              normalized_name: normalizedName,
              candidates_hash: "",
              cached: false,
              answer: ruleAnswer(line.raw_name),
            });
            continue;
          }
          const candidateList = line.candidates;
          const hash = candidatesHash(candidateIds(candidateList));
          const key: MaterialAliasCacheKey = {
            supplierId: input.supplierId,
            normalizedName,
            location: input.location,
            promptVersion: JEV_PROMPT_VERSION,
            candidatesHash: hash,
          };
          let answer: CachedJevAnswer;
          let usedCache = false;
          const hit = await deps.getCache(key);
          if (hit) {
            answer = hit.answer;
            usedCache = true;
            cached += 1;
          } else if (candidateList.length === 0) {
            answer = buildAnswer(null, line.raw_name, null);
            await deps.putCache(key, answer, null);
          } else if (!evaluator || calls >= remainingQuota) {
            answer = buildAnswer(null, line.raw_name, null);
          } else {
            const evaluation = await evaluator({ state: { line: { name: line.raw_name, unit: line.raw_unit, supplier: input.supplierId }, candidates: candidateList }, signal, deadlineAt });
            calls += 1;
            cost += evaluationCost(evaluation);
            answer = buildAnswer(evaluation, line.raw_name, evaluation.choice);
            if (!evaluation) failed += 1;
            await deps.putCache(key, answer, evaluation.cost ?? null);
          }
          results.push({
            line_key: line.line_key,
            normalized_name: normalizedName,
            candidates_hash: hash,
            cached: usedCache,
            answer,
          });
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
        deps.audit?.({ event: "stock_alias_jev", mode: "lines", lines: input.lines.length, cached, calls, cost, failed });
        return json({
          mode: "lines",
          results,
          calls,
          cost,
          cached,
          failed,
          usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
          stopped,
        });
      }

      // backlog
      const rows = await deps.listBacklog(input.location, MATERIAL_ALIAS_BACKLOG_LIMIT);
      const budget = Math.min(rows.length, remainingQuota);
      let evaluated = 0;
      let skippedExisting = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const candidates = await deps.candidatesFor(row.normalized_name, row.location, 5);
        if (candidates.length === 0) continue;
        const hash = candidatesHash(candidateIds(candidates));
        const key: MaterialAliasCacheKey = {
          supplierId: row.supplier_id,
          normalizedName: row.normalized_name,
          location: row.location,
          promptVersion: JEV_PROMPT_VERSION,
          candidatesHash: hash,
        };
        const hit = await deps.getCache(key);
        if (hit) {
          skippedExisting += 1;
          continue;
        }
        if (!evaluator || evaluated >= budget) continue;
        try {
          const evaluation = await evaluator({
            state: { line: { name: row.raw_name, unit: row.raw_unit, supplier: row.supplier_id }, candidates },
            signal,
            deadlineAt,
          });
          calls += 1;
          cost += evaluationCost(evaluation);
          evaluated += 1;
          await deps.putCache(key, buildAnswer(evaluation, row.raw_name, evaluation.choice), evaluation.cost ?? null);
        } catch (error) {
          if (error instanceof JevError) throw error;
          failed += 1;
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
      // Only a spent quota stops the scan; an empty backlog is not a quota stop.
      const stopped = remainingQuota <= 0 && rows.length > 0 ? "daily_limit" : null;
      deps.audit?.({
        event: "stock_alias_jev",
        mode: "backlog",
        candidates: rows.length,
        evaluated,
        cached: skippedExisting,
        calls,
        cost,
        failed,
      });
      return json({
        mode: "backlog",
        candidates: rows.length,
        evaluated,
        skipped_existing: skippedExisting,
        failed,
        calls,
        cost,
        usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
        stopped,
      });
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof MaterialAliasError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof MaterialAliasError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "stock_alias_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}
