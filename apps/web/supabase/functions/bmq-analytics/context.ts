// Structured, non-authoritative conversation state for the cost-classification lane.
//
// The context is a bounded hint of the previous reviewed scope (month / category /
// status) and the one example line that was shown. It is NEVER a source of truth:
// every follow-up is re-resolved through the closed cost grammar and re-read from
// the current snapshot by the authenticated warehouse. The state is:
//   - signed with a dedicated server secret (never a client-known bearer token),
//   - bound to the authenticated user id and to the current conversation id,
//   - short-lived (explicit, bounded TTL),
//   - only read from the immediately preceding assistant message of the same history,
//   - rejected when two different conversation ids appear in one history.
import { AnalyticsError, normalize } from './core.ts';
import {
  COST_KINDS, costDetect, costUnsupportedQualifier, costCategoryFromQuestion,
  allCategoriesRequested, allStatusesRequested, monthFromQuestion, statusesRequested,
  type CostKind,
} from './cost.ts';

export const COST_CONTEXT_VERSION = 1;
export const COST_CONTEXT_TTL_MS = 15 * 60 * 1000;
export const COST_CONTEXT_MIN_TTL_MS = 60 * 1000;
export const COST_CONTEXT_MAX_BYTES = 4000;
export const COST_CONTEXT_SKEW_MS = 60 * 1000;
// A signing secret shorter than this is refused; callers must provision a real
// named secret (BMQ_CHAT_CONTEXT_SECRET) and never derive it from a bearer token.
export const COST_CONTEXT_MIN_SECRET_LENGTH = 32;

const MONTH = /^(\d{4})-(\d{2})$/;
const CATEGORY = /^[A-Z][A-Z0-9_]{0,49}$/;
const REFERENCE = /^[A-Za-z0-9-]{1,64}$/;
const CONVERSATION = /^[A-Za-z0-9-]{8,64}$/;
const STATUSES = ['needs_review', 'suggested', 'approved', 'rejected'] as const;
const CONTEXT_KEYS = ['v', 'user', 'conv', 'iat', 'exp', 'snap', 'scope', 'selection', 'sig'];

export type CostScope = { kind: CostKind; month: string | null; category_code: string | null; review_status: string | null };
export type CostSelection = { line_ref: string; classification_id: string };
export type CostContext = {
  v: number; user: string; conv: string; iat: number; exp: number; snap: string;
  scope: CostScope; selection?: CostSelection; sig: string;
};
export type CostHistoryItem = { role: 'user' | 'assistant'; text: string; customerSelection?: unknown; costContext?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A month must be a real 01..12 month in a sane year; "2026-13"/"2026-00" are invalid.
export function validMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MONTH.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]);
  return year >= 2000 && year <= 2999 && month >= 1 && month <= 12;
}
const validCategory = (value: unknown): value is string => typeof value === 'string' && CATEGORY.test(value);
const validStatus = (value: unknown): value is (typeof STATUSES)[number] => typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
const validRef = (value: unknown): value is string => typeof value === 'string' && REFERENCE.test(value);
export const validConversationId = (value: unknown): value is string => typeof value === 'string' && CONVERSATION.test(value);
// Snapshot ids are server-generated run ids; bound the length and ban control
// characters without guessing an exact machine format.
const validSnapshot = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/\p{Cc}/u.test(value);

function parseScope(value: unknown): CostScope | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'month', 'category_code', 'review_status'].includes(key))) return null;
  const kind = value.kind;
  if (typeof kind !== 'string' || !(COST_KINDS as readonly string[]).includes(kind)) return null;
  const month = value.month ?? null, category = value.category_code ?? null, status = value.review_status ?? null;
  if (month !== null && !validMonth(month)) return null;
  if (category !== null && !validCategory(category)) return null;
  if (status !== null && !validStatus(status)) return null;
  return { kind: kind as CostKind, month, category_code: category, review_status: status };
}

function parseSelection(value: unknown): CostSelection | null {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'classification_id,line_ref') return null;
  if (!validRef(value.line_ref) || !validRef(value.classification_id)) return null;
  if (value.line_ref !== value.classification_id) return null;
  return { line_ref: value.line_ref, classification_id: value.classification_id };
}

function canonical(state: Omit<CostContext, 'sig'> | CostContext): string {
  const scope = state.scope;
  return JSON.stringify([
    state.v, state.user, state.conv, state.iat, state.exp, state.snap,
    [scope.kind, scope.month, scope.category_code, scope.review_status],
    state.selection ? [state.selection.line_ref, state.selection.classification_id] : null,
  ]);
}

async function signature(payload: string, secret: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(`bmq-cost-context-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createCostContext(input: {
  userId: string; secret: string; conversationId: string; snap: string; scope: CostScope;
  selection?: CostSelection | null; now?: number; ttlMs?: number;
}): Promise<CostContext> {
  if (typeof input.secret !== 'string' || input.secret.length < COST_CONTEXT_MIN_SECRET_LENGTH) throw new AnalyticsError('context_unconfigured', 503);
  if (typeof input.userId !== 'string' || !input.userId || input.userId.length > 200) throw new AnalyticsError('invalid_identity');
  if (!validConversationId(input.conversationId)) throw new AnalyticsError('invalid_conversation_id');
  if (typeof input.snap !== 'string' || !validSnapshot(input.snap)) throw new AnalyticsError('invalid_snapshot');
  const scope = parseScope(input.scope);
  if (!scope) throw new AnalyticsError('invalid_scope');
  const selection = input.selection ? parseSelection(input.selection) : null;
  if (input.selection && !selection) throw new AnalyticsError('invalid_selection');
  const now = input.now ?? Date.now();
  if (!Number.isInteger(now) || now <= 0) throw new AnalyticsError('invalid_time');
  const ttl = input.ttlMs ?? COST_CONTEXT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < COST_CONTEXT_MIN_TTL_MS || ttl > COST_CONTEXT_TTL_MS) throw new AnalyticsError('invalid_ttl');
  const base: Omit<CostContext, 'sig'> = {
    v: COST_CONTEXT_VERSION, user: input.userId, conv: input.conversationId, iat: now,
    exp: now + ttl, snap: input.snap, scope,
    ...(selection ? { selection } : {}),
  };
  return { ...base, sig: await signature(canonical(base), input.secret) };
}

// Returns a fully validated context, or null. Malformed, expired, cross-user,
// cross-conversation, mixed-conversation or tampered state is never used.
export async function readCostContext(
  history: CostHistoryItem[],
  options: { userId: string; secret: string; conversationId: string; now?: number },
): Promise<CostContext | null> {
  if (typeof options.secret !== 'string' || options.secret.length < COST_CONTEXT_MIN_SECRET_LENGTH) return null;
  if (typeof options.userId !== 'string' || !options.userId) return null;
  if (!validConversationId(options.conversationId)) return null;
  const now = options.now ?? Date.now();
  if (!Number.isInteger(now) || now <= 0) return null;
  const conversations = new Set<string>();
  for (const item of history) {
    if (!item || item.role !== 'assistant' || !isRecord(item.costContext)) continue;
    const conv = item.costContext.conv;
    if (typeof conv === 'string' && conv) conversations.add(conv);
    if (conversations.size > 1) return null;
  }
  const last = history.at(-1);
  if (!last || last.role !== 'assistant' || !isRecord(last.costContext)) return null;
  const raw = last.costContext;
  let serialized: string;
  try { serialized = JSON.stringify(raw); } catch { return null; }
  if (serialized.length > COST_CONTEXT_MAX_BYTES) return null;
  if (Object.keys(raw).some((key) => !CONTEXT_KEYS.includes(key))) return null;
  if (raw.v !== COST_CONTEXT_VERSION || typeof raw.user !== 'string' || !raw.user || typeof raw.snap !== 'string' || !validSnapshot(raw.snap)
    || typeof raw.conv !== 'string' || !raw.conv || typeof raw.sig !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sig)) return null;
  const iat = raw.iat, exp = raw.exp, sig = raw.sig, user = raw.user, conv = raw.conv, snap = raw.snap;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp) || iat <= 0 || exp <= iat) return null;
  // The current request must name the conversation the signed state belongs to;
  // identity alone is not current-conversation binding.
  if (conv !== options.conversationId) return null;
  if (user !== options.userId) return null;
  if (exp <= now || iat > now + COST_CONTEXT_SKEW_MS || exp - iat > COST_CONTEXT_TTL_MS || now - iat > COST_CONTEXT_TTL_MS) return null;
  const scope = parseScope(raw.scope);
  if (!scope) return null;
  const selection = raw.selection === undefined ? undefined : parseSelection(raw.selection);
  if (raw.selection !== undefined && !selection) return null;
  const state: CostContext = {
    v: COST_CONTEXT_VERSION, user, conv, iat, exp, snap, scope,
    ...(selection ? { selection } : {}), sig,
  };
  if (await signature(canonical(state), options.secret) !== sig) return null;
  return state;
}

const blockedTopics = /(doanh thu|revenue|khach hang|customer|ton kho|inventory|cong no|debt|purchase|don hang|order)/;
// A shortcut must never turn a question about another topic into a cost follow-up.
const OTHER_TOPIC = /(doanh thu|revenue|khach hang|customer|ton kho|inventory|cong no|debt|purchase|don hang|order|unc|uy nhiem chi|bank slip|anh chuyen khoan|tai lieu|document|knowledge|nha cung cap|supplier|nhan vien|employee|phong ban|department|ngan hang|bank)/;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const fold = (question: string) => normalize(question).replace(/đ/g, 'd');
const namesOtherTopic = (question: string) => OTHER_TOPIC.test(fold(question));

export function isExampleRequest(question: string): boolean {
  const text = fold(question);
  if (!/(vi du|example)/.test(text) || blockedTopics.test(text)) return false;
  return /(dong|khoan|line|row|chi tiet|chi phi)/.test(text) || wordCount(text) <= 5;
}

export function isThisLineRequest(question: string): boolean {
  const text = fold(question);
  if (!/(dong nay|khoan nay|dong do|khoan do|this line|that line|this row)/.test(text)) return false;
  return /(vi sao|tai sao|why|ly do|reason|giai thich|explain|phan loai|classif|xep|nhom|category|trang thai|status)/.test(text) || wordCount(text) <= 5;
}

export function isPreviousMonthRequest(question: string): boolean {
  return /(thang truoc|thang roi|thang vua roi|previous month|last month)/.test(fold(question));
}

export function previousMonth(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, '0')}`;
}

// Route fallback is only ever an explicit allow-list for the real finance cost
// route; every unlisted route/filter/value fails closed. The classification page
// keeps month/category/status in component state rather than the URL, so no page
// filter is source-verified as a cost scope: the entry below is intentionally
// empty and an unknown filter can never widen scope.
export type RouteFilterMap = Record<string, Record<string, 'month' | 'review_status'>>;
export const COST_ROUTE_FILTER_WHITELIST: RouteFilterMap = Object.freeze({
  '/finance-control/classification': Object.freeze({}),
});

export function resolveRouteFilter(
  mapping: Record<string, 'month' | 'review_status'>,
  key: string,
  value: string,
  today: string,
): { key: 'month' | 'review_status'; value: string } | null {
  const mapped = mapping[key];
  if (!mapped) return null;
  if (mapped === 'month') {
    if (!validMonth(value) || value > today.slice(0, 7)) return null;
    return { key: 'month', value };
  }
  if (!validStatus(value)) return null;
  return { key: 'review_status', value };
}

export function routeCostScope(
  route: string,
  filters: Record<string, string>,
  today: string,
): { kind: 'scope'; scope: Partial<CostScope> } | { kind: 'abstain' } | null {
  const mapping = COST_ROUTE_FILTER_WHITELIST[route];
  if (!mapping) return null;
  const keys = Object.keys(filters ?? {});
  if (!keys.length) return null;
  const scope: Partial<CostScope> = {};
  for (const key of keys) {
    const resolved = resolveRouteFilter(mapping, key, filters[key], today);
    if (!resolved) return { kind: 'abstain' };
    if (resolved.key === 'month') scope.month = resolved.value;
    else scope.review_status = resolved.value;
  }
  return { kind: 'scope', scope };
}

// Explicit qualifiers in the new question win over the validated conversation
// scope; the conversation scope wins over the page route fallback. A literal null
// in the lookup means "explicitly cleared / all", never "inherit the old value".
function qualifier(lookup: any, key: string, inherited: string | null, valid: (value: unknown) => boolean): string | null {
  if (!isRecord(lookup) || !Object.hasOwn(lookup, key)) return inherited;
  const value = lookup[key];
  if (value === null) return null;
  if (typeof value === 'string' && valid(value)) return value;
  return inherited;
}

function mergeScope(
  lookup: any,
  scope: CostScope | null,
  routeScope: Partial<CostScope> | null = null,
  clears: { category?: boolean; status?: boolean } = {},
): CostScope {
  const fallback: CostScope | null = scope ?? (routeScope
    ? { kind: 'month_totals', month: routeScope.month ?? null, category_code: routeScope.category_code ?? null, review_status: routeScope.review_status ?? null }
    : null);
  const kindValue = lookup?.kind;
  let kind: CostKind = (typeof kindValue === 'string' && (COST_KINDS as readonly string[]).includes(kindValue))
    ? kindValue as CostKind
    : fallback?.kind ?? 'month_totals';
  let month = qualifier(lookup, 'month', fallback?.month ?? null, validMonth);
  let category = qualifier(lookup, 'category_code', fallback?.category_code ?? null, validCategory);
  let status = qualifier(lookup, 'review_status', fallback?.review_status ?? null, validStatus);
  // An explicit "tất cả trạng thái" on a pending branch means the EFFECTIVE
  // aggregate is all statuses. Keeping the old pending kind would reimpose
  // needs_review on the next example/previous-month turn after the user cleared it.
  if (clears.status && (kind === 'pending_summary' || kind === 'top_pending_lines')) kind = 'month_totals';
  // pending_summary/top_pending_lines mean needs_review even when the request does
  // not carry an explicit status; never let an old approved status leak into it. A
  // stored pending scope whose status is null was explicitly cleared, so it must
  // not have needs_review reimposed on the next turn either.
  const inheritedCleared = fallback !== null && fallback.review_status === null
    && (fallback.kind === 'pending_summary' || fallback.kind === 'top_pending_lines');
  if ((kind === 'pending_summary' || kind === 'top_pending_lines') && !clears.status && !inheritedCleared) status = 'needs_review';
  // An explicit "tất cả nhóm/trạng thái" clears the inherited qualifier even when
  // the closed cost grammar did not resolve an explicit lookup for this phrasing.
  if (clears.category) category = null;
  if (clears.status) status = null;
  if (kind === 'unmapped_low_confidence') { category = null; status = null; }
  return { kind, month, category_code: category, review_status: status };
}

function shiftKind(kind: CostKind): CostKind {
  return ['pending_summary', 'top_pending_lines', 'unmapped_low_confidence', 'example_line'].includes(kind) ? kind : 'month_totals';
}

// Builds a month-scoped lookup using only the qualifiers that question accepts,
// mirroring the closed Python grammar (never sends a rejected field).
function monthLookup(kind: CostKind, month: string, scope: CostScope): Record<string, unknown> {
  const lookup: Record<string, unknown> = { kind, month };
  if (kind === 'unmapped_low_confidence') return lookup;
  if (scope.category_code) lookup.category_code = scope.category_code;
  if ((kind === 'example_line' || kind === 'month_totals' || kind === 'category_comparison') && scope.review_status) lookup.review_status = scope.review_status;
  return lookup;
}

// True when the question explicitly names a month/category/status that is not the
// stored selection's scope, so the stored row must not be answered.
function scopeChanged(question: string, scope: CostScope): boolean {
  const { month, invalid } = monthFromQuestion(question);
  if (invalid) return true;
  if (month && month !== scope.month) return true;
  if (allCategoriesRequested(question) && scope.category_code !== null) return true;
  if (allStatusesRequested(question)) return true;
  const statuses = statusesRequested(question);
  if (statuses.length && !statuses.includes((scope.review_status ?? '') as (typeof STATUSES)[number])) return true;
  const category = costCategoryFromQuestion(question);
  if (category && category !== scope.category_code) return true;
  return false;
}

export type CostFollowUp =
  | { kind: 'cost'; lookup: Record<string, unknown>; source: 'explicit' | 'example' | 'selection' | 'previous_month'; inbound: CostContext | null }
  | { kind: 'abstain'; message: string };

// Resolves a follow-up deterministically when it can: bounded, no model call.
// Returns null when the question needs the normal planner (or the page route).
export async function costFollowUp(
  input: { question: string; history: CostHistoryItem[]; conversationId?: string },
  options: { userId: string; signingSecret?: string; now?: number; today: string; routeScope?: Partial<CostScope> | null },
): Promise<CostFollowUp | null> {
  const context = options.signingSecret && validConversationId(input.conversationId)
    ? await readCostContext(input.history, { userId: options.userId, secret: options.signingSecret, conversationId: input.conversationId!, now: options.now })
    : null;
  const explicit = costDetect(input.question, options.today);
  const explicitLookup = explicit?.lane === 'cost' ? explicit.lookup : null;
  const routeScope = options.routeScope ?? null;
  const clears = { category: allCategoriesRequested(input.question), status: allStatusesRequested(input.question) };

  // The current question's explicit conflicting/unsupported intent always wins.
  // A mere "which month?" clarification is deferred so a valid previous-month or
  // example shortcut can still resolve it first.
  if (explicit?.lane === 'abstain') return { kind: 'abstain', message: explicit.message || '' };
  // costUnsupportedQualifier is a cost-only rule, so decide the current cost intent
  // first: it applies to an explicit cost question or a bounded cost follow-up
  // (example / this line / previous month), where an unsupported supplier/date/
  // currency filter must abstain before a shortcut can widen the scope. A question
  // that is not a cost follow-up at all (a UNC-image, knowledge/document, revenue
  // or customer request) keeps its own lane and is never blocked by this rule, so
  // an explicit other topic is prioritized and deferred to the normal planner.
  const costIntent = Boolean(explicitLookup) || isExampleRequest(input.question) || isThisLineRequest(input.question) || isPreviousMonthRequest(input.question);
  const unsupported = costIntent ? costUnsupportedQualifier(input.question) : null;
  if (unsupported) return { kind: 'abstain', message: unsupported };
  // An explicit new line reference overrides any old stored selection.
  if (explicitLookup?.kind === 'line_explanation' && typeof explicitLookup.line_ref === 'string') {
    return { kind: 'cost', source: 'explicit', inbound: context, lookup: explicitLookup };
  }

  if (isExampleRequest(input.question) && (!namesOtherTopic(input.question) || explicitLookup)) {
    const scope = mergeScope(explicitLookup, context?.scope ?? null, routeScope, clears);
    if (!scope.month) return explicit?.lane === 'clarify' ? { kind: 'abstain', message: explicit.message || '' } : null;
    if (scope.kind === 'unmapped_low_confidence') {
      return { kind: 'abstain', message: 'Phạm vi chưa phân loại / độ tin cậy thấp chưa hỗ trợ chọn một dòng ví dụ. Anh hỏi theo tháng, nhóm và trạng thái duyệt nhé.' };
    }
    return { kind: 'cost', source: 'example', inbound: context, lookup: monthLookup('example_line', scope.month, scope) };
  }
  if (isThisLineRequest(input.question) && (!namesOtherTopic(input.question) || explicitLookup)) {
    const selection = context?.selection;
    if (!selection) return null;
    if (scopeChanged(input.question, context!.scope)) {
      return { kind: 'abstain', message: 'Câu hỏi đổi tháng/nhóm/trạng thái nên dòng đã chọn không còn thuộc phạm vi này. Hệ thống không trả lời bằng dòng cũ; anh yêu cầu một dòng ví dụ mới trong phạm vi mới nhé.' };
    }
    return { kind: 'cost', source: 'selection', inbound: context, lookup: { kind: 'line_explanation', line_ref: selection.line_ref } };
  }
  if (isPreviousMonthRequest(input.question) && !namesOtherTopic(input.question)) {
    // Only shift a month inside a validated cost conversation or an explicit cost
    // question; a short "còn tháng trước?" with no cost context must not invent a
    // cost intent for an unrelated topic.
    if (!context && !explicitLookup) return null;
    const scope = mergeScope(explicitLookup, context?.scope ?? null, routeScope, clears);
    const month = scope.month ?? options.today.slice(0, 7);
    return { kind: 'cost', source: 'previous_month', inbound: context, lookup: monthLookup(shiftKind(scope.kind), previousMonth(month), scope) };
  }
  if (explicitLookup) return { kind: 'cost', source: 'explicit', inbound: context, lookup: explicitLookup };
  if (explicit?.lane === 'clarify') return { kind: 'abstain', message: explicit.message || '' };
  return null;
}

// The scope shown to the user this turn becomes the next turn's hint. A selection
// is only carried while it belongs to the same scope and current snapshot.
export function scopeFromRequest(request: { question: string; month?: string; category_code?: string; review_status?: string }, snapshotMonth?: string | null): CostScope {
  const kind = request.question as CostKind;
  let review = request.review_status ?? null;
  // pending_summary/top_pending_lines mean needs_review even though the request
  // does not carry an explicit status; keep that intent for a later example.
  if (!review && (kind === 'pending_summary' || kind === 'top_pending_lines')) review = 'needs_review';
  return { kind, month: request.month ?? snapshotMonth ?? null, category_code: request.category_code ?? null, review_status: review };
}

export function selectionFromLine(line: { classification_id?: unknown; month?: unknown }): CostSelection | null {
  if (!validRef(line?.classification_id)) return null;
  return { line_ref: line.classification_id, classification_id: line.classification_id };
}

export function lineBelongsToScope(line: { month?: unknown; category_code?: unknown; review_status?: unknown }, scope: CostScope): boolean {
  if (!line || typeof line !== 'object') return false;
  const lineMonth = typeof line.month === 'string' ? line.month.slice(0, 7) : null;
  if (scope.month && lineMonth !== scope.month) return false;
  if (scope.category_code && line.category_code !== scope.category_code) return false;
  if (scope.review_status && line.review_status !== scope.review_status) return false;
  return true;
}

export function selectionMatches(requested: string, line: { line_ref?: unknown; classification_id?: unknown }): boolean {
  return typeof line?.classification_id === 'string' && line.classification_id === requested;
}
