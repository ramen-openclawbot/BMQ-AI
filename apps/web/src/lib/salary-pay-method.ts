/**
 * Pure helpers for the salary payout payment method.
 *
 * The database stores the lowercase values 'cash' | 'unc'; anything else
 * (including an upper-case 'UNC' or a missing key on an older response) is
 * treated as cash so existing payouts keep working.
 */

export type SalaryPayMethod = "cash" | "unc";

export function normalizePayMethod(value: unknown): SalaryPayMethod {
  return value === "unc" ? "unc" : "cash";
}

export function salaryPayMethodLabel(method: SalaryPayMethod): string {
  return method === "unc" ? "UNC" : "Tiền mặt";
}

/** Only cash payouts are matched against uploaded bank slips. */
export function needsBankSlips(method: SalaryPayMethod): boolean {
  return method === "cash";
}
