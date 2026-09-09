// BMQ semantic contract v1. No SQL, identity, table or arbitrary filter in the DSL.
import { METRICS } from "./data.ts";

export const MODEL = "gpt-5.6-luna";
export const SEMANTIC_VERSION = "bmq-analytics-v1";
export const MAX_QUERIES = 4;
export type Query = { metric: string; dimension: string | null; start: string; end: string; limit: number; sort?: "asc" | "desc" };
export type Input = { language: "en" | "vi"; question: string; page: { route: string; label: string; filters: Record<string, string> }; history: { role: "user" | "assistant"; text: string; customerSelection?: unknown }[] };
export type Result = { rows: { dimension: string; value: number }[]; source: string; asOf: string; note: string; noteEn?: string };
export class AnalyticsError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 422) { super(code); this.code = code; this.status = status; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnalyticsError("invalid_request");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AnalyticsError("unknown_field");
}
function str(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max || !value.trim()) throw new AnalyticsError("invalid_text");
  return value.trim();
}
export function parseInput(value: unknown): Input {
  const input = object(value); keys(input, ["question", "page", "history", "language"]);
  if (input.language !== undefined && input.language !== "en" && input.language !== "vi") throw new AnalyticsError("invalid_language");
  const language = input.language === "en" ? "en" : "vi";
  const page = object(input.page); keys(page, ["route", "label", "filters"]);
  const filters = object(page.filters ?? {});
  if (Object.keys(filters).length > 20 || Object.entries(filters).some(([key, value]) => !/^[a-zA-Z0-9_]{1,60}$/.test(key) || typeof value !== "string" || value.length > 120)) throw new AnalyticsError("invalid_filters");
  const route = str(page.route, 300);
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(route)) throw new AnalyticsError("invalid_route");
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 6) throw new AnalyticsError("history_limit");
  return { language, question: str(input.question, 2000), page: { route, label: str(page.label, 100), filters: filters as Record<string, string> }, history: history.map((item) => {
    const h = object(item); keys(h, ["role", "text", "customerSelection"]);
    if (h.customerSelection !== undefined && (h.role !== "assistant" || JSON.stringify(h.customerSelection).length > 5000)) throw new AnalyticsError("invalid_query");
    if (h.role !== "user" && h.role !== "assistant") throw new AnalyticsError("invalid_role");
    return { role: h.role, text: str(h.text, 2000), ...(h.customerSelection === undefined ? {} : {customerSelection:h.customerSelection}) };
  }) };
}
export function vnToday(now = new Date()) { return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10); }
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AnalyticsError("invalid_date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new AnalyticsError("invalid_date");
  return value;
}
export function validateQuery(value: unknown, today = vnToday()): Query {
  const q = object(value); keys(q, ["metric", "dimension", "start", "end", "limit", "sort"]);
  if (q.sort !== undefined && q.sort !== "asc" && q.sort !== "desc") throw new AnalyticsError("invalid_sort");
  if (typeof q.metric !== "string" || !Object.hasOwn(METRICS, q.metric)) throw new AnalyticsError("unknown_metric");
  const metric = METRICS[q.metric as keyof typeof METRICS];
  if (q.dimension !== null && (typeof q.dimension !== "string" || !(metric.dimensions as readonly string[]).includes(q.dimension))) throw new AnalyticsError("incompatible_dimension");
  const start = date(q.start), end = date(q.end);
  if (start > end || end > today || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new AnalyticsError("date_range_limit");
  if (!Number.isInteger(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 20) throw new AnalyticsError("row_limit");
  if (["low_stock_count", "supplier_debt"].includes(q.metric) && (start !== today || end !== today)) throw new AnalyticsError("snapshot_only");
  return { metric: q.metric, dimension: q.dimension as string | null, start, end, limit: Number(q.limit), ...(q.sort ? { sort: q.sort as "asc" | "desc" } : {}) };
}
export function normalize(text: string) { return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase().replace(/[?!.,]/g, "").replace(/\s+/g, " ").trim(); }
// Whole-utterance matches only: do not discard a qualifier such as a branch/customer.
export function fastQuery(question: string, today = vnToday()): Query | null {
  const normalized = normalize(question);
  const aliases: Record<string, string> = { "revenue today": "doanh thu hom nay", "revenue yesterday": "doanh thu hom qua", "revenue this month": "doanh thu thang nay", "purchase orders today": "so po hom nay", "low stock items": "hang sap het", "current supplier debt": "cong no ncc hien tai" };
  const text = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
  const match = /^(?:doanh thu|doanh thu kiem soat|doanh so) (hom nay|hom qua|thang nay)(?: bao nhieu)?$/.exec(text);
  let metric: string, start = today, end = today;
  if (match) {
    metric = "controlled_revenue";
    if (match[1] === "hom qua") start = end = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    if (match[1] === "thang nay") start = today.slice(0, 8) + "01";
  } else if (/^(?:so po|so don mua hang) (?:hom nay)(?: bao nhieu)?$/.test(text)) metric = "purchase_order_count";
  else if (/^(?:bao nhieu mat hang sap het|so mat hang duoi nguong|hang sap het)$/.test(text)) metric = "low_stock_count";
  else if (/^(?:cong no nha cung cap|cong no ncc)(?: hien tai| bao nhieu)?$/.test(text)) metric = "supplier_debt";
  else return null;
  return validateQuery({ metric, dimension: null, start, end, limit: 20 }, today);
}
export type Plan = { lane: "semantic" | "agentic" | "abstain"; queries: Query[]; clarification: string };
export function validatePlan(value: unknown, today: string): Plan {
  const p = object(value); keys(p, ["lane", "queries", "clarification"]);
  if (!["semantic", "agentic", "abstain"].includes(String(p.lane)) || !Array.isArray(p.queries) || p.queries.length > MAX_QUERIES) throw new AnalyticsError("invalid_plan");
  if (typeof p.clarification !== "string" || p.clarification.length > 500) throw new AnalyticsError("invalid_plan");
  if ((p.lane === "abstain" && (p.queries.length !== 0 || !p.clarification.trim())) || (p.lane === "semantic" && p.queries.length !== 1) || (p.lane === "agentic" && p.queries.length < 1)) throw new AnalyticsError("invalid_plan");
  return { lane: p.lane as Plan["lane"], queries: p.queries.map(q => validateQuery(q, today)), clarification: p.clarification };
}
export const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lane", "queries", "clarification"], properties: {
    lane: { type: "string", enum: ["semantic", "agentic", "abstain"] }, clarification: { type: "string" },
    queries: { type: "array", maxItems: MAX_QUERIES, items: { type: "object", additionalProperties: false,
      required: ["metric", "dimension", "start", "end", "limit", "sort"], properties: {
        metric: { type: "string", enum: Object.keys(METRICS) }, dimension: { type: ["string", "null"] },
        start: { type: "string" }, end: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 },
        sort: { type: "string", enum: ["asc", "desc"] },
      } } },
  },
};
export function renderResults(queries: Query[], results: Result[], language: "en" | "vi" = "vi") {
  return queries.map((q, i) => {
    const metric = METRICS[q.metric as keyof typeof METRICS], r = results[i];
    const english = language === "en";
    const labels: Record<string, [string, string]> = { controlled_revenue: ["Controlled revenue", "VND"], purchase_order_count: ["Purchase order count", "purchase orders"], low_stock_count: ["Current low-stock item count", "items"], supplier_debt: ["Current supplier payables", "VND"] };
    const [label, unit] = english ? labels[q.metric] : [metric.label, metric.unit];
    const rows = r.rows.length ? r.rows.map(row => `${english && q.dimension === null ? "Total" : english && row.dimension === "Chưa xác định" ? "Unknown" : row.dimension}: ${row.value.toLocaleString(english ? "en-US" : "vi-VN")} ${unit}`).join("\n") : english ? "No data in this scope." : "Không có dữ liệu trong phạm vi này.";
    return `${label} (${q.start} → ${q.end}, ${english ? "Vietnam time" : "giờ Việt Nam"})\n${rows}\n${english ? "Source" : "Nguồn"}: ${r.source} · ${english ? "Read at" : "Đọc lúc"} ${r.asOf}\n${english ? r.noteEn ?? r.note : r.note}`;
  }).join("\n\n");
}
export function canonicalKey(scope: { tenant: string; user: string; permission: string }, query: Query, watermark: string) {
  return JSON.stringify([scope.tenant, scope.user, scope.permission, SEMANTIC_VERSION, watermark, query.metric, query.dimension, query.start, query.end, query.limit, query.sort ?? "desc"]);
}
// Bounded isolate-local cache. Permission is rechecked before every lookup; no stale fallback.
export class ResultCache {
  private entries = new Map<string, { expires: number; value: Result }>();
  get(key: string, now: number) {
    const item = this.entries.get(key);
    if (!item || item.expires <= now) { this.entries.delete(key); return null; }
    return structuredClone(item.value);
  }
  set(key: string, value: Result, now: number) {
    if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value: structuredClone(value), expires: now + 15000 });
  }
}
