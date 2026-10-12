/**
 * Pure helpers for the payroll-Q7 salary-payout exclusion checklist
 * ("Chi lương Q7: bỏ tick kèm lý do").
 *
 * When a KTT creates a payout they may uncheck chosen employees of the period.
 * Every unchecked employee needs a reason of 3..200 characters; the payout must
 * keep at least one employee. The same rules are enforced server-side by
 * create_salary_payout(p_period_id, p_idempotency_key, p_exclusions), so this
 * module only shapes the request and its validation messages.
 *
 * No money is logged anywhere in this module.
 */

export const EXCLUSION_REASON_MIN_LENGTH = 3;
export const EXCLUSION_REASON_MAX_LENGTH = 200;

export const EXCLUSION_REASON_REQUIRED_MESSAGE = "Nhập lý do bỏ người này";
export const EXCLUSION_REASON_TOO_LONG_MESSAGE = "Lý do tối đa 200 ký tự";
export const EXCLUSION_NO_EMPLOYEES_MESSAGE = "Phiếu phải còn ít nhất 1 nhân viên";

/** One employee line of a payroll_bn period (list_salary_payout_period_lines). */
export interface SalaryPayoutPeriodLine {
  employee_code: string;
  employee_name: string;
  net_pay: number;
}

/** An excluded line keeps the snapshotted employee data and the reason. */
export interface ExcludedPayoutLine extends SalaryPayoutPeriodLine {
  reason: string;
}

export interface ExclusionReasonValidation {
  valid: boolean;
  message: string;
}

export interface SalaryExclusionSelectionError {
  /** The offending employee code, or null for a whole-payout error. */
  employee_code: string | null;
  message: string;
}

export interface PayoutSelectionResult {
  included: SalaryPayoutPeriodLine[];
  excluded: ExcludedPayoutLine[];
  employeeCount: number;
  totalAmount: number;
  errors: SalaryExclusionSelectionError[];
}

/** Payload item accepted by create_salary_payout's p_exclusions argument. */
export interface SalaryPayoutExclusionPayload {
  employee_code: string;
  reason: string;
}

const textOf = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();

const numberAmountOf = (value: unknown): number => {
  const amount = typeof value === "number" ? value : Number(textOf(value));
  return Number.isFinite(amount) ? amount : 0;
};

/** A reason must be 3..200 characters after trimming. */
export const validateExclusionReason = (reason: unknown): ExclusionReasonValidation => {
  const text = textOf(reason);
  if (text.length < EXCLUSION_REASON_MIN_LENGTH) {
    return { valid: false, message: EXCLUSION_REASON_REQUIRED_MESSAGE };
  }
  if (text.length > EXCLUSION_REASON_MAX_LENGTH) {
    return { valid: false, message: EXCLUSION_REASON_TOO_LONG_MESSAGE };
  }
  return { valid: true, message: "" };
};

/**
 * Split the period lines into included/excluded, summing only the included
 * employees. Codes in `excluded` that do not match a line are ignored (they add
 * nothing to the totals and cannot appear in the result). A missing or bad
 * reason is reported per employee, and excluding everyone reports a payout-wide
 * error so the caller can keep the submit button disabled.
 */
export const buildPayoutSelection = (
  lines: SalaryPayoutPeriodLine[],
  excluded: Record<string, string> = {},
): PayoutSelectionResult => {
  const safeLines = Array.isArray(lines) ? lines : [];
  const excludedMap =
    excluded !== null && typeof excluded === "object" && !Array.isArray(excluded)
      ? excluded
      : {};

  const included: SalaryPayoutPeriodLine[] = [];
  const excludedLines: ExcludedPayoutLine[] = [];
  const errors: SalaryExclusionSelectionError[] = [];

  for (const line of safeLines) {
    if (Object.prototype.hasOwnProperty.call(excludedMap, line.employee_code)) {
      const reason = textOf(excludedMap[line.employee_code]);
      const check = validateExclusionReason(reason);
      if (!check.valid) {
        errors.push({ employee_code: line.employee_code, message: check.message });
      }
      excludedLines.push({ ...line, reason });
    } else {
      included.push(line);
    }
  }

  let totalAmount = 0;
  for (const line of included) {
    totalAmount += numberAmountOf(line.net_pay);
  }

  if (safeLines.length > 0 && included.length === 0) {
    errors.push({ employee_code: null, message: EXCLUSION_NO_EMPLOYEES_MESSAGE });
  }

  return {
    included,
    excluded: excludedLines,
    employeeCount: included.length,
    totalAmount,
    errors,
  };
};

/** p_exclusions payload: trimmed reasons, ordered by employee_code. */
export const toExclusionPayload = (
  excluded: Record<string, string> | null | undefined,
): SalaryPayoutExclusionPayload[] => {
  const safeExcluded =
    excluded !== null && typeof excluded === "object" && !Array.isArray(excluded)
      ? excluded
      : {};
  return Object.entries(safeExcluded)
    .map(([employee_code, reason]) => ({ employee_code, reason: textOf(reason) }))
    .sort((left, right) => left.employee_code.localeCompare(right.employee_code));
};

// ---------------------------------------------------------------------------
// Error text (covers every server code of the exclusion flow)
// ---------------------------------------------------------------------------

const EXCLUSION_ERROR_TEXT: Record<string, string> = {
  invalid_exclusions: "Danh sách bỏ nhân viên không hợp lệ.",
  reason_required: "Mỗi nhân viên bị bỏ cần lý do từ 3 đến 200 ký tự.",
  unknown_employee_code: "Mã nhân viên không có trong kỳ lương này.",
  no_employees_left: EXCLUSION_NO_EMPLOYEES_MESSAGE,
};

const FALLBACK_ERROR_TEXT = "Không xử lý được danh sách bỏ nhân viên. Vui lòng thử lại.";

/** Vietnamese message for a server code; unknown codes get a generic message. */
export const exclusionErrorText = (code: unknown): string => {
  const key = textOf(code);
  return EXCLUSION_ERROR_TEXT[key] ?? FALLBACK_ERROR_TEXT;
};
