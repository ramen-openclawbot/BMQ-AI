import { AnalyticsError, normalize } from './core.ts';

// Bounded, read-only cost-classification lane. The generic DSL cannot express a
// review_status filter, so only these seven typed questions cross the bridge.
export const COST_KINDS = ['month_totals', 'pending_summary', 'top_pending_lines', 'category_comparison', 'unmapped_low_confidence', 'line_explanation', 'sync_freshness'] as const;
export type CostKind = typeof COST_KINDS[number];
const REQUIRED: Record<CostKind, string[]> = {
  month_totals: ['month'], pending_summary: ['month'], top_pending_lines: ['month'],
  category_comparison: ['month', 'month_b'], unmapped_low_confidence: ['month'],
  line_explanation: ['line_ref'], sync_freshness: [],
};
// Mirrors the closed grammar in sme_platform.bmq_cost.QUESTIONS: a qualifier that
// a question does not accept is rejected instead of silently dropped.
const OPTIONAL: Record<CostKind, string[]> = {
  month_totals: ['category_code', 'review_status', 'limit'],
  pending_summary: ['category_code'],
  top_pending_lines: ['category_code', 'limit'],
  category_comparison: ['category_code', 'review_status', 'limit'],
  unmapped_low_confidence: ['limit'],
  line_explanation: [],
  sync_freshness: [],
};
const MONTH = /^\d{4}-\d{2}$/;
const CATEGORY = /^[A-Z][A-Z0-9_]{0,49}$/;
const REFERENCE = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const UUID_ALL = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const STATUSES = ['needs_review', 'suggested', 'approved', 'rejected'] as const;

// Canonical category labels accepted by the deterministic lane, matched after
// diacritic folding (see core.normalize). The catalog lists the same canonical
// codes, so the planner can resolve a label for a history follow-up.
const CATEGORY_LABELS: [RegExp, string][] = [
  [/banh mi|bmq bread/, 'COGS_BMQ_BREAD'],
  [/banh ngot|sweet kitchen/, 'COGS_SWEET_KITCHEN'],
  [/bao bi|tem nhan|vat tu ban hang|packaging/, 'PACKAGING_SALES'],
  [/van hanh|opex/, 'OPEX_GENERAL'],
  [/kho bep|ccdc|ve sinh|sua chua|kitchen supply/, 'KITCHEN_SUPPLY_REPAIR'],
  [/tai san|may moc|thi cong|capex/, 'CAPEX_ASSET_PROJECT'],
];

export function costRequest(lookup: any) {
  if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup)) throw new AnalyticsError('invalid_plan');
  if (!COST_KINDS.includes(lookup.kind)) throw new AnalyticsError('invalid_plan');
  const kind = lookup.kind as CostKind;
  // Empty/null/undefined values are "not provided" so an unused schema field is
  // tolerated, but any non-empty qualifier this question does not accept fails.
  const provided = Object.fromEntries(Object.entries(lookup).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  const allowed = ['kind', ...REQUIRED[kind], ...OPTIONAL[kind]];
  if (Object.keys(provided).some((key) => !allowed.includes(key))) throw new AnalyticsError('invalid_plan');
  const body: Record<string, unknown> = { question: kind };
  for (const field of REQUIRED[kind]) {
    if (typeof provided[field] !== 'string' || !provided[field]) throw new AnalyticsError('invalid_plan');
  }
  if (provided.month !== undefined) {
    if (typeof provided.month !== 'string' || !MONTH.test(provided.month)) throw new AnalyticsError('invalid_plan');
    body.month = provided.month;
  }
  if (provided.month_b !== undefined) {
    if (typeof provided.month_b !== 'string' || !MONTH.test(provided.month_b) || provided.month_b === provided.month) throw new AnalyticsError('invalid_plan');
    body.month_b = provided.month_b;
  }
  if (provided.category_code !== undefined) {
    if (typeof provided.category_code !== 'string' || !CATEGORY.test(provided.category_code)) throw new AnalyticsError('invalid_plan');
    body.category_code = provided.category_code;
  }
  if (provided.review_status !== undefined) {
    if (!STATUSES.includes(provided.review_status as (typeof STATUSES)[number])) throw new AnalyticsError('invalid_plan');
    body.review_status = provided.review_status;
  }
  if (provided.line_ref !== undefined) {
    if (typeof provided.line_ref !== 'string' || !REFERENCE.test(provided.line_ref)) throw new AnalyticsError('invalid_plan');
    body.line_ref = provided.line_ref;
  }
  if (provided.limit !== undefined) {
    if (!Number.isInteger(provided.limit) || (provided.limit as number) < 1 || (provided.limit as number) > 50) throw new AnalyticsError('invalid_plan');
    body.limit = provided.limit;
  }
  return body;
}

export function missingCostQualifier(lookup: any, language: 'en' | 'vi') {
  if (!lookup || typeof lookup !== 'object' || !COST_KINDS.includes(lookup.kind)) return null;
  const missing = REQUIRED[lookup.kind as CostKind].filter((field) => typeof lookup[field] !== 'string' || !lookup[field]);
  if (!missing.length) return null;
  const en = language === 'en';
  if (missing.includes('line_ref')) return en ? 'Which exact line should I explain? Send the classification id or source line id.' : 'Anh gửi mã dòng phân loại hoặc mã dòng nguồn cần giải thích nhé.';
  if (missing.includes('month_b')) return en ? 'Which two months should I compare? Send both months as MM/YYYY.' : 'Anh nêu rõ hai tháng cần so sánh theo dạng MM/YYYY nhé.';
  return en ? 'Which month should I use? Send it as MM/YYYY.' : 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.';
}

/**
 * Qualifiers this lane cannot express. Any cost question carrying one of these
 * must abstain (never return a month-wide/all-category total with the qualifier
 * silently dropped). Shared by the deterministic lane and the planner guard.
 */
export function costUnsupportedQualifier(question: string): string | null {
  const text = normalize(question).replace(/đ/g, 'd');
  const categories = new Set(CATEGORY_LABELS.filter(([pattern]) => pattern.test(text)).map(([, code]) => code));
  for (const match of question.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) categories.add(match[0]);
  if (categories.size > 1) return 'Anh hỏi từng nhóm chi phí hoặc tổng theo tất cả nhóm nhé; hệ thống chưa hỗ trợ chọn nhiều nhóm trong một bộ lọc.';
  const unsupported: [RegExp, string][] = [
    [/\b(ngay|day)\s+\d{1,2}\b/, 'ngày cụ thể'],
    [/\btheo\s+(ngay|day|tuan|quy)\b/, 'khoảng thời gian ngày/tuần/quý'],
    [/\b(hom nay|today|tuan nay|this week|quy nay|this quarter)\b/, 'khoảng thời gian ngày/tuần/quý'],
    [/\b(usd|do la|us\$|euro|eur|jpy|ngoai te|foreign currency)\b/, 'ngoại tệ khác VND'],
    [/\btheo\s+(nhan vien|phong ban|bo phan|ngan hang|tai khoan|du an|chi nhanh|khoi|tuyen|route|gio)\b/, 'tiêu chí chưa hỗ trợ'],
    [/\b(nhan vien|phong ban|ngan hang|du an|chi nhanh)\b/, 'tiêu chí chưa hỗ trợ'],
  ];
  for (const [pattern, label] of unsupported) {
    if (pattern.test(text)) {
      return `Câu hỏi dùng ${label} chưa được hỗ trợ cho phân loại chi phí. Hệ thống chỉ trả theo tháng, nhóm chi phí, trạng thái duyệt và dòng cụ thể; câu trả lời sẽ không được mở rộng thành tổng toàn bộ chi phí.`;
    }
  }
  // "kèm nhà cung cấp" is a supported output column on the pending-line answer;
  // any other supplier mention is an unsupported filter and must not be dropped.
  const mentionsSupplier = /\b(nha cung cap|ncc|supplier)\b/.test(text);
  const outputPhrase = /\b(kem|with|gom|including)\s+(nha cung cap|ncc|supplier)\b/.test(text)
    || /\b(nha cung cap|ncc|supplier)\s+(va|and)\s+(chung tu|document|so chung tu)\b/.test(text);
  if (mentionsSupplier && !outputPhrase) {
    return 'Câu hỏi dùng lọc theo nhà cung cấp chưa được hỗ trợ cho phân loại chi phí. Hệ thống chỉ trả theo tháng, nhóm chi phí, trạng thái duyệt và dòng cụ thể; câu trả lời sẽ không được mở rộng thành tổng toàn bộ chi phí.';
  }
  return null;
}

const MONTH_MM_YYYY = /thang\s*(\d{1,2})\s*[/-]\s*(\d{4})/g;
const MONTH_ISO = /(\d{4})-(\d{2})/g;

function monthsIn(text: string): { months: string[]; invalid: boolean } {
  const found: { index: number; value: string }[] = [];
  let invalid = false;
  for (const match of text.matchAll(MONTH_MM_YYYY)) {
    const monthNumber = Number(match[1]);
    if (monthNumber < 1 || monthNumber > 12) { invalid = true; continue; }
    found.push({ index: match.index ?? 0, value: `${match[2]}-${String(monthNumber).padStart(2, '0')}` });
  }
  for (const match of text.matchAll(MONTH_ISO)) {
    const monthNumber = Number(match[2]);
    if (monthNumber < 1 || monthNumber > 12) { invalid = true; continue; }
    found.push({ index: match.index ?? 0, value: `${match[1]}-${String(monthNumber).padStart(2, '0')}` });
  }
  const months = found.sort((a, b) => a.index - b.index).map((entry) => entry.value);
  return { months: [...new Set(months)], invalid };
}

function categoryIn(text: string, question: string): string | undefined {
  const code = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/.exec(question);
  if (code) return code[1];
  for (const [pattern, canonical] of CATEGORY_LABELS) {
    if (pattern.test(text)) return canonical;
  }
  return undefined;
}

/** Canonical category code implied by an exact code or Vietnamese label; used by the planner guard. */
export function costCategoryFromQuestion(question: string): string | undefined {
  return categoryIn(normalize(question).replace(/đ/g, 'd'), question);
}

/** Deterministic routing for the exact reviewed cost questions; null defers to the planner. */
export function costDetect(question: string, today: string): { lane: 'cost' | 'clarify' | 'abstain'; lookup?: any; message?: string } | null {
  const text = normalize(question).replace(/đ/g, 'd');
  const lineRef = UUID.exec(question);
  const costRelated = /(chi phi|cost|expense)/.test(text)
    || (/(dong|khoan)/.test(text) && /review/.test(text) && /thang/.test(text))
    || (/phan loai/.test(text) && /dong bo/.test(text))
    || (/(unmapped|chua phan loai)/.test(text) && /phan loai|classification|review/.test(text))
    || (/(vi sao|tai sao|why)/.test(text) && /phan loai|classification/.test(text) && Boolean(lineRef));
  if (!costRelated) return null;
  const unsupported = costUnsupportedQualifier(question);
  if (unsupported) return { lane: 'abstain', message: unsupported };

  const periodText = text.replace(UUID_ALL, ' ');
  const { months, invalid } = monthsIn(periodText);
  if (invalid) return { lane: 'abstain', message: 'Tháng không hợp lệ. Anh dùng dạng MM/YYYY nhé.' };
  if (months.length > 2) return { lane: 'abstain', message: 'Anh chọn một tháng hoặc đúng hai tháng để so sánh nhé.' };
  const month = months[0] ?? null;
  if (month && month > today.slice(0, 7)) {
    return { lane: 'abstain', message: 'Tháng yêu cầu nằm trong tương lai nên chưa có dữ liệu phân loại.' };
  }
  const category = categoryIn(text, question);
  const base = (kind: CostKind, extra: Record<string, unknown> = {}) => {
    const lookup: Record<string, unknown> = { kind, month, category_code: category };
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) lookup[key] = value;
    return { lane: 'cost' as const, lookup };
  };

  // "All statuses" phrasing must never be narrowed to the pending branch merely
  // because it also mentions "cần review".
  const allStatuses = /(tat ca trang thai|all statuses|moi trang thai|toan bo trang thai|gom ca|bao gom ca|including all|nhom va trang thai|by category and (review )?status)/.test(text)
    || (/tach/.test(text) && /da duyet/.test(text) && /goi y/.test(text) && /can review/.test(text));
  const statuses = new Set<(typeof STATUSES)[number]>();
  if (!allStatuses) {
    if (/(da duyet|approved)/.test(text)) statuses.add('approved');
    if (/(goi y|suggested)/.test(text)) statuses.add('suggested');
    if (/(tu choi|rejected)/.test(text)) statuses.add('rejected');
    if (/(can review|cho review|can kiem tra|pending|cho xu ly|needs review)/.test(text)) statuses.add('needs_review');
  }
  const statusList = [...statuses];
  if (statusList.length > 1) return { lane: 'abstain', message: 'Câu hỏi gộp nhiều trạng thái duyệt chưa được hỗ trợ. Anh hỏi từng trạng thái hoặc tổng tất cả trạng thái nhé.' };

  if (/(dong bo|sync)/.test(text) && /(chi phi|phan loai|cost)/.test(text)) {
    return { lane: 'cost', lookup: { kind: 'sync_freshness' } };
  }
  if (/(vi sao|tai sao|why|ly do)/.test(text) && /(phan loai|classified|classification|xep.*nhom chi phi)/.test(text)) {
    if (!lineRef) return { lane: 'clarify', message: 'Anh gửi mã dòng phân loại hoặc mã dòng nguồn cần giải thích nhé.' };
    return { lane: 'cost', lookup: { kind: 'line_explanation', line_ref: lineRef[0] } };
  }
  if (/(so sanh|compare|chenh lech|difference|so voi|thay doi)/.test(text) && /(thang|month)/.test(text)) {
    if (months.length < 2) return { lane: 'clarify', message: 'Anh nêu rõ hai tháng cần so sánh theo dạng MM/YYYY nhé.' };
    if (months[0] === months[1]) return { lane: 'abstain', message: 'Hai tháng so sánh phải khác nhau.' };
    if (months.some((value) => value > today.slice(0, 7))) return { lane: 'abstain', message: 'Tháng yêu cầu nằm trong tương lai nên chưa có dữ liệu phân loại.' };
    // "September compared with August" means September minus August.
    const [first, second] = /so voi/.test(text) ? [months[1], months[0]] : months;
    return base('category_comparison', { month: first, month_b: second, review_status: statusList[0] });
  }
  if (months.length > 1) return { lane: 'clarify', message: 'Anh muốn so sánh hai tháng hay tra riêng từng tháng? Hệ thống chưa cộng nhiều tháng thành một tổng.' };
  if (/unmapped|chua phan loai|do tin cay thap|confidence thap|tin cay thap/.test(text)) {
    if (statusList.length || allStatuses || category) return { lane: 'abstain', message: 'Câu hỏi chưa phân loại không nhận thêm bộ lọc nhóm hoặc trạng thái duyệt khác. Anh hỏi riêng từng câu nhé.' };
    if (!month) return { lane: 'clarify', message: 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.' };
    return base('unmapped_low_confidence');
  }
  if (/(top\s*10|top\s*muoi|10 dong|muoi dong|lon nhat|largest|biggest)/.test(text)) {
    if (!month) return { lane: 'clarify', message: 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.' };
    if (statusList.length && statusList[0] !== 'needs_review') return { lane: 'abstain', message: 'Danh sách lớn nhất chỉ hỗ trợ dòng chờ review. Anh dùng tổng theo nhóm và trạng thái cho trạng thái khác nhé.' };
    if (allStatuses || !statuses.has('needs_review')) {
      return { lane: 'clarify', message: 'Anh muốn top 10 dòng chờ review hay top 10 của toàn bộ trạng thái? Hệ thống chỉ xếp hạng dòng chờ review.' };
    }
    return base('top_pending_lines');
  }
  if (statusList.length === 1) {
    if (!month) return { lane: 'clarify', message: 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.' };
    if (statusList[0] === 'needs_review') return base('pending_summary');
    return base('month_totals', { review_status: statusList[0] });
  }
  if (allStatuses && /chi phi|cost|expense/.test(text)) {
    if (!month) return { lane: 'clarify', message: 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.' };
    return base('month_totals');
  }
  if (/chi phi|cost|expense/.test(text) && /(tong|theo nhom|trang thai|category|status)/.test(text)) {
    if (!month) return { lane: 'clarify', message: 'Anh nêu rõ tháng cần tra theo dạng MM/YYYY nhé.' };
    return base('month_totals');
  }
  if (month) return base('month_totals');
  return { lane: 'clarify', message: 'Anh nêu rõ câu hỏi phân loại chi phí theo tháng, nhóm, trạng thái duyệt hoặc mã dòng cụ thể nhé.' };
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

function provenance(result: any, en: boolean) {
  if (typeof result.source !== 'string' || !result.source || typeof result.source_observed_at !== 'string'
    || !Number.isFinite(Date.parse(result.source_observed_at)) || typeof result.snapshot_id !== 'string'
    || typeof result.semantic_version !== 'string' || JSON.stringify(result).length > 40000) throw new AnalyticsError('invalid_result');
  return `\n${en ? 'Source' : 'Nguồn'}: ${clean(result.source, 300)}\n${en ? 'Synced snapshot' : 'Dữ liệu đồng bộ lúc'}: ${clean(result.source_observed_at, 40)} · ${clean(result.semantic_version, 40)}`;
}

const DISCLAIMER_VI = 'Toàn bộ dòng chi phí theo view phân loại chuẩn (dòng đã phân loại + dòng OCR-only có metadata chi phí), không phải báo cáo đã kiểm toán.';
const DISCLAIMER_EN = 'Full canonical cost-classification view (classified + OCR-only lines), not an audited statement.';

export function costAnswer(result: any, kind: CostKind, language: 'en' | 'vi') {
  const en = language === 'en';
  if (!result || result.question !== kind) throw new AnalyticsError('invalid_result');
  const suffix = provenance(result, en);
  const lines: string[] = [];
  if (kind === 'month_totals' || kind === 'pending_summary') {
    const month = monthLabel(result.month);
    lines.push(`${en ? 'Canonical cost totals' : 'Tổng chi phí theo view chuẩn'} · ${month}`);
    if (result.review_status) lines.push(`${en ? 'Review status filter' : 'Lọc trạng thái'}: ${clean(result.review_status, 40)}`);
    if (!Array.isArray(result.rows) || !Array.isArray(result.statuses) || result.rows.length > 200) throw new AnalyticsError('invalid_result');
    const labels: Record<string, [string, string]> = { needs_review: ['Cần review', 'Needs review'], suggested: ['Gợi ý', 'Suggested'], approved: ['Đã duyệt', 'Approved'], rejected: ['Từ chối', 'Rejected'] };
    for (const status of result.statuses) {
      const [vi, eng] = labels[status.review_status] ?? [status.review_status, status.review_status];
      lines.push(`${en ? eng : vi}: ${count(status.line_count)} ${en ? 'lines' : 'dòng'} · ${money(status.total_amount, en)}`);
    }
    lines.push(`${en ? 'All statuses' : 'Tổng tất cả trạng thái'}: ${count(result.line_count)} ${en ? 'lines' : 'dòng'} · ${money(result.total_amount, en)}`);
    if (kind === 'month_totals') {
      for (const row of result.rows) lines.push(`- ${clean(row.category_label, 200)} · ${clean(row.review_status, 40)}: ${count(row.line_count)} ${en ? 'lines' : 'dòng'} · ${money(row.total_amount, en)}`);
    }
    if (count(result.line_count) === 0) lines.push(en ? 'No cost line in this month under the canonical view; this does not mean zero spend.' : 'Không có dòng chi phí trong tháng này theo view chuẩn; không đồng nghĩa chi phí bằng 0.');
  } else if (kind === 'top_pending_lines') {
    const month = monthLabel(result.month);
    lines.push(`${en ? 'Largest pending review lines' : 'Dòng chờ review lớn nhất'} · ${month} · ${count(result.pending_line_count)} ${en ? 'lines' : 'dòng'} · ${money(result.pending_amount, en)}`);
    if (!Array.isArray(result.rows) || result.rows.length > 50) throw new AnalyticsError('invalid_result');
    for (const row of result.rows) {
      lines.push(`- ${clean(row.source_date, 10)} · ${clean(row.source_number ?? '-', 120)} · ${clean(row.supplier_name ?? '-', 200)} · ${clean(row.product_name, 200)}: ${money(row.line_amount, en)} · ${clean(row.review_status, 40)}`);
    }
    if (!result.rows.length) lines.push(en ? 'No pending review line in this month.' : 'Không có dòng chờ review trong tháng này.');
    if (result.truncated) lines.push(en ? 'Showing only the largest lines; totals cover every pending line.' : 'Chỉ hiển thị các dòng lớn nhất; tổng vẫn gồm toàn bộ dòng chờ review.');
  } else if (kind === 'category_comparison') {
    if (!Array.isArray(result.rows) || result.rows.length > 50) throw new AnalyticsError('invalid_result');
    lines.push(`${en ? 'Category comparison' : 'So sánh nhóm chi phí'} · ${monthLabel(result.month)} → ${monthLabel(result.month_b)}`);
    for (const row of result.rows) {
      lines.push(`- ${clean(row.category_label, 200)}: ${monthLabel(result.month)} ${count(row.line_count_a)} ${en ? 'lines' : 'dòng'} · ${money(row.total_amount_a, en)} | ${monthLabel(result.month_b)} ${count(row.line_count_b)} ${en ? 'lines' : 'dòng'} · ${money(row.total_amount_b, en)} | ${en ? 'difference' : 'chênh lệch'} ${money(row.difference, en)}`);
    }
    if (result.truncated) lines.push(en ? 'Partial category list; difference is only for the shown categories.' : 'Danh sách nhóm bị giới hạn; chênh lệch chỉ cho các nhóm hiển thị.');
  } else if (kind === 'unmapped_low_confidence') {
    lines.push(`${en ? 'Unmapped and low-confidence' : 'Chưa phân loại và độ tin cậy thấp'} · ${monthLabel(result.month)} · ${en ? 'threshold' : 'ngưỡng'} ${clean(result.threshold, 10)}`);
    lines.push(`${en ? 'Unmapped' : 'Chưa phân loại'}: ${count(result.unmapped_count)} ${en ? 'lines' : 'dòng'} · ${money(result.unmapped_amount, en)}`);
    lines.push(`${en ? 'Low confidence (non-unmapped)' : 'Độ tin cậy thấp (không gồm chưa phân loại)'}: ${count(result.low_confidence_count)} ${en ? 'lines' : 'dòng'} · ${money(result.low_confidence_amount, en)}`);
    if (!Array.isArray(result.rows) || result.rows.length > 50) throw new AnalyticsError('invalid_result');
    for (const row of result.rows) lines.push(`- ${clean(row.source_date, 10)} · ${clean(row.source_number ?? '-', 120)} · ${clean(row.product_name, 200)}: ${money(row.line_amount, en)} · ${row.unmapped ? (en ? 'unmapped' : 'chưa phân loại') : (en ? 'low confidence' : 'độ tin cậy thấp')}`);
    if (result.truncated) lines.push(en ? 'Showing only the largest lines; counts cover all matching lines.' : 'Chỉ hiển thị các dòng lớn nhất; số đếm gồm toàn bộ dòng phù hợp.');
  } else if (kind === 'line_explanation') {
    if (result.status === 'not_found') lines.push(en ? 'No classification row matches that line reference.' : 'Không tìm thấy dòng phân loại ứng với mã đã gửi.');
    else if (result.status === 'ambiguous') {
      lines.push(en ? `The reference matches ${count(result.match_count)} lines. Please resend the exact classification id.` : `Mã này khớp ${count(result.match_count)} dòng. Anh gửi đúng mã phân loại (classification id) nhé.`);
      for (const candidate of result.candidates ?? []) lines.push(`- ${clean(candidate.classification_id, 64)} · ${clean(candidate.source_number ?? '-', 120)} · ${clean(String(candidate.source_date ?? '-'), 10)} · ${money(candidate.line_amount, en)}`);
    } else if (result.status === 'ok') {
      const line = result.line, evidence = result.evidence ?? {};
      lines.push(`${en ? 'Line' : 'Dòng'} ${clean(line.classification_id, 64)} · ${clean(line.source_number ?? '-', 120)} · ${clean(String(line.source_date ?? '-'), 10)}`);
      lines.push(`${clean(line.category_label, 200)} (${clean(line.category_code, 60)}) · ${clean(line.review_status, 40)} · ${en ? 'confidence' : 'độ tin cậy'} ${clean(String(line.confidence ?? '-'), 20)}`);
      lines.push(`${en ? 'Supplier' : 'Nhà cung cấp'}: ${clean(line.supplier_name ?? '-', 200)} · ${clean(line.product_name, 200)} · ${money(line.line_amount, en)}`);
      lines.push(`${en ? 'Classification source' : 'Nguồn phân loại'}: ${clean(line.classification_source, 60)}`);
      if (evidence.rule) {
        lines.push(`${en ? 'Stored rule link' : 'Rule đã lưu'}: ${clean(evidence.rule.rule_name, 200)} · ${clean(evidence.rule.match_scope, 60)} · ${en ? 'priority' : 'ưu tiên'} ${clean(String(evidence.rule.priority ?? '-'), 20)} · ${en ? 'confidence' : 'độ tin cậy'} ${clean(String(evidence.rule.confidence ?? '-'), 20)}${evidence.rule.effective_from ? ` · ${clean(String(evidence.rule.effective_from), 10)} → ${clean(String(evidence.rule.effective_to ?? ''), 10) || (en ? 'open' : 'không giới hạn')}` : ''}`);
        lines.push(en ? 'This is the current metadata of the stored rule link; it is not proof that the current rule state caused the historical classification.' : 'Đây là metadata hiện tại của liên kết rule đã lưu; không phải bằng chứng rule hiện tại đã tạo ra kết quả phân loại lịch sử.');
      } else lines.push(en ? 'No rule row is linked to this classification (stored source is not a matching rule).' : 'Không có rule nào được gắn với phân loại này (nguồn lưu không phải rule khớp).');
      if (evidence.alias_mapping) lines.push(`${en ? 'Alias mapping' : 'Ánh xạ alias'}: ${clean(evidence.alias_mapping.source_name, 200)} → ${clean(evidence.alias_mapping.standard_cost_code, 60)} · ${clean(evidence.alias_mapping.canonical_cost_item_name, 200)}`);
      else if (evidence.alias_status && evidence.alias_status !== 'no_mapping_match') lines.push(`${en ? 'Alias mapping evidence' : 'Bằng chứng ánh xạ alias'}: ${clean(evidence.alias_status, 60)}`);
    } else throw new AnalyticsError('invalid_result');
  } else if (kind === 'sync_freshness') {
    lines.push(`${en ? 'Cost classification sync' : 'Đồng bộ phân loại chi phí'} · ${en ? 'watermark' : 'mốc dữ liệu'} ${clean(result.source_observed_at, 40)}`);
    lines.push(`${en ? 'Snapshot' : 'Bản chụp'}: ${clean(result.snapshot_id, 64)} · ${en ? 'age' : 'tuổi'} ${count(result.age_seconds)}s · ${result.stale ? (en ? 'STALE: numeric answers are blocked' : 'ĐÃ CŨ: chặn trả số liệu') : (en ? 'fresh' : 'còn mới')}`);
    if (result.projection_complete === false) lines.push(`${en ? 'Canonical cost projection is incomplete; numeric cost answers are blocked until re-sync.' : 'Thiếu cột projection chi phí chuẩn; chặn trả số liệu chi phí tới khi đồng bộ lại.'}`);
    if (!result.tables || typeof result.tables !== 'object') throw new AnalyticsError('invalid_result');
    for (const [table, value] of Object.entries(result.tables)) lines.push(`- ${clean(table, 80)}: ${count(value)} ${en ? 'rows' : 'dòng'}`);
    if (Array.isArray(result.missing_tables) && result.missing_tables.length) lines.push(`${en ? 'Missing/unreconciled tables' : 'Bảng thiếu/chưa đối soát'}: ${result.missing_tables.map((table: unknown) => clean(table, 80)).join(', ')}`);
  } else throw new AnalyticsError('invalid_result');
  lines.push(en ? DISCLAIMER_EN : DISCLAIMER_VI);
  return lines.join('\n') + suffix;
}
