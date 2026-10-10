/**
 * Pure helpers for the manual salary-payout flow ("Lương lẻ").
 *
 * Manual payouts are typed one employee at a time (outside the Bếp Q7 payroll)
 * and share the SQL limits enforced by create_manual_salary_payout:
 *   * title 1..120 chars;
 *   * 1..50 lines;
 *   * employee_name 1..120 chars;
 *   * amount an integer 1..200,000,000;
 *   * total <= 2,000,000,000.
 *
 * No money is logged anywhere in this module.
 */

export const MANUAL_SALARY_MAX_LINES = 50;
export const MANUAL_SALARY_MAX_TITLE_LENGTH = 120;
export const MANUAL_SALARY_MAX_NAME_LENGTH = 120;
export const MANUAL_SALARY_MAX_AMOUNT = 200_000_000;
export const MANUAL_SALARY_MAX_TOTAL = 2_000_000_000;

export interface ManualSalaryPayoutInput {
  title?: unknown;
  lines?: unknown;
}

export interface NormalizedManualSalaryLine {
  employee_name: string;
  employee_code: string;
  amount: number;
  note: string | null;
}

export type ManualSalaryValidationField =
  | "title"
  | "lines"
  | "employee_name"
  | "employee_code"
  | "amount"
  | "total";

export interface ManualSalaryValidationError {
  field: ManualSalaryValidationField;
  /** 0-based index of the offending line, absent for title/lines/total. */
  lineIndex?: number;
  message: string;
}

export interface ManualSalaryValidationResult {
  valid: boolean;
  errors: ManualSalaryValidationError[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const textOf = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** Missing/blank amount becomes 0 so validation reports it; otherwise Number(). */
const amountOf = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? 0 : Number(trimmed);
  }
  return Number.NaN;
};

const randomId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/** Stable idempotency key for one create dialog session. */
export const buildManualSalaryIdempotencyKey = (sessionId?: string): string => {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  return `salary-manual:${id || randomId()}`;
};

/**
 * Trim the names/notes, drop fully empty rows (blank name AND blank amount) and
 * assign a unique employee_code to rows without one: 'LL-01', 'LL-02'..,
 * skipping any code supplied by another row.
 */
export const normalizeManualLines = (lines: unknown): NormalizedManualSalaryLine[] => {
  const safe = Array.isArray(lines) ? lines : [];
  const kept: NormalizedManualSalaryLine[] = [];
  const usedCodes = new Set<string>();

  for (const raw of safe) {
    const record = asRecord(raw);
    if (!record) continue;
    const name = textOf(record.employee_name);
    const rawAmount = record.amount;
    if (name === "" && isBlank(rawAmount)) continue;

    const code = textOf(record.employee_code);
    if (code) usedCodes.add(code);
    kept.push({
      employee_name: name,
      employee_code: code,
      amount: amountOf(rawAmount),
      note: textOf(record.note) || null,
    });
  }

  let generated = 0;
  return kept.map((row) => {
    if (row.employee_code) return row;
    let candidate = "";
    do {
      generated += 1;
      candidate = `LL-${String(generated).padStart(2, "0")}`;
    } while (usedCodes.has(candidate));
    usedCodes.add(candidate);
    return { ...row, employee_code: candidate };
  });
};

/** Validate a manual payout input against the SQL limits. */
export const validateManualSalaryPayout = (
  input: ManualSalaryPayoutInput,
): ManualSalaryValidationResult => {
  const errors: ManualSalaryValidationError[] = [];

  const title = textOf(input?.title);
  if (title === "") {
    errors.push({ field: "title", message: "Chưa nhập tiêu đề phiếu lương lẻ." });
  } else if (title.length > MANUAL_SALARY_MAX_TITLE_LENGTH) {
    errors.push({
      field: "title",
      message: `Tiêu đề tối đa ${MANUAL_SALARY_MAX_TITLE_LENGTH} ký tự.`,
    });
  }

  const lines = normalizeManualLines(input?.lines);
  if (lines.length === 0) {
    errors.push({ field: "lines", message: "Chưa nhập nhân viên nào." });
  } else if (lines.length > MANUAL_SALARY_MAX_LINES) {
    errors.push({
      field: "lines",
      message: `Tối đa ${MANUAL_SALARY_MAX_LINES} nhân viên mỗi phiếu.`,
    });
  }

  const codeCounts = new Map<string, number>();
  for (const line of lines) {
    codeCounts.set(line.employee_code, (codeCounts.get(line.employee_code) ?? 0) + 1);
  }

  let total = 0;
  lines.forEach((line, lineIndex) => {
    if (line.employee_name === "") {
      errors.push({
        field: "employee_name",
        lineIndex,
        message: `Dòng ${lineIndex + 1}: chưa nhập tên nhân viên.`,
      });
    } else if (line.employee_name.length > MANUAL_SALARY_MAX_NAME_LENGTH) {
      errors.push({
        field: "employee_name",
        lineIndex,
        message: `Dòng ${lineIndex + 1}: tên nhân viên tối đa ${MANUAL_SALARY_MAX_NAME_LENGTH} ký tự.`,
      });
    }

    if ((codeCounts.get(line.employee_code) ?? 0) > 1) {
      errors.push({
        field: "employee_code",
        lineIndex,
        message: `Dòng ${lineIndex + 1}: mã nhân viên bị trùng.`,
      });
    }

    const amount = line.amount;
    if (!Number.isInteger(amount) || amount < 1) {
      errors.push({
        field: "amount",
        lineIndex,
        message: `Dòng ${lineIndex + 1}: số tiền phải là số nguyên lớn hơn 0.`,
      });
    } else if (amount > MANUAL_SALARY_MAX_AMOUNT) {
      errors.push({
        field: "amount",
        lineIndex,
        message: `Dòng ${lineIndex + 1}: số tiền tối đa 200.000.000 đ.`,
      });
    } else {
      total += amount;
    }
  });

  if (total > MANUAL_SALARY_MAX_TOTAL) {
    errors.push({ field: "total", message: "Tổng tiền tối đa 2.000.000.000 đ." });
  }

  return { valid: errors.length === 0, errors };
};
