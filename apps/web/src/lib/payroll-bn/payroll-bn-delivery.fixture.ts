// Giao hàng payroll fixture — T09.2026 (30 calendar days) and T10.2026 (31).
//
// Delivery pay is fixed monthly salary + total delivery units × delivery unit
// base / calendar days of the month + delivery extras, rounded to 1.000 đ like
// the rest of the engine. The expected net amounts below are written
// independently of the engine under test.
//
// T09:
//   Duyên  2.000.000 + 26 × 2.000.000 / 30 = 3.733.333 → 3.733.000
//   Tuấn   2.000.000 + 25 × 2.000.000 / 30 = 3.666.667 → 3.667.000
//   Chất   10.000.000 + 21,25 × 4.000.000 / 30 + 990.000
//          = 13.823.333 → 13.823.000
//   Bình   13.400.000 (base null) → 13.400.000
// T10:
//   Duyên  2.000.000 + 26,5 × 2.000.000 / 31 = 3.709.677 → 3.710.000
//   Tuấn   2.000.000 + 27 × 2.000.000 / 31 = 3.741.935 → 3.742.000

import { resolveRulesConfig } from "./rules-config.ts";
import type { PayrollEmployee, PayrollGroup, PayrollPeriod } from "./types.ts";

const GROUP: PayrollGroup = "Giao hàng";

function driver(
  code: string,
  name: string,
  monthlySalary: number,
  deliveryUnitBase: number | null,
): PayrollEmployee {
  return {
    code,
    name,
    group: GROUP,
    employmentType: "delivery",
    monthlySalary,
    hourlyRate: null,
    allowance: null,
    overtimeRate: null,
    standardDaysOverride: null,
    startDate: null,
    endDate: null,
    terminated: false,
    deliveryUnitBase,
  };
}

const employees: PayrollEmployee[] = [
  driver("DUYEN", "Duyên", 2_000_000, 2_000_000),
  driver("TUAN", "Tuấn", 2_000_000, 2_000_000),
  driver("CHAT", "Chất", 10_000_000, 4_000_000),
  driver("BINH", "Bình", 13_400_000, null),
];

function period(code: string, name: string, dateFrom: string, dateTo: string): PayrollPeriod {
  return {
    code,
    name,
    dateFrom,
    dateTo,
    standardDaysByGroup: { [GROUP]: 26 },
    defaultStandardDays: 26,
    holidays: [],
    rules: resolveRulesConfig(),
    status: "draft",
  };
}

export const DELIVERY_T09_PERIOD = period(
  "T09.2026",
  "Kỳ lương tháng 09/2026 — Giao hàng",
  "2026-09-01",
  "2026-09-30",
);

export const DELIVERY_T10_PERIOD = period(
  "T10.2026",
  "Kỳ lương tháng 10/2026 — Giao hàng",
  "2026-10-01",
  "2026-10-31",
);

export const DELIVERY_EMPLOYEES = employees;

/** Total delivery units per employee (base units per completed day + units). */
export const DELIVERY_T09_UNITS: Record<string, number> = {
  DUYEN: 26,
  TUAN: 25,
  CHAT: 21.25,
  BINH: 0,
};

/** Delivery extras of T09: Chất has 150.000 + 840.000. */
export const DELIVERY_T09_EXTRAS: Record<string, number> = {
  CHAT: 150_000 + 840_000,
};

export const DELIVERY_T10_UNITS: Record<string, number> = {
  DUYEN: 26.5,
  TUAN: 27,
};

export const DELIVERY_T10_EXTRAS: Record<string, number> = {};

export const DELIVERY_T09_EXPECTED: Record<string, number> = {
  DUYEN: 3_733_000,
  TUAN: 3_667_000,
  CHAT: 13_823_000,
  BINH: 13_400_000,
};

export const DELIVERY_T10_EXPECTED: Record<string, number> = {
  DUYEN: 3_710_000,
  TUAN: 3_742_000,
};
