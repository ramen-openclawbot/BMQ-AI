// Overview of the employee catalog for one period: head count and the current
// monthly payroll fund, per group. Display only; never used for payslips.
//
// Fund = fixed monthly pay (lương chính thức + phụ cấp, plus the full-month
// delivery base for drivers) + a part-time estimate = hours already worked in
// this period × hourly rate, read from the payroll engine.

import { computePayroll } from "./engine.ts";
import { rationalToNumber } from "./money.ts";
import type { PayrollComputationInput } from "./engine.ts";
import type { PayrollEmployee, PayrollGroup, PayrollPeriod } from "./types.ts";

export const CATALOG_GROUPS: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN", "Giao hàng"];

export type CatalogEmployeeState = "active" | "upcoming" | "left";

export interface CatalogEmployeeSummary {
  employee: PayrollEmployee;
  state: CatalogEmployeeState;
  /** Fixed monthly pay counted in the fund (0 for part-time). */
  fixed: number;
  /** Part-time pay so far in this period, or null when not part-time / unknown. */
  partTimeSoFar: number | null;
  partTimeHours: number | null;
}

export interface CatalogGroupSummary {
  group: PayrollGroup;
  employees: CatalogEmployeeSummary[];
  activeCount: number;
  upcomingCount: number;
  leftCount: number;
  partTimeCount: number;
  fixed: number;
  partTimeEstimate: number;
  fund: number;
}

export interface CatalogSummary {
  groups: CatalogGroupSummary[];
  activeCount: number;
  upcomingCount: number;
  partTimeCount: number;
  fixed: number;
  partTimeEstimate: number;
  fund: number;
  /** False when the engine could not estimate part-time pay. */
  estimateAvailable: boolean;
}

const amount = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function employeeState(employee: PayrollEmployee, period: Pick<PayrollPeriod, "dateFrom" | "dateTo">): CatalogEmployeeState {
  if (employee.terminated) return "left";
  if (employee.endDate && employee.endDate < period.dateFrom) return "left";
  if (employee.startDate && employee.startDate > period.dateTo) return "upcoming";
  return "active";
}

export function fixedMonthlyPay(employee: PayrollEmployee): number {
  if (employee.employmentType === "part_time") return amount(employee.allowance);
  const base = amount(employee.monthlySalary) + amount(employee.allowance);
  return employee.employmentType === "delivery" ? base + amount(employee.deliveryUnitBase) : base;
}

export function summarizeCatalog(input: PayrollComputationInput): CatalogSummary {
  const partTime = new Map<string, { pay: number; hours: number }>();
  let estimateAvailable = true;
  try {
    const result = computePayroll(input);
    for (const line of result.employees) {
      if (line.employmentType !== "part_time") continue;
      partTime.set(line.employeeCode, {
        pay: rationalToNumber(line.partTimePay),
        hours: rationalToNumber(line.partTimeHours),
      });
    }
  } catch {
    estimateAvailable = false;
  }

  const groups = CATALOG_GROUPS.map<CatalogGroupSummary>((group) => {
    const employees = input.employees
      .filter((employee) => employee.group === group)
      .map<CatalogEmployeeSummary>((employee) => {
        const state = employeeState(employee, input.period);
        const isPartTime = employee.employmentType === "part_time";
        const so = partTime.get(employee.code);
        return {
          employee,
          state,
          fixed: state === "active" ? fixedMonthlyPay(employee) : 0,
          partTimeSoFar: isPartTime && state === "active" && so ? Math.round(so.pay) : null,
          partTimeHours: isPartTime && state === "active" && so ? so.hours : null,
        };
      });
    const active = employees.filter((item) => item.state === "active");
    const fixed = active.reduce((sum, item) => sum + item.fixed, 0);
    const partTimeEstimate = active.reduce((sum, item) => sum + (item.partTimeSoFar ?? 0), 0);
    return {
      group,
      employees,
      activeCount: active.length,
      upcomingCount: employees.filter((item) => item.state === "upcoming").length,
      leftCount: employees.filter((item) => item.state === "left").length,
      partTimeCount: active.filter((item) => item.employee.employmentType === "part_time").length,
      fixed,
      partTimeEstimate,
      fund: fixed + partTimeEstimate,
    };
  });

  const sum = (pick: (group: CatalogGroupSummary) => number) => groups.reduce((total, group) => total + pick(group), 0);
  return {
    groups,
    activeCount: sum((group) => group.activeCount),
    upcomingCount: sum((group) => group.upcomingCount),
    partTimeCount: sum((group) => group.partTimeCount),
    fixed: sum((group) => group.fixed),
    partTimeEstimate: sum((group) => group.partTimeEstimate),
    fund: sum((group) => group.fund),
    estimateAvailable,
  };
}
