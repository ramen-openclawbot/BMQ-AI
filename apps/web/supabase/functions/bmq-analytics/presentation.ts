import { loadFx, formatMoney, numeric, type FxRate } from './money.ts';
import { METRICS } from './data.ts';

// Internal structured facts, never parsed back out of LLM prose.
export type Presentation = { kind: 'metric'; query: any; result: any; descriptor: any; legacy?: boolean } | { kind: 'customer'; result: any; lookup: string };
const text = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, 300);
const date = (value: unknown) => {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(Date.parse(raw))) return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(raw));
  return raw.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1');
};
const legacyEnglish: Record<string, string> = { controlled_revenue: 'Controlled revenue', supplier_debt: 'Current supplier payables', purchase_order_count: 'Purchase orders', low_stock_count: 'Current low-stock items' };
export function legacyPresentation(query: any, result: any): Presentation {
  return { kind: 'metric', query, result, descriptor: METRICS[query.metric as keyof typeof METRICS], legacy: true };
}
export async function presentResponse<T extends { answer: string; provenance: any; presentation?: Presentation[] }>(response: T, language: 'en' | 'vi', signal: AbortSignal, fxLoader = loadFx) {
  const { presentation = [], ...rest } = response;
  if (!presentation.length) return rest;
  const en = language === 'en';
  let fx: FxRate | null | undefined;
  const originalAmounts: string[] = [];
  const money = async (value: unknown, currency = 'VND') => {
    if (en && currency === 'VND' && fx === undefined) fx = await fxLoader(signal);
    const rendered = formatMoney(value, currency, language, fx ?? null);
    if (currency === 'VND') originalAmounts.push(`${formatMoney(value, 'VND', 'vi', null)} → ${rendered}`);
    return rendered;
  };
  const period = (start: unknown, end: unknown) => start && end ? (start === end ? date(start) : `${date(start)} – ${date(end)}`) : '';
  const blocks: string[] = [];
  for (const block of presentation) {
    const r = block.result;
    if (block.kind === 'customer') {
      // Existing validated selection/abstention text stays intact, without audit clutter.
      if (r.status !== 'ok') { blocks.push(response.answer.split(/\n(?:Source|Nguồn):/)[0]); continue; }
      const name = text(r.customer?.customer_name);
      const when = block.lookup === 'prices' ? (en ? 'Current price list' : 'Bảng giá hiện tại') : period(r.period?.start, r.period?.end);
      const lines = [`${name} · ${when}`];
      if (block.lookup === 'npp_receivable') {
        lines.push(`${en ? 'Period receivable' : 'Phải thu trong kỳ'}: ${await money(r.totals.period_payable)}`);
        lines.push(en ? 'Opening balance and collections not included.' : 'Chưa cộng số dư đầu kỳ hoặc trừ tiền đã thu.');
        if (r.unmapped_line_count) lines.push(en ? 'Some amounts are not assigned to an agency.' : 'Một số khoản chưa được phân bổ vào đại lý.');
      } else {
        for (const row of r.rows) {
          lines.push(block.lookup === 'prices'
            ? `${text(row.product_name)} (${text(row.sku_code)}): ${await money(row.price, row.currency)} / ${text(row.unit)}`
            : `${text(row.order_number)} · ${date(row.submitted_at)}: ${await money(row.amount, row.currency)}`);
        }
        if (!r.rows.length) lines.push(en ? 'No matching data.' : 'Chưa có dữ liệu phù hợp.');
        if (block.lookup === 'prices') lines.push(en ? 'Listed prices, not a final quotation.' : 'Giá niêm yết riêng, chưa phải giá chốt đơn.');
      }
      if (r.truncated) lines.push(en ? 'Showing a partial list.' : 'Chỉ hiển thị một phần danh sách.');
      blocks.push(lines.join('\n'));
      continue;
    }
    const q = block.query, d = block.descriptor;
    const title = block.legacy ? (en ? legacyEnglish[q.metric] : d.label) : (en ? d.label : d.label_vi ?? d.label);
    const when = period(r.period?.start ?? q.start, r.period?.end ?? q.end) || text(q.time_range);
    const lines = [`${text(title || q.metric)}${when ? ` · ${when}` : ''}`];
    const count = block.legacy ? d.unit !== 'VND' : d.unit === 'count' || ['order_count', 'customer_count'].includes(q.metric);
    for (const row of r.rows) {
      const value = block.legacy ? row.value : row[q.metric];
      const dimension = block.legacy ? (q.dimension ? text(row.dimension) : '') : (q.dimensions ?? []).map((key: string) => text(row[key])).filter(Boolean).join(' · ');
      const label = dimension ? `${dimension}: ` : '';
      if (value == null) { lines.push(label + (en ? 'Not available' : 'Chưa có dữ liệu')); continue; }
      const rendered = count || q.metric === 'gross_margin'
        ? new Intl.NumberFormat(en ? 'en-US' : 'vi-VN', { maximumFractionDigits: count ? 0 : 2 }).format(numeric(value)) + (q.metric === 'gross_margin' ? '%' : '')
        : await money(value, block.legacy ? 'VND' : row.currency);
      lines.push(label + rendered);
    }
    if (!r.rows.length) lines.push(en ? 'No data for this period; not a zero balance.' : 'Chưa có dữ liệu kỳ này; không đồng nghĩa bằng 0.');
    if (r.truncated) lines.push(en ? 'Showing a partial list.' : 'Chỉ hiển thị một phần danh sách.');
    blocks.push(lines.join('\n'));
  }
  let answer = blocks.join('\n\n');
  let details = response.answer;
  if (fx) {
    answer += '\n\nUSD estimate.';
    details += `\n\nReference conversion (current rate, not transaction-date accounting): 1 USD = ${fx.vndPerUsd} VND\nUpdated: ${fx.updatedAt}\nSource: ${fx.source}\n` + [...new Set(originalAmounts)].join('\n');
  } else if (fx === null) answer += '\n\nUSD rate unavailable; amounts shown in VND.';
  return { ...rest, answer, provenance: { ...rest.provenance, details, fx: fx ?? null, presentationVersion: 'business-money-v1' } };
}
