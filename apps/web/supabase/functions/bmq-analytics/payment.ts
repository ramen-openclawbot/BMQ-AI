// Owner-only supplier-settlement lane. The generic metric DSL cannot express a
// supplier/item filter and the cost lane explicitly abstains on supplier filters, so
// exactly one typed question crosses the bridge: actual payments for one Vietnam
// calendar month, optionally narrowed to one exactly-resolved supplier and one item.
//
// Accounting period is `payments.payment_date` only; the lane never uses a payment
// request's created_at/paid_at. The supplier total is never presented as an item
// amount: an item amount is published only when every allocation in scope belongs to
// a request whose items all resolve to that item, otherwise the item amount is
// explicitly unavailable. A question carrying a qualifier this lane cannot keep
// (day/week/quarter, method/status/account, foreign currency, several suppliers or
// items) abstains instead of widening to an all-supplier total.
import { AnalyticsError, normalize } from './core.ts';

export const PAYMENT_QUESTIONS = ['supplier_payments'] as const;
export type PaymentKind = typeof PAYMENT_QUESTIONS[number];
const MONTH = /^\d{4}-\d{2}$/;
const MAX_TERM = 120;
const MAX_LIMIT = 50;
const ROW_LIMIT = 20;

export type PaymentRequestBody = { question: PaymentKind; month: string; supplier?: string; item?: string; limit?: number };

// A generic word is not an item qualifier ("tiền hàng" means the money for goods).
const ITEM_STOPWORDS = new Set(['hang', 'hang hoa', 'tien', 'tien hang', 'don', 'phieu', 'chi phi', 'cong no',
  'tat ca', 'all', 'nha cung cap', 'ncc', 'supplier', 'thanh toan', 'payment',
  // Month/preposition fragments must never become an item or supplier name.
  'thang', 'thang nay', 'thang truoc', 'trong', 'vao', 'de', 'nam', 'theo', 'cho', 'cua', 'tai']);
// Filler vocabulary used only to decide whether a leading phrase is a real supplier
// name; it is never used to strip words out of a resolved entity name.
const LEADING_FILLER = new Set(['da', 'dang', 'vua', 'moi', 'se', 'tong', 'tat', 'ca', 'bao', 'nhieu', 'the',
  'nao', 'la', 'co', 'khong', 'toan', 'bo', 'cac', 'khoan', 'tien', 'hang', 'mat', 'san', 'pham', 'nguyen',
  'lieu', 'vat', 'tu', 'thanh', 'toan', 'tra', 'chi', 'phi', 'cong', 'no', 'cho', 'cua', 'ncc', 'nha', 'cung',
  'cap', 'supplier', 'thang', 'quy', 'tuan', 'ngay', 'nay', 'truoc', 'roi', 'paid', 'payment']);

export function paymentCuePresent(question: string): boolean {
  const text = normalize(question);
  return /\b(thanh toan|da thanh toan|da tra|tra tien|tra cho|paid|payment|settle)/.test(text);
}

// Purchase-cost / spend wording ("chi phí mua bơ", "tiền mua bơ", "spend on butter").
// It is deliberately NOT a payment cue: it names a buying cost, so the answer must
// keep saying it reports actual recorded payments, never purchase cost or invoice
// value. It requires a buying verb together with a money/cost word, so a pure
// cost-classification question ("chi phí phân loại theo nhóm") is never captured.
const PURCHASE_COST = /\b(chi phi|cost|expense|spend|tien)\b/;
const PURCHASE_VERB = /\b(mua|nhap|purchase|buy|mua hang)\b/;
export function purchaseCuePresent(question: string): boolean {
  const text = normalize(question);
  return PURCHASE_COST.test(text) && PURCHASE_VERB.test(text);
}

// A classification scope (category/review status/classification) makes a
// purchase-cost question genuinely ambiguous: it must not be answered as either a
// cost-classification total or a supplier payment total.
const CLASSIFICATION_QUALIFIER =
  /\b(phan loai|classification|nhom chi phi|danh muc chi phi|theo nhom|trang thai duyet|review status|review_status|da duyet|goi y|tu choi|can review|chua phan loai|do tin cay)\b/;

// Only the actual-payment measure is routed now: purchase-cost wording clarifies
// instead of substituting a payment total, so there is no second measure here.
export type PaymentMeasure = 'payment';

function supplierCuePresent(question: string): boolean {
  const text = normalize(question);
  return /\b(nha cung cap|ncc|supplier|cho|cua|tai)\b/.test(text);
}

function cleanTerm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    // Only question words are removed; a real entity name (including "Công ty A")
    // keeps its own words, so the resolver can match or clarify it exactly.
    .replace(/\b(?:bao nhieu|how much|la bao nhieu)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > MAX_TERM) return undefined;
  if (ITEM_STOPWORDS.has(cleaned)) return undefined;
  return cleaned;
}

function previousMonth(today: string): string {
  const [year, month] = today.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 2, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Explicit calendar months only ("T9", "tháng 9", "tháng 9/2026", "9/2026") plus the
// two relative months. Anything else is not a supported period and clarifies.
function monthFrom(text: string, today: string): { month: string | null; invalid: boolean } {
  const found = new Set<string>();
  let invalid = false;
  const add = (number: string, year: string | undefined) => {
    const value = Number(number);
    if (value < 1 || value > 12) { invalid = true; return; }
    found.add(`${year ?? today.slice(0, 4)}-${String(value).padStart(2, '0')}`);
  };
  for (const match of text.matchAll(/(\d{1,2})\s*\/\s*(\d{4})/g)) add(match[1], match[2]);
  for (const match of text.matchAll(/thang\s*(\d{1,2})(?:\s*(?:nam\s+|[/-]\s*)?(\d{4}))?/g)) add(match[1], match[2]);
  for (const match of text.matchAll(/\bt(\d{1,2})(?:\s*(?:nam\s+|[/-]\s*)?(\d{4}))?\b/g)) add(match[1], match[2]);
  if (!found.size) {
    if (/\b(thang nay|this month)\b/.test(text)) return { month: today.slice(0, 7), invalid: false };
    if (/\b(thang truoc|thang roi|last month|previous month)\b/.test(text)) return { month: previousMonth(today), invalid: false };
  }
  if (invalid || found.size > 1) return { month: null, invalid: true };
  return { month: [...found][0] ?? null, invalid: false };
}

function stripMonths(text: string): string {
  return text
    // Remove the whole period phrase (including the leading preposition) first, so
    // "chi phí mua bơ cho TV Food trong tháng 9" leaves no stray "trong" and
    // "chi phí mua hàng tháng 9/2026" leaves no stray "thang"/year token.
    .replace(/\b(?:trong|vao)\s+thang\s*\d{1,2}(?:\s*(?:nam\s+|[/-]\s*)?\d{4})?/g, ' ')
    .replace(/thang\s*\d{1,2}(?:\s*(?:nam\s+|[/-]\s*)?\d{4})?/g, ' ')
    .replace(/(\d{1,2})\s*\/\s*(\d{4})/g, ' ')
    .replace(/\b(?:trong|vao)\s+t\d{1,2}(?:\s*(?:nam\s+|[/-]\s*)?\d{4})?\b/g, ' ')
    .replace(/\bt\d{1,2}(?:\s*(?:nam\s+|[/-]\s*)?\d{4})?\b/g, ' ')
    .replace(/\b(thang nay|thang truoc|thang roi|this month|last month|previous month)\b/g, ' ');
}

function itemFrom(stripped: string): string | undefined {
  const match = /(?:tien|mat hang|san pham|nguyen lieu|vat tu|item|product)\s+([a-z0-9][a-z0-9 ]*?)(?=\s+(?:cho|cua|ncc|nha cung cap|tai)\b|$)/
    .exec(stripped)
    ?? /\b(?:bao nhieu|how much)\s+([a-z0-9][a-z0-9 ]*?)\s+(?:cho|cua|tai)\b/.exec(stripped)
    // "thanh toán bơ cho TV Food": the item sits between the payment verb and "cho".
    ?? /\b(?:thanh toan|da tra|tra tien|tra)\s+(?:bao nhieu\s+)?([a-z0-9][a-z0-9 ]*?)\s+(?:cho|cua|tai)\b/.exec(stripped)
    // Purchase-cost wording: "chi phí mua bơ [trong tháng 9]" / "chi phí T9 để mua bơ".
    // "mua hàng" alone is generic, so the optional "hang" is consumed and the item
    // must still be a real following term.
    ?? /\b(?:mua|nhap|purchase|buy)\s+(?:hang\s+)?([a-z0-9][a-z0-9 ]*?)(?=\s+(?:cho|cua|tai|trong|theo|va|and)\b|$)/.exec(stripped);
  return match ? cleanTerm(match[1].trim()) : undefined;
}

function supplierFrom(stripped: string): string | undefined {
  const match = /\b(?:nha cung cap|ncc|supplier|tai)\s+(.+)$/.exec(stripped)
    ?? /\b(?:cho|cua)\s+(.+)$/.exec(stripped);
  return match ? cleanTerm(match[1].trim()) : undefined;
}

// "TV Food đã thanh toán T9" puts the supplier before the verb with no marker. Only
// accept it when at least one captured token is not generic payment/question filler,
// so "đã thanh toán …" is not mistaken for a supplier named "đã".
function leadingSupplier(stripped: string): string | undefined {
  const match = /^([a-z0-9][a-z0-9 ]{1,80}?)\s+(?:da\s+|dang\s+|vua\s+|moi\s+|se\s+)?(?:thanh toan|tra tien|paid|payment)\b/.exec(stripped.trim());
  if (!match) return undefined;
  const tokens = match[1].trim().split(' ').filter(Boolean);
  if (!tokens.length || tokens.every((token) => LEADING_FILLER.has(token))) return undefined;
  return cleanTerm(match[1]);
}

function monthCount(text: string): number {
  const found = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})\s*\/\s*(\d{4})/g)) found.add(match[2] + match[1]);
  for (const match of text.matchAll(/thang\s*(\d{1,2})(?:\s*(?:nam\s+|[/-]\s*)?(\d{4}))?/g)) found.add((match[2] ?? '') + match[1]);
  for (const match of text.matchAll(/\bt(\d{1,2})(?:\s*(?:nam\s+|[/-]\s*)?(\d{4}))?\b/g)) found.add((match[2] ?? '') + match[1]);
  return found.size;
}

/**
 * Qualifiers this lane cannot express. Any payment question carrying one of these
 * must abstain rather than return an all-supplier / all-month / all-method total.
 */
export function paymentUnsupportedQualifier(question: string): string | null {
  const text = normalize(question);
  const unsupported: [RegExp, string][] = [
    [/\b(ngay|day)\s+\d{1,2}\b/, 'ngày cụ thể'],
    [/\btheo\s+(ngay|tuan|quy|day|week|quarter)\b/, 'khoảng thời gian ngày/tuần/quý'],
    [/\b(hom nay|today|hom qua|yesterday|tuan nay|this week|tuan truoc|last week|quy nay|this quarter)\b/, 'khoảng thời gian ngày/tuần/quý'],
    [/\b(usd|do la|us\$|euro|eur|jpy|ngoai te|foreign currency)\b/, 'ngoại tệ khác VND'],
    [/\b(ngan hang|tai khoan|phuong thuc thanh toan|payment method|bank|tien mat|cash|chuyen khoan|transfer|the tin dung|credit card)\b/, 'phương thức/tài khoản thanh toán'],
    [/\b(trang thai|status|chua thanh toan|unpaid|da huy|cancelled|partial)\b/, 'trạng thái thanh toán'],
  ];
  for (const [pattern, label] of unsupported) {
    if (pattern.test(text)) {
      return `Câu hỏi dùng ${label} chưa được hỗ trợ cho tra cứu thanh toán nhà cung cấp. Hệ thống chỉ trả theo tháng, nhà cung cấp và mặt hàng; câu trả lời sẽ không được mở rộng thành tổng toàn bộ thanh toán.`;
    }
  }
  if (monthCount(text) > 1) return 'Anh tra từng tháng một; hệ thống chưa cộng nhiều tháng thành một tổng thanh toán.';
  if (/\b(so sanh|compare|chenh lech|difference|so voi)\b/.test(text)) {
    return 'So sánh nhiều kỳ chưa được hỗ trợ cho tra cứu thanh toán nhà cung cấp; câu trả lời sẽ không được mở rộng thành tổng toàn bộ.';
  }
  // Several distinct supplier names must abstain; the redundant "cho nhà cung cấp X"
  // markers for one name must not. Month tokens are stripped first so "cho tháng 9"
  // is not mistaken for a supplier name.
  const withoutPeriod = stripMonths(text);
  const supplierTerms = new Set<string>();
  for (const match of withoutPeriod.matchAll(/\b(?:nha cung cap|ncc|supplier|tai)\s+([a-z0-9][a-z0-9 ]*)/g)) supplierTerms.add(match[1].trim());
  for (const match of withoutPeriod.matchAll(/\b(?:cho|cua)\s+([a-z0-9][a-z0-9 ]*)/g)) {
    supplierTerms.add(match[1].replace(/^(?:nha cung cap|ncc|supplier)\s+/, '').trim());
  }
  supplierTerms.delete('');
  if (supplierTerms.size > 1 || [...supplierTerms].some((term) => /\b(va|and)\b/.test(term))) {
    return 'Câu hỏi nêu nhiều hơn một nhà cung cấp; hệ thống chưa cộng nhiều nhà cung cấp thành một tổng.';
  }
  if (/\b(va|and)\b/.test(text) && /\b(tien|mat hang|san pham|nguyen lieu|vat tu)\b/.test(text)) {
    return 'Câu hỏi nêu nhiều mặt hàng; hệ thống chưa cộng nhiều mặt hàng thành một tổng.';
  }
  return null;
}
/**
 * Deterministic routing for the reviewed payment sentences; null defers to the planner.
 *
 * A purchase-cost/spend question ("chi phí mua bơ trong tháng 9") is NOT answered
 * from the payment lane: no read-only purchase-cost contract exists, so returning
 * an actual-payment total (even with a disclaimer) would substitute a different
 * measure. It clarifies instead, keeping the interpreted item and month. Explicit
 * payment wording ("đã thanh toán ... cho ...") keeps the existing payment flow.
 */
export function paymentDetect(question: string, today: string): { lane: 'payment'; measure: PaymentMeasure; lookup: any } | { lane: 'clarify' | 'abstain'; message: string } | null {
  const paymentCue = paymentCuePresent(question);
  const purchaseCue = purchaseCuePresent(question);
  if (!paymentCue && !purchaseCue) return null;
  const text = normalize(question);
  // A purchase-cost question that names a classification scope is genuinely
  // ambiguous; it is not silently answered as a cost total or a payment total.
  if (purchaseCue && !paymentCue && CLASSIFICATION_QUALIFIER.test(text)) {
    return {
      lane: 'abstain',
      message: 'Câu hỏi vừa hỏi chi phí mua hàng vừa hỏi phân loại chi phí. Anh hỏi riêng từng loại nhé; hệ thống không trộn hai nghĩa và không trả số thay thế.',
    };
  }
  const unsupported = paymentUnsupportedQualifier(question);
  if (unsupported) return { lane: 'abstain', message: unsupported };
  const period = monthFrom(text, today);
  if (period.invalid) return { lane: 'abstain', message: 'Tháng không hợp lệ hoặc có nhiều tháng. Anh dùng một tháng dạng MM/YYYY hoặc T9 nhé.' };
  if (!period.month) {
    return { lane: 'clarify', message: purchaseCue && !paymentCue
      ? 'Anh nêu rõ tháng cần tra chi phí mua hàng (ví dụ T9, tháng 9/2026) nhé.'
      : 'Anh nêu rõ tháng cần tra (ví dụ T9, tháng 9/2026) nhé.' };
  }
  if (period.month > today.slice(0, 7)) return { lane: 'abstain', message: 'Tháng yêu cầu nằm trong tương lai nên chưa có thanh toán.' };
  const stripped = stripMonths(text);
  const item = itemFrom(stripped);
  const supplier = supplierFrom(stripped) ?? leadingSupplier(stripped);
  // Purchase-cost wording is clarified with the interpreted item/month retained;
  // a payment total is never substituted, with or without a disclaimer.
  if (purchaseCue && !paymentCue) {
    const scope = [item ? `mặt hàng "${item}"` : null, `tháng ${period.month}`].filter(Boolean).join(', ');
    if (!item) {
      return {
        lane: 'clarify',
        message: `Anh nêu rõ mặt hàng cần tra chi phí mua (ví dụ: bơ) và tháng nhé. Hệ thống chỉ có luồng đọc thanh toán thực tế theo tháng/nhà cung cấp/mặt hàng, nên không trả tổng thanh toán thay cho chi phí mua hàng.`,
      };
    }
    return {
      lane: 'clarify',
      message: `Câu hỏi là chi phí mua hàng (${scope}). Hệ thống chỉ có luồng đọc thanh toán thực tế theo tháng/nhà cung cấp/mặt hàng, nên không trả số thanh toán thay cho chi phí mua hàng. Anh muốn xem thanh toán thực tế thì hỏi rõ "đã thanh toán ... cho ... trong tháng ..." nhé.`,
    };
  }
  if (!supplier && supplierCuePresent(question)) {
    return { lane: 'clarify', message: 'Anh nêu rõ tên nhà cung cấp sau "cho"/"của"/"ncc" nhé; hệ thống không trả tổng tất cả nhà cung cấp thay thế.' };
  }
  return {
    lane: 'payment',
    measure: 'payment',
    lookup: { kind: 'supplier_payments', month: period.month, ...(supplier ? { supplier } : {}), ...(item ? { item } : {}) },
  };
}

/** Closed request grammar; unknown fields and identity are rejected. */
export function paymentRequest(lookup: any): PaymentRequestBody {
  if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup)) throw new AnalyticsError('invalid_plan');
  if (lookup.kind !== 'supplier_payments') throw new AnalyticsError('invalid_plan');
  const provided = Object.fromEntries(Object.entries(lookup).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  const allowed = ['kind', 'month', 'supplier', 'item', 'limit'];
  if (Object.keys(provided).some((key) => !allowed.includes(key))) throw new AnalyticsError('invalid_plan');
  const month = provided.month;
  if (typeof month !== 'string' || !MONTH.test(month)) throw new AnalyticsError('invalid_plan');
  const [year, number] = month.split('-').map(Number);
  if (year < 2000 || year > 2100 || number < 1 || number > 12) throw new AnalyticsError('invalid_plan');
  const body: PaymentRequestBody = { question: 'supplier_payments', month };
  for (const field of ['supplier', 'item'] as const) {
    if (provided[field] === undefined) continue;
    const value = provided[field];
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TERM || /\p{Cc}/u.test(value)) throw new AnalyticsError('invalid_plan');
    body[field] = value.trim();
  }
  if (provided.limit !== undefined) {
    if (!Number.isInteger(provided.limit) || (provided.limit as number) < 1 || (provided.limit as number) > MAX_LIMIT) throw new AnalyticsError('invalid_plan');
    body.limit = provided.limit as number;
  }
  return body;
}

export function missingPaymentQualifier(lookup: any, language: 'en' | 'vi') {
  if (!lookup || typeof lookup !== 'object' || lookup.kind !== 'supplier_payments') return null;
  const missingMonth = typeof lookup.month !== 'string' || !MONTH.test(lookup.month);
  if (missingMonth) return language === 'en' ? 'Which month should I use? Send it as MM/YYYY.' : 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.';
  return null;
}

const clean = (value: unknown, max = 200) => {
  if (typeof value !== 'string' || value.length > max || /\p{Cc}/u.test(value)) throw new AnalyticsError('invalid_result');
  return value.replace(/[\\`*_{}[\]()<>#!|]/g, ' ').trim();
};
const amount = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') throw new AnalyticsError('invalid_result');
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AnalyticsError('invalid_result');
  return parsed;
};
const money = (value: unknown, en: boolean) => en
  ? `${amount(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} VND`
  : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount(value));
const count = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 0) throw new AnalyticsError('invalid_result');
  return Number(value);
};
const monthLabel = (value: unknown) => {
  const raw = clean(value, 10);
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new AnalyticsError('invalid_result');
  return `${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
};
const dayLabel = (value: unknown) => {
  const raw = clean(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AnalyticsError('invalid_result');
  return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
};

function provenance(result: any, en: boolean) {
  if (typeof result.source !== 'string' || !result.source || typeof result.source_observed_at !== 'string'
    || !Number.isFinite(Date.parse(result.source_observed_at)) || typeof result.snapshot_id !== 'string'
    || typeof result.semantic_version !== 'string' || JSON.stringify(result).length > 40000) throw new AnalyticsError('invalid_result');
  return `\n${en ? 'Source' : 'Nguồn'}: ${clean(result.source, 300)}\n${en ? 'Synced snapshot' : 'Dữ liệu đồng bộ lúc'}: ${clean(result.source_observed_at, 40)} · ${clean(result.semantic_version, 40)}`;
}

const DISCLAIMER_VI = 'Đây là các phiếu thanh toán thực tế đã ghi nhận (payments), không phải công nợ, số đã chi theo yêu cầu hay tiền thu khách hàng. Kỳ tính theo ngày thanh toán (payments.payment_date).';
const DISCLAIMER_EN = 'Actual recorded supplier payments, not supplier debt, requested spend or customer receipts. The period is the payment date (payments.payment_date).';

export function paymentAnswer(result: any, language: 'en' | 'vi' = 'vi') {
  const en = language === 'en';
  if (!result || result.question !== 'supplier_payments') throw new AnalyticsError('invalid_result');
  const suffix = provenance(result, en);
  const lines: string[] = [];
  if (result.supplier_status === 'ambiguous') {
    const candidates = Array.isArray(result.supplier_candidates) ? result.supplier_candidates : [];
    lines.push(en
      ? `The supplier name matches ${candidates.length} suppliers. Send the exact supplier name.`
      : `Tên nhà cung cấp khớp ${candidates.length} nhà cung cấp. Anh gửi đúng tên nhà cung cấp nhé.`);
    for (const candidate of candidates) lines.push(`- ${clean(candidate.name, 200)}${candidate.short_code ? ` (${clean(candidate.short_code, 40)})` : ''}`);
    lines.push(en ? 'No supplier total was answered.' : 'Hệ thống không trả tổng thanh toán thay thế.');
    return lines.join('\n') + suffix;
  }
  if (result.supplier_status === 'not_found') {
    lines.push(en ? 'No supplier matches that name.' : 'Không tìm thấy nhà cung cấp ứng với tên đã gửi.');
    lines.push(en ? 'No all-supplier total was substituted.' : 'Hệ thống không trả tổng tất cả nhà cung cấp thay thế.');
    for (const candidate of Array.isArray(result.supplier_candidates) ? result.supplier_candidates.slice(0, 5) : []) {
      lines.push(`- ${clean(candidate.name, 200)}`);
    }
    return lines.join('\n') + suffix;
  }
  const who = result.supplier ? clean(result.supplier.name, 200) : (en ? 'all suppliers' : 'tất cả nhà cung cấp');
  lines.push(`${en ? 'Actual supplier payments' : 'Thanh toán thực tế cho nhà cung cấp'} · ${monthLabel(result.month)} · ${who}`);
  lines.push(`${en ? 'Total paid' : 'Tổng đã thanh toán'} (${en ? 'payment date' : 'ngày thanh toán'}): ${money(result.total_amount, en)}`);
  if (amount(result.shared_allocated_total) > 0) {
    lines.push(`${en ? 'Direct' : 'Trả trực tiếp'}: ${money(result.direct_total, en)} · ${en ? 'allocated share of multi-supplier payments' : 'phần phân bổ từ phiếu thanh toán nhiều NCC'}: ${money(result.shared_allocated_total, en)}`);
    lines.push(en
      ? 'Each payment is counted once: a multi-supplier payment contributes only its allocated share, never the whole amount.'
      : 'Mỗi phiếu chỉ được tính một lần: phiếu nhiều NCC chỉ tính phần phân bổ, không tính toàn bộ số tiền.');
  }
  if (!Array.isArray(result.payments) || result.payments.length > MAX_LIMIT) throw new AnalyticsError('invalid_result');
  for (const row of result.payments) {
    const shared = row.shared === true ? (en ? ' · allocated share' : ' · phần phân bổ') : '';
    lines.push(`- ${clean(row.payment_number, 40)} · ${dayLabel(row.payment_date)} · ${money(row.attributed_amount, en)}${shared}`);
  }
  if (!result.payments.length) lines.push(en ? 'No recorded payment in this scope; this is not a confirmed zero balance.' : 'Không có phiếu thanh toán nào được ghi nhận trong phạm vi này; không đồng nghĩa số dư bằng 0.');
  if (result.truncated) lines.push(en ? 'Showing only the most recent payments; the total covers every payment in scope.' : 'Chỉ hiển thị các phiếu gần nhất; tổng vẫn gồm toàn bộ phiếu trong phạm vi.');
  const item = result.item;
  if (item && typeof item === 'object') {
    // Prefer the identity the lane actually resolved to over the folded user term.
    const term = clean(item.material?.canonical_name || item.product_name || item.term, 120);
    if (result.item_status === 'exact') {
      lines.push(`${en ? 'Item amount' : 'Giá trị theo mặt hàng'} ${term}: ${money(result.item_amount, en)}`);
      lines.push(en
        ? 'The amount actually allocated to requests whose every line resolves to this item (it can be less than the request total); the supplier total above is a different figure.'
        : 'Số tiền thực tế đã phân bổ cho các phiếu mà toàn bộ dòng hàng thuộc mặt hàng này (có thể nhỏ hơn tổng của phiếu); tổng theo nhà cung cấp ở trên là số khác.');
    } else if (result.item_status === 'unavailable') {
      lines.push(`${en ? 'Item amount for' : 'Chưa xác định được phần thanh toán riêng cho'} ${term}: ${en ? 'not determinable' : 'không xác định được'}.`);
      lines.push(`${en ? 'Unresolved lines' : 'Dòng chưa gắn mã vật tư chuẩn'}: ${count(result.unresolved_item_count)}${Array.isArray(result.candidate_items) && result.candidate_items.length ? ` (${result.candidate_items.map((name: unknown) => clean(name, 200)).join(', ')})` : ''}`);
      lines.push(en
        ? 'The supplier total above is not an item amount; no proportional split was made and no zero was claimed.'
        : 'Tổng theo nhà cung cấp ở trên không phải số theo mặt hàng; hệ thống không chia tỷ lệ và không kết luận bằng 0.');
    } else if (result.item_status === 'not_found') {
      lines.push(`${en ? 'No material or request product matches' : 'Không tìm thấy vật tư/mặt hàng khớp'} "${term}"; ${en ? 'no item amount was guessed.' : 'hệ thống không suy diễn số theo mặt hàng.'}`);
      // Show the stored rows that could be the item so the user can clarify without
      // the system inventing a canonical identity.
      const candidates = Array.isArray(result.candidate_items) ? result.candidate_items.slice(0, 10) : [];
      if (candidates.length) lines.push(`${en ? 'Unlinked lines in scope' : 'Dòng hàng trong phạm vi chưa gắn mã vật tư chuẩn'}: ${candidates.map((name: unknown) => clean(name, 200)).join(', ')}`);
      lines.push(en ? 'The supplier total above is a separate figure.' : 'Tổng theo nhà cung cấp ở trên là số riêng.');
    } else if (result.item_status === 'ambiguous') {
      lines.push(`${en ? 'The item name is ambiguous' : 'Tên mặt hàng chưa rõ'}: ${(Array.isArray(result.item_candidates) ? result.item_candidates : []).map((name: unknown) => clean(name, 200)).join(', ')}. ${en ? 'Send the exact material code or name.' : 'Anh gửi đúng mã hoặc tên vật tư nhé.'}`);
      lines.push(en ? 'The supplier total above is a separate figure.' : 'Tổng theo nhà cung cấp ở trên là số riêng.');
    }
  }
  lines.push(en ? DISCLAIMER_EN : DISCLAIMER_VI);
  return lines.join('\n') + suffix;
}
