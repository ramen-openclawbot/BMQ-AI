// T08.2026 fixture — the standard set that was already paid.
//
// 18 rows copied verbatim from output/payroll-bn-spec-tables.md (T08.2026).
// That file is the single source of truth: do not add rows, rename employees
// or change a figure. If the engine disagrees, fix the engine against R1–R9.
//
//   * Bếp bánh / Kho BN standard = 27 days, Văn phòng standard = 22 days.
//   * August has no holidays, so NC tính lương (workDays) = NC thực tế.
//   * CT rows enter NC TT (actual days) and TC (overtime hours); PT rows enter
//     part-time hours and are paid only on the hour column (R4/R8).
//
// Expected group results (spec):
//   Văn phòng 18.640.000 | Bếp bánh 71.633.000 | Kho BN 30.285.000
//   Tổng thực nhận 120.558.000
//   Trước làm tròn: Bếp 71.632.074,07 | Kho 30.286.511,48 | tổng 120.558.585,56
//   Giờ TC: Bếp 88,69 | Kho 50,49

import { manual, manualRow, type PayrollBnFixture } from "./fixture-helpers.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { PayrollEmployee, PayrollEmployeeMeasures, PayrollPeriod } from "./types.ts";

const GROUP_BEP = "Bếp bánh" as const;
const GROUP_KHO = "Kho BN" as const;
const GROUP_VAN_PHONG = "Văn phòng" as const;

interface OfficialOptions {
  overtimeRate?: number | null;
  allowance?: number | null;
  startDate?: string | null;
}

function official(
  code: string,
  name: string,
  group: PayrollEmployee["group"],
  monthlySalary: number,
  options: OfficialOptions = {},
): PayrollEmployee {
  return {
    code,
    name,
    group,
    employmentType: "official",
    monthlySalary,
    hourlyRate: null,
    allowance: options.allowance ?? null,
    overtimeRate: options.overtimeRate ?? null,
    startDate: options.startDate ?? "2025-01-01",
  };
}

function partTime(
  code: string,
  name: string,
  group: PayrollEmployee["group"],
  hourlyRate: number,
): PayrollEmployee {
  return {
    code,
    name,
    group,
    employmentType: "part_time",
    monthlySalary: null,
    hourlyRate,
    allowance: null,
    overtimeRate: null,
    startDate: "2025-01-01",
  };
}

const employees: PayrollEmployee[] = [
  // Văn phòng — 2 rows
  official("BN01", "Lê Thị Kim Yến", GROUP_VAN_PHONG, 10_000_000, { allowance: 320_000 }),
  official("BN02", "Nguyễn Thị Xuân Mai", GROUP_VAN_PHONG, 8_000_000, { allowance: 320_000 }),
  // Bếp bánh — 8 rows
  official("BN03", "Lưu Vĩnh An", GROUP_BEP, 13_000_000, { overtimeRate: 30_000, allowance: 500_000 }),
  official("BN04", "Hà Tuấn Huy", GROUP_BEP, 17_000_000),
  official("BN05", "Nguyễn Lê Huyền Trang", GROUP_BEP, 8_000_000, { overtimeRate: 30_000 }),
  official("BN06", "Nguyễn Khoa Văn", GROUP_BEP, 8_000_000, { overtimeRate: 30_000 }),
  official("BN07", "Nguyễn Anh Thư", GROUP_BEP, 7_000_000),
  partTime("BN08", "Lê Nguyễn Hoàng Long", GROUP_BEP, 30_000),
  partTime("BN09", "Đoàn Ngô Mai Khanh", GROUP_BEP, 30_000),
  partTime("BN10", "Phan Huỳnh Thu Thảo", GROUP_BEP, 30_000),
  // Kho BN — 8 rows
  official("BN11", "Vũ Phương Nhi", GROUP_KHO, 8_000_000, { overtimeRate: 30_000 }),
  official("BN12", "Huỳnh Kim Ngân", GROUP_KHO, 5_000_000, { overtimeRate: 25_000 }),
  partTime("BN13", "Trần Kỳ Duyên", GROUP_KHO, 23_000),
  partTime("BN14", "Nguyễn Hải Yến", GROUP_KHO, 25_000),
  partTime("BN15", "Nguyễn Quế Nghi", GROUP_KHO, 25_000),
  partTime("BN16", "Lê Trần Cẩm Tú", GROUP_KHO, 23_000),
  partTime("BN17", "Hùng Kim Ngọc", GROUP_KHO, 23_000),
  partTime("BN18", "Trương Thị Yến Minh", GROUP_KHO, 25_000),
];

const period: PayrollPeriod = {
  code: "T08.2026",
  name: "Kỳ lương tháng 08/2026 — Bếp BN",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-31",
  standardDaysByGroup: { [GROUP_BEP]: 27, [GROUP_KHO]: 27, [GROUP_VAN_PHONG]: 22 },
  defaultStandardDays: 27,
  holidays: [],
  rules: resolveRulesConfig(),
  status: "locked",
};

// NC TT is entered from the sheet; the engine derives NC tính lương (no holidays
// in August, so the two are equal).
const measures: Record<string, PayrollEmployeeMeasures> = {
  BN01: { actualWorkDays: manual(22) },
  BN02: { actualWorkDays: manual(22) },
  BN03: { actualWorkDays: manual(27), overtimeHours: manual(50.9) },
  BN04: { actualWorkDays: manual(27) },
  BN05: { actualWorkDays: manual(26), overtimeHours: manual(3.33) },
  BN06: { actualWorkDays: manual(27), overtimeHours: manual(34.46) },
  BN07: { actualWorkDays: manual(26.5) },
  BN08: { partTimeHours: manual(236.52) },
  BN09: { partTimeHours: manual(60.32) },
  BN10: { partTimeHours: manual(233.07) },
  BN11: { actualWorkDays: manual(28), overtimeHours: manual(25) },
  BN12: { actualWorkDays: manual(28), overtimeHours: manual(25.49) },
  BN13: { partTimeHours: manual(125.49) },
  BN14: { partTimeHours: manual(68.65) },
  BN15: { partTimeHours: manual(101.57) },
  BN16: { partTimeHours: manual(208.49) },
  BN17: { partTimeHours: manual(133.13) },
  BN18: { partTimeHours: manual(16.75) },
};

// Expected "NC tính lương" (work_days) and "Net pay" for the reconciler. The
// part-time rows have no day column, so their work_days is 0.
const manualExpected: Record<string, { work_days: number; net_pay: number }> = {
  BN01: { work_days: 22, net_pay: 10_320_000 },
  BN02: { work_days: 22, net_pay: 8_320_000 },
  BN03: { work_days: 27, net_pay: 15_027_000 },
  BN04: { work_days: 27, net_pay: 17_000_000 },
  BN05: { work_days: 26, net_pay: 7_804_000 },
  BN06: { work_days: 27, net_pay: 9_034_000 },
  BN07: { work_days: 26.5, net_pay: 6_870_000 },
  BN08: { work_days: 0, net_pay: 7_096_000 },
  BN09: { work_days: 0, net_pay: 1_810_000 },
  BN10: { work_days: 0, net_pay: 6_992_000 },
  BN11: { work_days: 28, net_pay: 9_046_000 },
  BN12: { work_days: 28, net_pay: 5_822_000 },
  BN13: { work_days: 0, net_pay: 2_886_000 },
  BN14: { work_days: 0, net_pay: 1_716_000 },
  BN15: { work_days: 0, net_pay: 2_539_000 },
  BN16: { work_days: 0, net_pay: 4_795_000 },
  BN17: { work_days: 0, net_pay: 3_062_000 },
  BN18: { work_days: 0, net_pay: 419_000 },
};

export const T08_FIXTURE: PayrollBnFixture = {
  code: "T08.2026",
  status: "standard",
  source: "Bảng lương Bếp BN tháng 08/2026 đã chi (output/payroll-bn-spec-tables.md)",
  period,
  employees,
  measures,
  rows: [],
  adjustments: [],
  manual: employees.map((employee) => manualRow(employee, manualExpected[employee.code])),
  reconcileFields: ["work_days", "net_pay"],
};

export const T08_EMPLOYEE_COUNT = 18;

export const T08_GROUP_TOTALS = {
  vanPhongNet: 18_640_000,
  bepNet: 71_633_000,
  khoNet: 30_285_000,
  totalNet: 120_558_000,
  bepGross: "71632074.07",
  khoGross: "30286511.48",
  totalGross: "120558585.56",
  bepOvertimeHours: 88.69,
  khoOvertimeHours: 50.49,
} as const;
