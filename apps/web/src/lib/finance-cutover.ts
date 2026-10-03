// Pure helpers for the CEO month-cutover flow. No Supabase / React imports so
// the batching, backlog-month and QTM chain rules stay unit-testable.

export interface CutoverDaySpend {
  closingDate: string;
  qtmTopup: number;
  qtmSpent: number;
}

export interface CutoverDayBalance {
  closingDate: string;
  opening: number;
  qtmTopup: number;
  qtmSpent: number;
  closing: number;
  counted: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDateParts(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = ISO_DATE.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

/**
 * Months (as YYYY-MM-01 keys, ascending) touched by the inclusive date range.
 * Used to list the backlog months the owner must cut over in order.
 */
export function listBacklogMonths(fromDate: string, toDate: string): string[] {
  const from = parseIsoDateParts(fromDate);
  const to = parseIsoDateParts(toDate);
  const startIndex = from.year * 12 + (from.month - 1);
  const endIndex = to.year * 12 + (to.month - 1);
  if (endIndex < startIndex) return [];

  const months: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    months.push(
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
    );
  }
  return months;
}

/** Split dates into batches of at most `limit` items, preserving input order. */
export function batchDatesByLimit(dates: string[], limit = 10): string[][] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  const batches: string[][] = [];
  for (let index = 0; index < dates.length; index += limit) {
    batches.push(dates.slice(index, index + limit));
  }
  return batches;
}

/**
 * Running QTM balance for a month cutover, matching the SQL rule:
 *   closing(day) = opening(day) + topup(day) - scanned spend(day)
 * The opening of each next day is the previous day's closing. When a counted
 * closing is supplied it overrides only the last day's closing.
 */
export function computeRunningQtmBalance(
  opening: number,
  days: CutoverDaySpend[],
  countedClosing?: number | null,
): CutoverDayBalance[] {
  let running = Number(opening || 0);
  const hasCounted = countedClosing !== null && countedClosing !== undefined;

  return days.map((day, index) => {
    const qtmTopup = Number(day.qtmTopup || 0);
    const qtmSpent = Number(day.qtmSpent || 0);
    const isLast = index === days.length - 1;
    const counted = Boolean(isLast && hasCounted);
    const closing = counted
      ? Number(countedClosing)
      : running + qtmTopup - qtmSpent;

    const balance: CutoverDayBalance = {
      closingDate: day.closingDate,
      opening: running,
      qtmTopup,
      qtmSpent,
      closing,
      counted,
    };
    running = closing;
    return balance;
  });
}

export const CUTOVER_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Chỉ chủ sở hữu (CEO) được chốt mốc tháng.",
  prior_month_unclosed:
    "Vẫn còn ngày khai báo chưa chốt ở tháng trước. Vui lòng chốt tháng trước trước.",
  preview_changed:
    "Dữ liệu tháng đã thay đổi kể từ lúc xem trước. Vui lòng tải lại và xem trước lại.",
  note_required:
    "Cần nhập ghi chú giải trình vì số liệu UNC hoặc QTM có chênh lệch.",
  later_cutover_exists:
    "Đã có mốc chốt của tháng sau. Cần hoàn tác tháng sau trước.",
  later_day_closed:
    "Có ngày sau kỳ chốt đã được chốt theo cách khác. Không thể hoàn tác mốc này.",
};

/** Map an RPC error code to an operator-facing Vietnamese message. */
export function mapCutoverError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  for (const [code, message] of Object.entries(CUTOVER_ERROR_MESSAGES)) {
    if (raw.includes(code)) return message;
  }
  return "Không xử lý được chốt mốc tháng. Vui lòng thử lại.";
}
