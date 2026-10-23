/**
 * Quy tắc kỳ dùng chung giữa SQL (expense_strip_period / expense_notes_pattern)
 * và client. Ghi chú chi định kỳ thường có dạng:
 *   - "Điện Kho Tân Tạo T092026"
 *   - "Chi phí T09/2026"
 *   - "Thuê nhà Q.7 T10/2026"
 *   - "Tiền MB Q.7 T7/26"
 *   - "Điện Bếp Q.7 T3.2026"
 *
 * stripPeriod bỏ đúng token kỳ để ra khóa khuôn; formatPeriodLike đổi một mẫu
 * ghi chú sang kỳ mới mà vẫn giữ dấu phân cách và độ dài tháng/năm của mẫu.
 */

const PERIOD_TOKEN_PATTERNS: RegExp[] = [
  /T\d{1,2}[/.]\d{4}/gi,
  /T\d{1,2}[/.]\d{2}/gi,
  /T\d{1,2}\d{4}/gi,
  /\b\d{1,2}\/\d{4}\b/g,
];

/** Bỏ kỳ khỏi ghi chú và gộp khoảng trắng, giống public.expense_strip_period. */
export function stripPeriod(notes: string | null | undefined): string {
  let value = String(notes ?? "");
  for (const pattern of PERIOD_TOKEN_PATTERNS) {
    value = value.replace(pattern, "");
  }
  return value.replace(/\s+/g, " ").trim();
}

type PeriodMatch = {
  token: string;
  separator: "/" | "." | "";
  monthDigits: 1 | 2;
  yearDigits: 2 | 4;
};

const FORMAT_PATTERNS: Array<{
  pattern: RegExp;
  separator: "/" | "." | "";
  yearDigits: 2 | 4;
}> = [
  { pattern: /T(\d{1,2})\/(\d{4})/i, separator: "/", yearDigits: 4 },
  { pattern: /T(\d{1,2})\/(\d{2})/i, separator: "/", yearDigits: 2 },
  { pattern: /T(\d{1,2})\.(\d{4})/i, separator: ".", yearDigits: 4 },
  { pattern: /T(\d{1,2})\.(\d{2})/i, separator: ".", yearDigits: 2 },
  { pattern: /T(\d{1,2})(\d{4})/i, separator: "", yearDigits: 4 },
];

function findPeriodMatch(sample: string): PeriodMatch | null {
  for (const candidate of FORMAT_PATTERNS) {
    const match = candidate.pattern.exec(sample);
    if (!match) continue;
    return {
      token: match[0],
      separator: candidate.separator,
      monthDigits: match[1].length === 1 ? 1 : 2,
      yearDigits: candidate.yearDigits,
    };
  }
  return null;
}

/**
 * Đổi kỳ của `sample` sang tháng/năm mới. Không có mẫu thì trả về dạng
 * "T{MM}/{YYYY}".
 */
export function formatPeriodLike(
  sample: string | null | undefined,
  year: number,
  month: number,
): string {
  const safeYear = Math.trunc(Number(year));
  const safeMonth = Math.trunc(Number(month));
  if (!Number.isFinite(safeYear) || safeMonth < 1 || safeMonth > 12) {
    return "";
  }

  const source = String(sample ?? "");
  const match = findPeriodMatch(source);
  const monthText = match?.monthDigits === 1
    ? String(safeMonth)
    : String(safeMonth).padStart(2, "0");
  const yearText = match?.yearDigits === 2
    ? String(safeYear).slice(-2)
    : String(safeYear).padStart(4, "0");

  if (!match) {
    return `T${monthText}/${yearText}`;
  }

  return source.replace(
    match.token,
    `T${monthText}${match.separator}${yearText}`,
  );
}
