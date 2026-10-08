import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import {
  addRational,
  mulRational,
  rational,
  rationalFromNumber,
  roundHalfUpToStep,
  type Rational,
} from "./money.ts";
import { T08_EMPLOYEE_COUNT, T08_FIXTURE, T08_GROUP_TOTALS } from "./payroll-bn-t08.fixture.ts";
import { T09_EMPLOYEE_COUNT, T09_FIXTURE, T09_GROUP_TOTALS } from "./payroll-bn-t09.fixture.ts";
import { DEFAULT_RECONCILE_FIELDS, reconcilePayroll } from "./reconcile.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type {
  AttendanceRow,
  EmploymentType,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeMeasures,
  PayrollGroup,
  PayrollPeriod,
} from "./types.ts";

function money(value: bigint): string {
  return value.toString();
}

/** Exact rational → fixed 2-decimal string (round half up), for display only. */
function decimal2(value: Rational): string {
  const scaled = roundHalfUpToStep(mulRational(value, rational(100)), 1n);
  const text = scaled.toString();
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function q(numerator: number, denominator = 1): Rational {
  return rational(BigInt(numerator), BigInt(denominator));
}

/** Normalise a spec decimal (number or "123.45") to the engine's 2-decimal form. */
function dec2(value: number | string): string {
  return decimal2(rationalFromNumber(typeof value === "string" ? Number(value) : value));
}

/** 1234567 → "1.234.567" (display only). */
function groupInt(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function matchedEmployeeCount(report: ReturnType<typeof reconcilePayroll>): number {
  return report.perEmployee.filter(
    (row) => row.employeeCode.startsWith("BN") && row.mismatched === 0 && row.missing === 0,
  ).length;
}

function compute(fixture: typeof T08_FIXTURE) {
  return computePayroll({
    period: fixture.period,
    employees: fixture.employees,
    rows: fixture.rows,
    measures: fixture.measures,
    adjustments: fixture.adjustments,
  });
}

function reconcileFixture(fixture: typeof T08_FIXTURE) {
  const result = compute(fixture);
  const fields = DEFAULT_RECONCILE_FIELDS.filter((field) => fixture.reconcileFields.includes(field.key));
  const report = reconcilePayroll({
    periodCode: fixture.period.code,
    employees: result.employees,
    manual: fixture.manual,
    fields,
  });
  return { result, report };
}

function employeesByName(result: ReturnType<typeof computePayroll>) {
  return new Map(result.employees.map((line) => [line.employeeName, line]));
}

function groupsByName(result: ReturnType<typeof computePayroll>) {
  return new Map(result.groups.map((group) => [group.group, group]));
}

// ---------------------------------------------------------------------------
// T08.2026 — bảng lương tháng 08 (spec T08.2026)
// ---------------------------------------------------------------------------

interface ExpectedT08 {
  name: string;
  group: PayrollGroup;
  type: EmploymentType;
  workDays: number;
  partTimeHours: number;
  overtimeHours: number;
  overtimePay: number;
  allowance: number;
  netPay: number;
}

const T08_ROWS: readonly ExpectedT08[] = [
  { name: "Lê Thị Kim Yến", group: "Văn phòng", type: "official", workDays: 22, partTimeHours: 0, overtimeHours: 0, overtimePay: 0, allowance: 320_000, netPay: 10_320_000 },
  { name: "Nguyễn Thị Xuân Mai", group: "Văn phòng", type: "official", workDays: 22, partTimeHours: 0, overtimeHours: 0, overtimePay: 0, allowance: 320_000, netPay: 8_320_000 },
  { name: "Lưu Vĩnh An", group: "Bếp bánh", type: "official", workDays: 27, partTimeHours: 0, overtimeHours: 50.9, overtimePay: 1_527_000, allowance: 500_000, netPay: 15_027_000 },
  { name: "Hà Tuấn Huy", group: "Bếp bánh", type: "official", workDays: 27, partTimeHours: 0, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 17_000_000 },
  { name: "Nguyễn Lê Huyền Trang", group: "Bếp bánh", type: "official", workDays: 26, partTimeHours: 0, overtimeHours: 3.33, overtimePay: 99_900, allowance: 0, netPay: 7_804_000 },
  { name: "Nguyễn Khoa Văn", group: "Bếp bánh", type: "official", workDays: 27, partTimeHours: 0, overtimeHours: 34.46, overtimePay: 1_033_800, allowance: 0, netPay: 9_034_000 },
  { name: "Nguyễn Anh Thư", group: "Bếp bánh", type: "official", workDays: 26.5, partTimeHours: 0, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 6_870_000 },
  { name: "Lê Nguyễn Hoàng Long", group: "Bếp bánh", type: "part_time", workDays: 0, partTimeHours: 236.52, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 7_096_000 },
  { name: "Đoàn Ngô Mai Khanh", group: "Bếp bánh", type: "part_time", workDays: 0, partTimeHours: 60.32, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 1_810_000 },
  { name: "Phan Huỳnh Thu Thảo", group: "Bếp bánh", type: "part_time", workDays: 0, partTimeHours: 233.07, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 6_992_000 },
  { name: "Vũ Phương Nhi", group: "Kho BN", type: "official", workDays: 28, partTimeHours: 0, overtimeHours: 25, overtimePay: 750_000, allowance: 0, netPay: 9_046_000 },
  { name: "Huỳnh Kim Ngân", group: "Kho BN", type: "official", workDays: 28, partTimeHours: 0, overtimeHours: 25.49, overtimePay: 637_250, allowance: 0, netPay: 5_822_000 },
  { name: "Trần Kỳ Duyên", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 125.49, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 2_886_000 },
  { name: "Nguyễn Hải Yến", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 68.65, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 1_716_000 },
  { name: "Nguyễn Quế Nghi", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 101.57, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 2_539_000 },
  { name: "Lê Trần Cẩm Tú", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 208.49, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 4_795_000 },
  { name: "Hùng Kim Ngọc", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 133.13, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 3_062_000 },
  { name: "Trương Thị Yến Minh", group: "Kho BN", type: "part_time", workDays: 0, partTimeHours: 16.75, overtimeHours: 0, overtimePay: 0, allowance: 0, netPay: 419_000 },
];

test("T08 fixture computes 18/18 real rows and reconciles NC TL + net pay", () => {
  const { result, report } = reconcileFixture(T08_FIXTURE);
  assert.equal(T08_EMPLOYEE_COUNT, 18);
  assert.equal(T08_FIXTURE.employees.length, 18);
  assert.equal(result.employees.length, 18);
  assert.equal(report.perEmployee.length, 18);
  assert.equal(report.mismatchedCells, 0);
  assert.equal(report.missingCells, 0);
  assert.equal(matchedEmployeeCount(report), 18);
  assert.equal(report.fullyMatched, true);
});

test("T08 per-employee work days, hours, pay and net pay match the spec table", () => {
  const result = compute(T08_FIXTURE);
  const lines = employeesByName(result);
  assert.equal(T08_ROWS.length, 18);
  for (const expected of T08_ROWS) {
    const line = lines.get(expected.name);
    assert.ok(line, `missing T08 employee ${expected.name}`);
    assert.equal(line!.group, expected.group, expected.name);
    assert.equal(line!.employmentType, expected.type, expected.name);
    assert.deepEqual(line!.workDays, rationalFromNumber(expected.workDays), `${expected.name} NC TL`);
    assert.deepEqual(line!.partTimeHours, rationalFromNumber(expected.partTimeHours), `${expected.name} hours`);
    assert.deepEqual(line!.overtimeHours, rationalFromNumber(expected.overtimeHours), `${expected.name} TC`);
    assert.deepEqual(line!.overtimePay, rationalFromNumber(expected.overtimePay), `${expected.name} OT pay`);
    assert.deepEqual(line!.allowance, rationalFromNumber(expected.allowance), `${expected.name} allowance`);
    assert.equal(line!.netPayRounded, BigInt(expected.netPay), `${expected.name} net pay`);
  }
});

test("T08 intermediate day pay stays exact as rationals (R1)", () => {
  const result = compute(T08_FIXTURE);
  const lines = employeesByName(result);
  // Trang 208000000/27 | Thư 185500000/27
  assert.deepEqual(lines.get("Nguyễn Lê Huyền Trang")!.dayPay, q(208_000_000, 27));
  assert.deepEqual(lines.get("Nguyễn Anh Thư")!.dayPay, q(185_500_000, 27));
  // Nhi 224000000/27 | Ngân 140000000/27
  assert.deepEqual(lines.get("Vũ Phương Nhi")!.dayPay, q(224_000_000, 27));
  assert.deepEqual(lines.get("Huỳnh Kim Ngân")!.dayPay, q(140_000_000, 27));
  assert.equal(decimal2(lines.get("Nguyễn Lê Huyền Trang")!.dayPay), "7703703.70");
  assert.equal(decimal2(lines.get("Nguyễn Anh Thư")!.dayPay), "6870370.37");
  assert.equal(decimal2(lines.get("Vũ Phương Nhi")!.dayPay), "8296296.30");
  assert.equal(decimal2(lines.get("Huỳnh Kim Ngân")!.dayPay), "5185185.19");
});

test("T08 overtime pay follows R3 for the five employees with TC", () => {
  const result = compute(T08_FIXTURE);
  const lines = employeesByName(result);
  assert.deepEqual(lines.get("Lưu Vĩnh An")!.overtimePay, rational(1_527_000)); // 50,9h × 30.000
  assert.deepEqual(lines.get("Nguyễn Lê Huyền Trang")!.overtimePay, rational(99_900)); // 3,33h × 30.000
  assert.deepEqual(lines.get("Nguyễn Khoa Văn")!.overtimePay, rational(1_033_800)); // 34,46h × 30.000
  assert.deepEqual(lines.get("Vũ Phương Nhi")!.overtimePay, rational(750_000)); // 25h × 30.000
  assert.deepEqual(lines.get("Huỳnh Kim Ngân")!.overtimePay, rational(637_250)); // 25,49h × 25.000
  // Employees without a rate have TC = 0 (R3).
  assert.deepEqual(lines.get("Hà Tuấn Huy")!.overtimePay, rational(0));
  assert.deepEqual(lines.get("Nguyễn Anh Thư")!.overtimePay, rational(0));
});

test("T08 group and total rows sum the employee lines (R6) and match the spec", () => {
  const result = compute(T08_FIXTURE);
  assert.equal(result.groups.length, 3);
  assert.equal(result.lines.length, 18 + 3 + 1);
  const byGroup = groupsByName(result);
  assert.equal(money(byGroup.get("Văn phòng")!.netPayRounded), money(BigInt(T08_GROUP_TOTALS.vanPhongNet)));
  assert.equal(money(byGroup.get("Bếp bánh")!.netPayRounded), money(BigInt(T08_GROUP_TOTALS.bepNet)));
  assert.equal(money(byGroup.get("Kho BN")!.netPayRounded), money(BigInt(T08_GROUP_TOTALS.khoNet)));
  assert.equal(money(result.total.netPayRounded), money(BigInt(T08_GROUP_TOTALS.totalNet)));
  assert.equal(result.total.employeeCount, 18);
  // Group net is the sum of the individual rounded amounts (R6).
  const sumRounded = result.employees.reduce((total, line) => total + line.netPayRounded, 0n);
  assert.equal(result.total.netPayRounded, sumRounded);
});

test("T08 before-rounding group gross and overtime hours match the spec", () => {
  const result = compute(T08_FIXTURE);
  const byGroup = groupsByName(result);
  const bep = byGroup.get("Bếp bánh")!;
  const kho = byGroup.get("Kho BN")!;
  assert.equal(decimal2(bep.grossPay), T08_GROUP_TOTALS.bepGross);
  assert.equal(decimal2(kho.grossPay), T08_GROUP_TOTALS.khoGross);
  assert.equal(decimal2(result.total.grossPay), T08_GROUP_TOTALS.totalGross);
  assert.deepEqual(bep.overtimeHours, rational(8869, 100));
  assert.deepEqual(kho.overtimeHours, rational(5049, 100));
  assert.equal(Number(T08_GROUP_TOTALS.bepOvertimeHours), 88.69);
  assert.equal(Number(T08_GROUP_TOTALS.khoOvertimeHours), 50.49);
});

// ---------------------------------------------------------------------------
// T09.2026 — bảng lương tháng 09 (spec T09.2026, tạm tính)
// ---------------------------------------------------------------------------

interface ExpectedT09 {
  name: string;
  group: PayrollGroup;
  type: EmploymentType;
  actualWorkDays: number;
  workDays: number;
  dayPay: number | string; // spec "Day pay" (PT rows: hours × rate)
  overtimePay: number;
  netPay: number;
}

const T09_ROWS: readonly ExpectedT09[] = [
  { name: "Lê Thị Kim Yến", group: "Văn phòng", type: "official", actualWorkDays: 0, workDays: 0, dayPay: 0, overtimePay: 0, netPay: 0 },
  { name: "Nguyễn Thị Xuân Mai", group: "Văn phòng", type: "official", actualWorkDays: 22, workDays: 22, dayPay: 9_600_000, overtimePay: 0, netPay: 9_600_000 },
  { name: "Lưu Vĩnh An", group: "Bếp bánh", type: "official", actualWorkDays: 24.5, workDays: 26.5, dayPay: 13_250_000, overtimePay: 1_867_800, netPay: 15_618_000 },
  { name: "Hà Tuấn Huy", group: "Bếp bánh", type: "official", actualWorkDays: 9, workDays: 11, dayPay: "7192307.69", overtimePay: 0, netPay: 7_192_000 },
  { name: "Nguyễn Lê Huyền Trang", group: "Bếp bánh", type: "official", actualWorkDays: 9, workDays: 9, dayPay: "2769230.77", overtimePay: 0, netPay: 2_769_000 },
  { name: "Nguyễn Khoa Văn", group: "Bếp bánh", type: "official", actualWorkDays: 23, workDays: 25, dayPay: "7692307.69", overtimePay: 600_000, netPay: 8_292_000 },
  { name: "Nguyễn Anh Thư", group: "Bếp bánh", type: "official", actualWorkDays: 22, workDays: 24, dayPay: "6461538.46", overtimePay: 0, netPay: 6_462_000 },
  { name: "Lê Nguyễn Hoàng Long", group: "Bếp bánh", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 6_152_100, overtimePay: 0, netPay: 6_152_000 },
  { name: "Đoàn Ngô Mai Khanh", group: "Bếp bánh", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 0, overtimePay: 0, netPay: 0 },
  { name: "Phan Huỳnh Thu Thảo", group: "Bếp bánh", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 6_297_600, overtimePay: 0, netPay: 6_298_000 },
  { name: "Saly", group: "Bếp bánh", type: "official", actualWorkDays: 25, workDays: 25, dayPay: 6_250_000, overtimePay: 323_700, netPay: 6_574_000 },
  { name: "Vũ Phương Nhi", group: "Kho BN", type: "official", actualWorkDays: 25, workDays: 27, dayPay: "8307692.31", overtimePay: 719_400, netPay: 9_027_000 },
  { name: "Huỳnh Kim Ngân", group: "Kho BN", type: "official", actualWorkDays: 24, workDays: 26, dayPay: 5_000_000, overtimePay: 430_250, netPay: 5_430_000 },
  { name: "Trần Kỳ Duyên", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 3_779_590, overtimePay: 0, netPay: 3_780_000 },
  { name: "Nguyễn Hải Yến", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 0, overtimePay: 0, netPay: 0 },
  { name: "Nguyễn Quế Nghi", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 860_750, overtimePay: 0, netPay: 861_000 },
  { name: "Lê Trần Cẩm Tú", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 4_548_250, overtimePay: 0, netPay: 4_548_000 },
  { name: "Hùng Kim Ngọc", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 3_860_550, overtimePay: 0, netPay: 3_861_000 },
  { name: "Trương Thị Yến Minh", group: "Kho BN", type: "part_time", actualWorkDays: 0, workDays: 0, dayPay: 0, overtimePay: 0, netPay: 0 },
  { name: "Hồng", group: "Kho BN", type: "official", actualWorkDays: 1, workDays: 1, dayPay: "192307.69", overtimePay: 25_000, netPay: 217_000 },
];

function specDayPay(line: ReturnType<typeof computePayroll>["employees"][number]): Rational {
  return line.employmentType === "part_time" ? line.partTimePay : line.dayPay;
}

test("T09 fixture computes 20/20 real rows and is provisional", () => {
  const { result, report } = reconcileFixture(T09_FIXTURE);
  assert.equal(T09_EMPLOYEE_COUNT, 20);
  assert.equal(T09_FIXTURE.status, "provisional");
  assert.equal(T09_FIXTURE.source.includes("DIEU CHINH"), true);
  assert.equal(T09_FIXTURE.employees.length, 20);
  assert.equal(result.employees.length, 20);
  assert.equal(report.perEmployee.length, 20);
  assert.equal(report.mismatchedCells, 0);
  assert.equal(report.missingCells, 0);
  assert.equal(matchedEmployeeCount(report), 20);
  assert.equal(report.fullyMatched, true);
});

test("T09 NC TT / NC TL / day pay / OT pay / net pay match the spec table", () => {
  const result = compute(T09_FIXTURE);
  const lines = employeesByName(result);
  assert.equal(T09_ROWS.length, 20);
  for (const expected of T09_ROWS) {
    const line = lines.get(expected.name);
    assert.ok(line, `missing T09 employee ${expected.name}`);
    assert.equal(line!.group, expected.group, expected.name);
    assert.equal(line!.employmentType, expected.type, expected.name);
    assert.deepEqual(line!.actualWorkDays, rationalFromNumber(expected.actualWorkDays), `${expected.name} NC TT`);
    assert.deepEqual(line!.workDays, rationalFromNumber(expected.workDays), `${expected.name} NC TL`);
    assert.equal(decimal2(specDayPay(line!)), dec2(expected.dayPay), `${expected.name} day pay`);
    assert.deepEqual(line!.overtimePay, rationalFromNumber(expected.overtimePay), `${expected.name} OT pay`);
    assert.equal(line!.netPayRounded, BigInt(expected.netPay), `${expected.name} net pay`);
  }
});

test("T09 group day pay / OT pay / gross / net match bảng nhóm", () => {
  const result = compute(T09_FIXTURE);
  const byGroup = groupsByName(result);
  const vanPhong = byGroup.get("Văn phòng")!;
  const bep = byGroup.get("Bếp bánh")!;
  const kho = byGroup.get("Kho BN")!;
  const groupDayPay = (line: { dayPay: Rational; partTimePay: Rational }) =>
    addRational(line.dayPay, line.partTimePay);

  assert.equal(decimal2(groupDayPay(vanPhong)), dec2(T09_GROUP_TOTALS.vanPhongDayPay));
  assert.equal(decimal2(groupDayPay(bep)), dec2(T09_GROUP_TOTALS.bepDayPay));
  assert.equal(decimal2(groupDayPay(kho)), dec2(T09_GROUP_TOTALS.khoDayPay));
  assert.equal(decimal2(groupDayPay(result.total)), dec2(T09_GROUP_TOTALS.totalDayPay));

  assert.deepEqual(vanPhong.overtimePay, rational(T09_GROUP_TOTALS.vanPhongOvertimePay));
  assert.deepEqual(bep.overtimePay, rational(T09_GROUP_TOTALS.bepOvertimePay));
  assert.deepEqual(kho.overtimePay, rational(T09_GROUP_TOTALS.khoOvertimePay));
  assert.deepEqual(result.total.overtimePay, rational(T09_GROUP_TOTALS.totalOvertimePay));

  assert.equal(decimal2(vanPhong.grossPay), dec2(T09_GROUP_TOTALS.vanPhongGross));
  assert.equal(decimal2(bep.grossPay), dec2(T09_GROUP_TOTALS.bepGross));
  assert.equal(decimal2(kho.grossPay), dec2(T09_GROUP_TOTALS.khoGross));
  assert.equal(decimal2(result.total.grossPay), dec2(T09_GROUP_TOTALS.totalGross));

  assert.equal(money(vanPhong.netPayRounded), money(BigInt(T09_GROUP_TOTALS.vanPhongNet)));
  assert.equal(money(bep.netPayRounded), money(BigInt(T09_GROUP_TOTALS.bepNet)));
  assert.equal(money(kho.netPayRounded), money(BigInt(T09_GROUP_TOTALS.khoNet)));
  assert.equal(money(result.total.netPayRounded), money(BigInt(T09_GROUP_TOTALS.totalNet)));
});

test("T09 group day/hour columns match the spec (NC TT / NC TL / part-time hours)", () => {
  const result = compute(T09_FIXTURE);
  const byGroup = groupsByName(result);
  const bep = byGroup.get("Bếp bánh")!;
  const kho = byGroup.get("Kho BN")!;
  assert.deepEqual(bep.actualWorkDays, rational(225, 2)); // 112,5
  assert.deepEqual(bep.workDays, rational(241, 2)); // 120,5
  assert.deepEqual(bep.partTimeHours, rational(41499, 100)); // 414,99
  assert.deepEqual(kho.actualWorkDays, rational(50));
  assert.deepEqual(kho.workDays, rational(54));
  assert.deepEqual(kho.partTimeHours, rational(56436, 100)); // 564,36
  assert.equal(Number(T09_GROUP_TOTALS.bepActualWorkDays), 112.5);
  assert.equal(Number(T09_GROUP_TOTALS.bepWorkDays), 120.5);
  assert.equal(Number(T09_GROUP_TOTALS.bepPartTimeHours), 414.99);
  assert.equal(Number(T09_GROUP_TOTALS.khoActualWorkDays), 50);
  assert.equal(Number(T09_GROUP_TOTALS.khoWorkDays), 54);
  assert.equal(Number(T09_GROUP_TOTALS.khoPartTimeHours), 564.36);
});

test("T09 adjustments carry reasons and change the expected rows", () => {
  const result = compute(T09_FIXTURE);
  const lines = employeesByName(result);

  // Vĩnh An: work_days 25 → 24,5 (R7) + allowance 500.000.
  const vinhAn = lines.get("Lưu Vĩnh An")!;
  assert.deepEqual(vinhAn.actualWorkDays, rational(49, 2));
  assert.deepEqual(vinhAn.holidayPayDays, rational(2));
  assert.deepEqual(vinhAn.workDays, rational(53, 2));
  assert.deepEqual(vinhAn.dayPay, rational(13_250_000));
  assert.deepEqual(vinhAn.allowance, rational(500_000));
  assert.ok(vinhAn.flags.includes("work_days_adjusted"));

  // Mai: exclude_holiday keeps NC TL at 22 even though 2 holidays are eligible.
  const mai = lines.get("Nguyễn Thị Xuân Mai")!;
  assert.deepEqual(mai.holidayPayDays, rational(0));
  assert.deepEqual(mai.workDays, rational(22));
  assert.ok(mai.flags.includes("holiday_excluded"));

  // Trang: exclude_holiday + exclude_overtime ("Chốt lương").
  const trang = lines.get("Nguyễn Lê Huyền Trang")!;
  assert.deepEqual(trang.holidayPayDays, rational(0));
  assert.deepEqual(trang.workDays, rational(9));
  assert.deepEqual(trang.overtimeHours, rational(28, 100));
  assert.deepEqual(trang.overtimeAppliedHours, rational(0));
  assert.deepEqual(trang.overtimePay, rational(0));
  assert.ok(trang.flags.includes("holiday_excluded"));
  assert.ok(trang.flags.includes("overtime_excluded"));

  // Audit trail: every T09 adjustment carries a non-empty reason.
  assert.equal(T09_FIXTURE.adjustments.length, 4);
  assert.equal(T09_FIXTURE.adjustments.every((item) => item.reason.trim().length > 0), true);
});

test("T09: Huy has 4,75h TC but no rate ⇒ 0; Yến stays an empty terminated row", () => {
  const result = compute(T09_FIXTURE);
  const lines = employeesByName(result);

  const huy = lines.get("Hà Tuấn Huy")!;
  assert.deepEqual(huy.overtimeHours, rational(19, 4)); // 4,75
  assert.deepEqual(huy.overtimePay, rational(0));

  const yen = lines.get("Lê Thị Kim Yến")!;
  assert.deepEqual(yen.workDays, rational(0));
  assert.deepEqual(yen.grossPay, rational(0));
  assert.equal(yen.netPayRounded, 0n);
  assert.ok(yen.flags.includes("terminated"));
});

test("T09: Saly (03/09) and Hồng (30/09) get no holiday pay (R9)", () => {
  const result = compute(T09_FIXTURE);
  const lines = employeesByName(result);
  const saly = lines.get("Saly")!;
  assert.deepEqual(saly.holidayPayDays, rational(0));
  assert.deepEqual(saly.workDays, rational(25));
  assert.ok(saly.flags.includes("holiday_before_start"));

  const hong = lines.get("Hồng")!;
  assert.deepEqual(hong.holidayPayDays, rational(0));
  assert.deepEqual(hong.workDays, rational(1));
  assert.ok(hong.flags.includes("holiday_before_start"));
});

test("T09: part-time rows are paid on the hourly column only (R4/R8)", () => {
  const result = compute(T09_FIXTURE);
  const lines = employeesByName(result);
  const long = lines.get("Lê Nguyễn Hoàng Long")!;
  assert.deepEqual(long.workDays, rational(0));
  assert.deepEqual(long.dayPay, rational(0));
  assert.deepEqual(long.partTimeHours, rational(20507, 100));
  assert.deepEqual(long.partTimePay, rational(6_152_100));

  const minh = lines.get("Trương Thị Yến Minh")!;
  assert.deepEqual(minh.partTimeHours, rational(0));
  assert.deepEqual(minh.partTimePay, rational(0));
});

// ---------------------------------------------------------------------------
// H1 / H2 / Q1 / Q3 attendance mode
// ---------------------------------------------------------------------------

const basePeriod: PayrollPeriod = {
  code: "T-ATT",
  name: "test attendance",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  standardDaysByGroup: { "Bếp bánh": 26 },
  defaultStandardDays: 26,
  holidays: [],
  rules: resolveRulesConfig(),
  status: "draft",
};

const baseEmployee: PayrollEmployee = {
  code: "E1",
  name: "Test",
  group: "Bếp bánh",
  employmentType: "official",
  monthlySalary: 7_800_000,
  overtimeRate: null,
  startDate: "2025-01-01",
};

function attendance(dates: string[], checkIn = "08:00:00", checkOut: string | null = "17:00:00"): AttendanceRow[] {
  return dates.map((date) => ({
    employeeCode: "E1",
    employeeName: "Test",
    date,
    checkIn,
    checkOut,
    department: null,
  }));
}

function run(overrides: {
  period?: Partial<PayrollPeriod>;
  employee?: Partial<PayrollEmployee>;
  rows?: AttendanceRow[];
  measures?: Record<string, PayrollEmployeeMeasures>;
  adjustments?: PayrollAdjustment[];
}) {
  const period: PayrollPeriod = { ...basePeriod, ...(overrides.period ?? {}) };
  const employee: PayrollEmployee = { ...baseEmployee, ...(overrides.employee ?? {}) };
  return computePayroll({
    period,
    employees: [employee],
    rows: overrides.rows ?? attendance(["2026-09-03", "2026-09-04", "2026-09-05"]),
    measures: overrides.measures,
    adjustments: overrides.adjustments ?? [],
  }).employees[0];
}

test("H1 counts one công per day with at least one check (shift V, missing out, holiday)", () => {
  const line = run({
    period: { holidays: ["2026-09-02"] },
    rows: [
      // Shift V crossing midnight: still exactly one công.
      { employeeCode: "E1", employeeName: "Test", date: "2026-09-01", checkIn: "22:00:00", checkOut: "06:00:00", department: null },
      // Missing check-out: the day still counts as one công for R1.
      { employeeCode: "E1", employeeName: "Test", date: "2026-09-03", checkIn: "08:00:00", checkOut: null, department: null },
      // Holiday attendance is not needed — R9 pays the holiday anyway.
      { employeeCode: "E1", employeeName: "Test", date: "2026-09-02", checkIn: null, checkOut: null, department: null },
    ],
  });
  assert.deepEqual(line.actualWorkDays, rational(2)); // 09-01 + 09-03
  assert.deepEqual(line.holidayPayDays, rational(1)); // 09-02 via R9
  assert.deepEqual(line.workDays, rational(3));
  assert.deepEqual(line.dayPay, rational(900_000)); // 7.800.000 × 3 / 26
});

test("R9 pays a holiday without any attendance on the holiday", () => {
  const line = run({
    period: { holidays: ["2026-09-02"] },
    rows: attendance(["2026-09-01", "2026-09-03"]),
  });
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(3));
});

test("all optional rules default to OFF", () => {
  const rules = resolveRulesConfig();
  assert.equal(rules.attendanceDays, true);
  assert.equal(rules.plusOneDay.enabled, false);
  assert.equal(rules.deductHour.enabled, false);
  assert.equal(rules.officialOvertime.enabled, false);
});

test("H1 can be switched off", () => {
  const line = run({ period: { rules: resolveRulesConfig({ attendanceDays: false }) } });
  assert.deepEqual(line.actualWorkDays, rational(0));
  assert.deepEqual(line.dayPay, rational(0));
});

test("Q1 (+1 công) is off by default and can be enabled", () => {
  const off = run({});
  assert.deepEqual(off.actualWorkDays, rational(3));
  const on = run({ period: { rules: resolveRulesConfig({ plusOneDay: { enabled: true, days: 1 } }) } });
  assert.deepEqual(on.actualWorkDays, rational(4));
  assert.deepEqual(on.dayPay, rational(1_200_000));
  assert.ok(on.flags.includes("plus_one_day"));
});

test("H2 deducts the break hour only on days at or above the threshold (part-time)", () => {
  const line = run({
    employee: { employmentType: "part_time", hourlyRate: 50_000, monthlySalary: null },
    rows: [
      ...attendance(["2026-09-01"], "08:00:00", "17:00:00"), // 9h ≥ 8h → 8h
      ...attendance(["2026-09-02"], "08:00:00", "14:00:00"), // 6h < 8h → 6h
    ],
    period: { rules: resolveRulesConfig({ deductHour: { enabled: true, thresholdHours: 8, deductHours: 1 } }) },
  });
  assert.deepEqual(line.partTimeHours, rational(14));
  assert.deepEqual(line.partTimePay, rational(700_000));
});

test("H1 ignores day-off rows without any time (the export has a row for every day)", () => {
  const line = run({
    rows: [
      ...attendance(["2026-09-03", "2026-09-04"]),
      ...attendance(["2026-09-05", "2026-09-06"], "", null).map((row) => ({ ...row, checkIn: null, checkOut: null })),
    ],
  });
  assert.deepEqual(line.actualWorkDays, rational(2));
});

test("R3 makes overtime worth 0 without a rate; attendance overtime is reconcile-only (Q3)", () => {
  const noRate = run({ rows: attendance(["2026-09-01"], "08:00:00", "18:00:00") });
  assert.deepEqual(noRate.overtimeHours, rational(2));
  assert.deepEqual(noRate.overtimePay, rational(0));
  assert.deepEqual(noRate.overtimeAppliedHours, rational(0));
  assert.deepEqual(noRate.overtimePayReconciled, rational(0));

  // Attendance overtime is not paid by default even with a rate.
  const reconcile = run({
    employee: { overtimeRate: 60_000 },
    rows: attendance(["2026-09-01"], "08:00:00", "18:00:00"),
  });
  assert.deepEqual(reconcile.overtimeAppliedHours, rational(0));
  assert.deepEqual(reconcile.grossPay, rational(300_000));
  assert.ok(reconcile.flags.includes("overtime_reconcile_only"));
});

test("Q3 only pays attendance overtime when enabled in apply mode", () => {
  const applied = run({
    period: { rules: resolveRulesConfig({ officialOvertime: { enabled: true, mode: "apply" } }) },
    employee: { overtimeRate: 60_000 },
    rows: attendance(["2026-09-01"], "08:00:00", "18:00:00"),
  });
  assert.deepEqual(applied.overtimeAppliedHours, rational(2));
  assert.deepEqual(applied.grossPay, rational(420_000));
  assert.deepEqual(applied.overtimePayReconciled, rational(0));
});

test("manual overtime on the payroll sheet is paid (R3) and adjustable off", () => {
  const paid = run({
    employee: { overtimeRate: 60_000 },
    measures: { E1: { actualWorkDays: { value: 1, source: "manual" }, overtimeHours: { value: 2, source: "manual" } } },
    rows: [],
  });
  assert.deepEqual(paid.overtimePay, rational(120_000));
  assert.deepEqual(paid.grossPay, rational(420_000));

  const excluded = run({
    employee: { overtimeRate: 60_000 },
    measures: { E1: { actualWorkDays: { value: 1, source: "manual" }, overtimeHours: { value: 2, source: "manual" } } },
    rows: [],
    adjustments: [
      { employeeCode: "E1", field: "exclude_overtime", value: null, reason: "không tính TC", actor: "owner", at: "2026-09-30T00:00:00+07:00" },
    ],
  });
  assert.deepEqual(excluded.overtimeAppliedHours, rational(0));
  assert.deepEqual(excluded.grossPay, rational(300_000));
  assert.ok(excluded.flags.includes("overtime_excluded"));
});

test("R5 rounds net pay to 1.000 đồng only at the final step", () => {
  const line = run({
    adjustments: [
      { employeeCode: "E1", field: "net_pay", value: 1500, reason: "làm tròn", actor: "owner", at: "2026-09-30T00:00:00+07:00" },
    ],
  });
  assert.deepEqual(line.netPay, rational(1500));
  assert.equal(line.netPayRounded, 2000n);
});

test("R9 uses start_date, not holiday attendance", () => {
  const hiredBefore = run({
    period: { holidays: ["2026-09-02"] },
    rows: [],
    measures: { E1: { actualWorkDays: { value: 26, source: "manual" } } },
  });
  assert.deepEqual(hiredBefore.holidayPayDays, rational(1));
  assert.deepEqual(hiredBefore.workDays, rational(27));

  const hiredAfter = run({
    period: { holidays: ["2026-09-02"] },
    employee: { startDate: "2026-09-03" },
    rows: [],
    measures: { E1: { actualWorkDays: { value: 10, source: "manual" } } },
  });
  assert.deepEqual(hiredAfter.holidayPayDays, rational(0));
  assert.deepEqual(hiredAfter.workDays, rational(10));
  assert.ok(hiredAfter.flags.includes("holiday_before_start"));
});

test("T08/T09 totals match the spec (120.558.000 / 96.681.000)", () => {
  const t08 = compute(T08_FIXTURE);
  const t09 = compute(T09_FIXTURE);
  assert.equal(money(t08.total.netPayRounded), "120558000");
  assert.equal(groupInt(t08.total.netPayRounded), "120.558.000");
  assert.equal(money(t09.total.netPayRounded), "96681000");
  assert.equal(groupInt(t09.total.netPayRounded), "96.681.000");
  // T08 trước làm tròn: Bếp 71.632.074,07 | Kho 30.286.511,48 | tổng 120.558.585,56
  const byGroup = groupsByName(t08);
  assert.equal(decimal2(byGroup.get("Bếp bánh")!.grossPay), "71632074.07");
  assert.equal(decimal2(byGroup.get("Kho BN")!.grossPay), "30286511.48");
  assert.equal(decimal2(t08.total.grossPay), "120558585.56");
});

test("changing the rules of one period never changes another period (isolation)", () => {
  const t08Before = compute(T08_FIXTURE);
  const t09Before = compute(T09_FIXTURE);

  const t09Changed = computePayroll({
    period: {
      ...T09_FIXTURE.period,
      rules: resolveRulesConfig({ holidayPaid: false }),
    },
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  const t08After = compute(T08_FIXTURE);

  assert.deepEqual(t08After.total, t08Before.total);
  assert.notDeepEqual(t09Changed.total.workDays, t09Before.total.workDays);
  assert.notDeepEqual(t09Changed.total.grossPay, t09Before.total.grossPay);
  // computePayroll must not mutate the caller's period.
  assert.deepEqual(T09_FIXTURE.period.rules.holidayPaid, true);
});

test("standard days per group drive R1 (Văn phòng 22 vs Bếp/Kho 27)", () => {
  const salary = 13_200_000;
  const office = run({
    employee: { group: "Văn phòng", monthlySalary: salary },
    period: { standardDaysByGroup: { "Văn phòng": 22 } },
    rows: [],
    measures: { E1: { actualWorkDays: { value: 22, source: "manual" } } },
  });
  assert.deepEqual(office.dayPay, rational(13_200_000));

  const kitchen = run({
    employee: { group: "Bếp bánh", monthlySalary: salary },
    period: { standardDaysByGroup: { "Bếp bánh": 27 } },
    rows: [],
    measures: { E1: { actualWorkDays: { value: 27, source: "manual" } } },
  });
  assert.deepEqual(kitchen.dayPay, rational(13_200_000));
});

test("the rational from a number avoids floating point drift for half days", () => {
  assert.deepEqual(rationalFromNumber(24.5), rational(49, 2));
  assert.deepEqual(rationalFromNumber(138.33), rational(13833, 100));
});

test("R7: office staff without attendance default to the standard days, without holidays", () => {
  const line = run({
    employee: { group: "Văn phòng", monthlySalary: 9_600_000 },
    period: { standardDaysByGroup: { "Văn phòng": 22 }, holidays: ["2026-09-01", "2026-09-02"] },
    rows: [],
  });
  assert.deepEqual(line.actualWorkDays, rational(22));
  assert.deepEqual(line.holidayPayDays, rational(0));
  assert.deepEqual(line.workDays, rational(22));
  assert.deepEqual(line.dayPay, rational(9_600_000));
  assert.ok(line.flags.includes("office_default_days"));
});
