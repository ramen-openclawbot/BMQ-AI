// T09.2026 fixture — provisional, sourced from the sheet "BangLuong_T09-2026
// DIEU CHINH" (output/payroll-bn-spec-tables.md, T09.2026).
//
// 20 rows copied verbatim from the spec. That file is the single source of
// truth: do not add rows, rename employees or change a figure. If the engine
// disagrees, fix the engine against R1–R9.
//
//   * Bếp bánh / Kho BN standard = 26 days, Văn phòng standard = 22 days.
//   * Q10: the two paid holidays are unconfirmed; 2026-09-01 / 2026-09-02 are
//     placeholders from the spec until the sheet is re-issued.
//   * NC TT is entered from the sheet; the engine adds eligible holidays (R9)
//     to get NC tính lương. Officials without a start date started earlier.
//
// Adjustments (each with a reason, from the spec):
//   * Mai     exclude_holiday — NC nhập tay theo bảng DIEU CHINH (22 = chuẩn).
//   * Vĩnh An work_days 24,5 + allowance 500.000 (spec Q1: chưa rõ lý do).
//   * Trang   exclude_holiday + exclude_overtime — "Chốt lương".
//   * Yến     nghỉ việc từ T09 ⇒ dòng trống (terminated).
//   * Saly    bắt đầu 03/09; Hồng bắt đầu 30/09 ⇒ không cộng lễ 01–02/09.
//
// Expected group results (spec):
//   Tổng thực nhận 96.681.000
//   Bếp bánh: NC thực tế 112,5 | NC tính lương 120,5 | giờ part-time 414,99
//   Kho BN:   NC thực tế 50    | NC tính lương 54    | giờ part-time 564,36

import { adjustment, manual, manualRow, type PayrollBnFixture } from "./fixture-helpers.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { PayrollEmployee, PayrollEmployeeMeasures, PayrollPeriod } from "./types.ts";

const GROUP_BEP = "Bếp bánh" as const;
const GROUP_KHO = "Kho BN" as const;
const GROUP_VAN_PHONG = "Văn phòng" as const;

// Q10 — placeholder holiday dates (see the note above).
const HOLIDAYS = ["2026-09-01", "2026-09-02"];

interface OfficialOptions {
  overtimeRate?: number | null;
  allowance?: number | null;
  startDate?: string | null;
  terminated?: boolean;
}

function official(
  code: string,
  name: string,
  group: PayrollEmployee["group"],
  monthlySalary: number | null,
  options: OfficialOptions = {},
): PayrollEmployee {
  if (options.terminated) {
    return {
      code,
      name,
      group,
      employmentType: "official",
      monthlySalary: null,
      hourlyRate: null,
      allowance: null,
      overtimeRate: null,
      startDate: null,
      terminated: true,
    };
  }
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
  official("BN01", "Lê Thị Kim Yến", GROUP_VAN_PHONG, null, { terminated: true }),
  official("BN02", "Nguyễn Thị Xuân Mai", GROUP_VAN_PHONG, 9_600_000),
  // Bếp bánh — 9 rows
  official("BN03", "Lưu Vĩnh An", GROUP_BEP, 13_000_000, { overtimeRate: 30_000, allowance: 500_000 }),
  official("BN04", "Hà Tuấn Huy", GROUP_BEP, 17_000_000),
  official("BN05", "Nguyễn Lê Huyền Trang", GROUP_BEP, 8_000_000, { overtimeRate: 30_000 }),
  official("BN06", "Nguyễn Khoa Văn", GROUP_BEP, 8_000_000, { overtimeRate: 30_000 }),
  official("BN07", "Nguyễn Anh Thư", GROUP_BEP, 7_000_000, { overtimeRate: 30_000 }),
  partTime("BN08", "Lê Nguyễn Hoàng Long", GROUP_BEP, 30_000),
  partTime("BN09", "Đoàn Ngô Mai Khanh", GROUP_BEP, 30_000),
  partTime("BN10", "Phan Huỳnh Thu Thảo", GROUP_BEP, 30_000),
  official("BN11", "Saly", GROUP_BEP, 6_500_000, { overtimeRate: 30_000, startDate: "2026-09-03" }),
  // Kho BN — 9 rows
  official("BN12", "Vũ Phương Nhi", GROUP_KHO, 8_000_000, { overtimeRate: 30_000 }),
  official("BN13", "Huỳnh Kim Ngân", GROUP_KHO, 5_000_000, { overtimeRate: 25_000 }),
  partTime("BN14", "Trần Kỳ Duyên", GROUP_KHO, 23_000),
  partTime("BN15", "Nguyễn Hải Yến", GROUP_KHO, 25_000),
  partTime("BN16", "Nguyễn Quế Nghi", GROUP_KHO, 25_000),
  partTime("BN17", "Lê Trần Cẩm Tú", GROUP_KHO, 23_000),
  partTime("BN18", "Hùng Kim Ngọc", GROUP_KHO, 23_000),
  partTime("BN19", "Trương Thị Yến Minh", GROUP_KHO, 25_000),
  official("BN20", "Hồng", GROUP_KHO, 5_000_000, { overtimeRate: 25_000, startDate: "2026-09-30" }),
];

const period: PayrollPeriod = {
  code: "T09.2026",
  name: "Kỳ lương tháng 09/2026 — Bếp BN (tạm tính)",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  standardDaysByGroup: { [GROUP_BEP]: 26, [GROUP_KHO]: 26, [GROUP_VAN_PHONG]: 22 },
  defaultStandardDays: 26,
  holidays: HOLIDAYS,
  rules: resolveRulesConfig(),
  status: "draft",
};

const measures: Record<string, PayrollEmployeeMeasures> = {
  BN02: { actualWorkDays: manual(22) },
  BN03: { actualWorkDays: manual(25), overtimeHours: manual(62.26) },
  BN04: { actualWorkDays: manual(9), overtimeHours: manual(4.75) },
  BN05: { actualWorkDays: manual(9), overtimeHours: manual(0.28) },
  BN06: { actualWorkDays: manual(23), overtimeHours: manual(20) },
  BN07: { actualWorkDays: manual(22), overtimeHours: manual(0) },
  BN08: { partTimeHours: manual(205.07) },
  BN09: { partTimeHours: manual(0) },
  BN10: { partTimeHours: manual(209.92) },
  BN11: { actualWorkDays: manual(25), overtimeHours: manual(10.79) },
  BN12: { actualWorkDays: manual(25), overtimeHours: manual(23.98) },
  BN13: { actualWorkDays: manual(24), overtimeHours: manual(17.21) },
  BN14: { partTimeHours: manual(164.33) },
  BN15: { partTimeHours: manual(0) },
  BN16: { partTimeHours: manual(34.43) },
  BN17: { partTimeHours: manual(197.75) },
  BN18: { partTimeHours: manual(167.85) },
  BN19: { partTimeHours: manual(0) },
  BN20: { actualWorkDays: manual(1), overtimeHours: manual(1) },
};

const adjustments = [
  adjustment(
    "BN02",
    "exclude_holiday",
    null,
    "Văn phòng: NC nhập tay theo bảng DIEU CHINH",
  ),
  adjustment(
    "BN03",
    "work_days",
    24.5,
    "Điều chỉnh tay trên bảng DIEU CHINH (chưa rõ lý do, Q1)",
  ),
  adjustment("BN05", "exclude_holiday", null, "Chốt lương"),
  adjustment("BN05", "exclude_overtime", null, "Chốt lương"),
];

// Expected "NC tính lương" (work_days) and "Net pay" for the reconciler.
// Part-time rows have no day column, so their work_days is 0.
const manualExpected: Record<string, { work_days: number; net_pay: number }> = {
  BN01: { work_days: 0, net_pay: 0 },
  BN02: { work_days: 22, net_pay: 9_600_000 },
  BN03: { work_days: 26.5, net_pay: 15_618_000 },
  BN04: { work_days: 11, net_pay: 7_192_000 },
  BN05: { work_days: 9, net_pay: 2_769_000 },
  BN06: { work_days: 25, net_pay: 8_292_000 },
  BN07: { work_days: 24, net_pay: 6_462_000 },
  BN08: { work_days: 0, net_pay: 6_152_000 },
  BN09: { work_days: 0, net_pay: 0 },
  BN10: { work_days: 0, net_pay: 6_298_000 },
  BN11: { work_days: 25, net_pay: 6_574_000 },
  BN12: { work_days: 27, net_pay: 9_027_000 },
  BN13: { work_days: 26, net_pay: 5_430_000 },
  BN14: { work_days: 0, net_pay: 3_780_000 },
  BN15: { work_days: 0, net_pay: 0 },
  BN16: { work_days: 0, net_pay: 861_000 },
  BN17: { work_days: 0, net_pay: 4_548_000 },
  BN18: { work_days: 0, net_pay: 3_861_000 },
  BN19: { work_days: 0, net_pay: 0 },
  BN20: { work_days: 1, net_pay: 217_000 },
};

export const T09_FIXTURE: PayrollBnFixture = {
  code: "T09.2026",
  status: "provisional",
  source: "Sheet DIEU CHINH — bảng lương tạm tính (output/payroll-bn-spec-tables.md)",
  period,
  employees,
  measures,
  rows: [],
  adjustments,
  manual: employees.map((employee) => manualRow(employee, manualExpected[employee.code])),
  reconcileFields: ["work_days", "net_pay"],
};

export const T09_EMPLOYEE_COUNT = 20;

export const T09_GROUP_TOTALS = {
  totalNet: 96_681_000,
  bepActualWorkDays: 112.5,
  bepWorkDays: 120.5,
  bepPartTimeHours: 414.99,
  khoActualWorkDays: 50,
  khoWorkDays: 54,
  khoPartTimeHours: 564.36,
  vanPhongDayPay: "9600000",
  bepDayPay: "56065084.62",
  khoDayPay: "26549140",
  totalDayPay: "92214224.62",
  vanPhongOvertimePay: 0,
  bepOvertimePay: 2_791_500,
  khoOvertimePay: 1_174_650,
  totalOvertimePay: 3_966_150,
  vanPhongGross: "9600000",
  bepGross: "59356584.62",
  khoGross: "27723790",
  totalGross: "96680374.62",
  vanPhongNet: 9_600_000,
  bepNet: 59_357_000,
  khoNet: 27_724_000,
} as const;
