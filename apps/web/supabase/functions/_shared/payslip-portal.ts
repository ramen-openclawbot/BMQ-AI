// Pure logic for the employee payslip portal Edge Functions.
//
// Deliberately dependency-free: no remote URL imports and no Deno globals, so
// `node --test` can exercise it directly. The shapes mirror
// apps/web/src/lib/payslip-portal/types.ts, which is the contract the portal UI
// already uses.

export type PayslipLineUnit = "vnd" | "day" | "hour";

export interface PayslipLine {
  key: string;
  label: string;
  value: number;
  unit: PayslipLineUnit;
}

export interface PayslipEmployee {
  code: string;
  name: string;
  groupName: string | null;
}

export interface PublicPayslip {
  periodId: string;
  periodName: string;
  dateFrom: string | null;
  dateTo: string | null;
  publishedAt: string;
  employeeCode: string;
  employeeName: string;
  netPay: number;
  lines: PayslipLine[];
  note: string | null;
}

export interface PublicPayslipPayload {
  employee: PayslipEmployee;
  payslips: PublicPayslip[];
}

/** Raw payroll_bn_payslips row, as returned by PostgREST. */
export interface DbPayslipRow {
  id?: string | null;
  period_id: string;
  employee_code: string;
  employee_name: string;
  group_name?: string | null;
  period_name: string;
  date_from?: string | null;
  date_to?: string | null;
  net_pay: number | string;
  lines?: unknown;
  note?: string | null;
  published_at: string;
  published_by?: string | null;
}

export interface PayslipOtpChallenge {
  expires_at: string;
  consumed_at?: string | null;
  attempt_count?: number | string | null;
}

export interface PayslipSession {
  expires_at: string;
  revoked_at?: string | null;
}

export const PAYSLIP_OTP_MAX_ATTEMPTS = 5;
export const PAYSLIP_SESSION_TTL_HOURS = 12;
export const PAYSLIP_SESSION_TOKEN_PREFIX = "psp_";

/**
 * Normalise a Vietnamese mobile number to 84xxxxxxxxx, or null when it is not a
 * valid mobile. Same semantics as normalizeDealerPhone.
 */
export function normalizePayslipPhone(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+84")) digits = `84${digits.slice(3)}`;
  digits = digits.replace(/\D/g, "");

  if (digits.startsWith("0084")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;

  return /^84(3|5|7|8|9)\d{8}$/.test(digits) ? digits : null;
}

export type PayslipChallengeCheck =
  | { ok: true }
  | { ok: false; code: "otp_consumed" | "otp_max_attempts" | "otp_expired" };

/** Reject a challenge that was already consumed, has too many tries or expired. */
export function validatePayslipOtpChallenge(
  challenge: PayslipOtpChallenge,
  now: Date = new Date(),
): PayslipChallengeCheck {
  if (challenge.consumed_at) return { ok: false, code: "otp_consumed" };

  const attempts = Number(challenge.attempt_count ?? 0);
  if (Number.isFinite(attempts) && attempts >= PAYSLIP_OTP_MAX_ATTEMPTS) {
    return { ok: false, code: "otp_max_attempts" };
  }

  const expiresAt = challenge.expires_at ? new Date(challenge.expires_at).getTime() : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, code: "otp_expired" };
  }

  return { ok: true };
}

/** A portal session lives for 12 hours. */
export function getPayslipSessionExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + PAYSLIP_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

export function isPayslipSessionActive(session: PayslipSession, now: Date = new Date()): boolean {
  if (session.revoked_at) return false;
  const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : NaN;
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function normalizeLines(value: unknown): PayslipLine[] {
  if (!Array.isArray(value)) return [];
  const lines: PayslipLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const unit = row.unit === "day" || row.unit === "hour" ? row.unit : "vnd";
    lines.push({
      key: String(row.key ?? ""),
      label: String(row.label ?? ""),
      value: Number(row.value ?? 0),
      unit,
    });
  }
  return lines;
}

function rowToPublicPayslip(row: DbPayslipRow): PublicPayslip {
  return {
    periodId: row.period_id,
    periodName: row.period_name,
    dateFrom: row.date_from ?? null,
    dateTo: row.date_to ?? null,
    publishedAt: row.published_at,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    netPay: Number(row.net_pay),
    lines: normalizeLines(row.lines),
    note: row.note ?? null,
  };
}

/** Newest period first. */
function compareByPeriodDesc(a: DbPayslipRow, b: DbPayslipRow): number {
  const periodOrder = String(b.date_from ?? "").localeCompare(String(a.date_from ?? ""));
  if (periodOrder !== 0) return periodOrder;
  return String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""));
}

/**
 * Public payload for one signed-in employee. The session's employee_code is
 * authoritative: rows for any other employee are dropped, and no internal id or
 * published_by ever leaves the server.
 */
export function toPublicPayslips(
  rows: readonly DbPayslipRow[],
  session: { employeeCode: string; employeeName?: string | null; groupName?: string | null },
): PublicPayslipPayload {
  const matching = rows
    .filter((row) => row.employee_code === session.employeeCode)
    .slice()
    .sort(compareByPeriodDesc);

  const first = matching[0];
  return {
    employee: {
      code: session.employeeCode,
      name: first?.employee_name ?? session.employeeName ?? "",
      groupName: first?.group_name ?? session.groupName ?? null,
    },
    payslips: matching.map(rowToPublicPayslip),
  };
}
