// Mission bonus ledger for one period M.
//
// Only an `achieved` mission of a `pay` template contributes. The amount is the
// mission reward when configured, otherwise 0 (rule 8: a null reward, or a
// missing budget cap, never adds money). The period total is an integer number
// of đồng and must fit the configured budget.

import type { PayrollEmployee } from "../payroll-bn/types.ts";
import type {
  MissionBonusLine,
  MissionBonusResult,
  MissionLedgerEntry,
} from "./types.ts";

/** Whole đồng; invalid / negative rewards are worth 0. */
function toAmount(rewardVnd: number | null | undefined): number {
  if (rewardVnd === null || rewardVnd === undefined) return 0;
  const parsed = Number(rewardVnd);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

export interface MissionBonusInput {
  entries: readonly MissionLedgerEntry[];
  budgetVnd: number | null;
}

/**
 * Aggregate the bonuses of period M. Two calls with the same ledger (or the
 * same mission twice, e.g. a retried create_bonuses) produce one line per
 * mission. A null budget or a null reward contributes 0; exceeding the budget
 * throws with the overage.
 */
export function computeMissionBonus(input: MissionBonusInput): MissionBonusResult {
  const seen = new Set<string>();
  const lines: MissionBonusLine[] = [];

  for (const entry of input.entries) {
    if (entry.status !== "achieved" || entry.mode !== "pay") continue;
    const amountVnd = toAmount(entry.rewardVnd);
    // Rule 8 — a null/zero reward never becomes a bonus line.
    if (amountVnd <= 0) continue;
    const key = entry.missionId ?? `${entry.employeeCode}|${entry.missionCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      ...(entry.missionId ? { missionId: entry.missionId } : {}),
      employeeCode: entry.employeeCode,
      missionCode: entry.missionCode,
      amountVnd,
    });
  }

  // Rule 8 — reward null or cap null: nothing is added to the payslip.
  if (input.budgetVnd === null || input.budgetVnd === undefined || !Number.isFinite(Number(input.budgetVnd))) {
    return { totalVnd: 0, lines: [] };
  }

  const totalVnd = lines.reduce((sum, line) => sum + line.amountVnd, 0);
  if (totalVnd > Number(input.budgetVnd)) {
    throw new Error(`Vượt trần thưởng nhiệm vụ: ${totalVnd - Number(input.budgetVnd)} đồng.`);
  }
  return { totalVnd, lines };
}

/** The "Ghi chú" fragment listing the mission codes that earned a bonus. */
export function missionBonusNote(missionCodes: readonly string[]): string {
  return `Thưởng nhiệm vụ: ${missionCodes.join(", ")}`;
}

export interface AppliedMissionBonuses {
  /** The same employees, with `missionBonus` attached (identity when 0). */
  employees: PayrollEmployee[];
  /** Employee code → the mission codes behind their bonus (for the note). */
  missionCodesByEmployee: Map<string, string[]>;
}

/** The minimum a bonus row needs to be applied (works for a DB row too). */
export interface MissionBonusAmount {
  employeeCode: string;
  missionCode: string;
  amountVnd: number;
}

/**
 * Attach the persisted mission bonuses of one period to its employee catalogue.
 * Only a positive amount contributes (rule 8: no amount, no money); an employee
 * with no bonus is returned unchanged, so R1–R9 and the T08/T09 totals stay put.
 */
export function applyMissionBonuses(
  employees: readonly PayrollEmployee[],
  bonuses: readonly MissionBonusAmount[],
): AppliedMissionBonuses {
  const amountByEmployee = new Map<string, number>();
  const missionCodesByEmployee = new Map<string, string[]>();

  for (const bonus of bonuses) {
    const amount = toAmount(bonus.amountVnd);
    if (amount <= 0) continue;
    const employeeCode = String(bonus.employeeCode ?? "").trim();
    if (employeeCode === "") continue;

    amountByEmployee.set(employeeCode, (amountByEmployee.get(employeeCode) ?? 0) + amount);
    const codes = missionCodesByEmployee.get(employeeCode) ?? [];
    if (!codes.includes(bonus.missionCode)) codes.push(bonus.missionCode);
    missionCodesByEmployee.set(employeeCode, codes);
  }

  const withBonus = employees.map((employee) => {
    const amount = amountByEmployee.get(employee.code);
    if (!amount || amount <= 0) return employee;
    return { ...employee, missionBonus: (employee.missionBonus ?? 0) + amount };
  });

  return { employees: withBonus, missionCodesByEmployee };
}
