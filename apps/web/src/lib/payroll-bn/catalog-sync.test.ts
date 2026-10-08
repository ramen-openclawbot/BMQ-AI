import assert from "node:assert/strict";
import test from "node:test";

import { suggestCatalogSync } from "./catalog-sync.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { AttendanceRow, PayrollEmployee, PayrollPeriod } from "./types.ts";

const period: PayrollPeriod = {
  code: "T09.2026",
  name: "Kỳ lương tháng 09/2026 — Bếp BN",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  standardDaysByGroup: { "Văn phòng": 22, "Bếp bánh": 26, "Kho BN": 26 },
  defaultStandardDays: 26,
  holidays: [],
  rules: resolveRulesConfig(),
  status: "draft",
};

function row(overrides: Partial<AttendanceRow> & { employeeCode: string; date: string }): AttendanceRow {
  return {
    employeeName: `NV ${overrides.employeeCode}`,
    checkIn: "08:00:00",
    checkOut: "17:00:00",
    department: null,
    ...overrides,
  };
}

function employee(overrides: Partial<PayrollEmployee> & { code: string }): PayrollEmployee {
  return {
    name: `NV ${overrides.code}`,
    group: "Bếp bánh",
    employmentType: "official",
    ...overrides,
  };
}

test("suggests attendance-file additions with name, department, start date and day count", () => {
  const rows: AttendanceRow[] = [
    row({ employeeCode: "00003", date: "2026-09-05", employeeName: "", department: "Kho BN" }),
    row({ employeeCode: "00003", date: "2026-09-03", employeeName: "  Hùng Kim Ngọc  ", department: "Kho BN" }),
    // no machine data on 09-04 must not add an attendance day
    row({ employeeCode: "00003", date: "2026-09-04", checkIn: null, checkOut: null }),
    row({ employeeCode: "00001", date: "2026-09-02", employeeName: "Lê Thị Kim Yến", department: "Văn phòng" }),
  ];

  const { add, maybeLeft } = suggestCatalogSync({ period, rows, employees: [], previousEmployees: [] });

  assert.deepEqual(maybeLeft, []);
  assert.deepEqual(
    add.map((item) => [item.code, item.source, item.attendanceDays, item.missing]),
    [
      ["00001", "attendance_file", 1, ["salary"]],
      ["00003", "attendance_file", 2, ["salary"]],
    ],
  );
  const [yen, ngoc] = add;
  assert.equal(yen.employee.name, "Lê Thị Kim Yến");
  assert.equal(yen.employee.group, "Văn phòng");
  assert.equal(yen.employee.employmentType, "official");
  assert.equal(yen.employee.startDate, "2026-09-02");
  assert.equal(yen.employee.endDate, null);

  assert.equal(ngoc.employee.name, "Hùng Kim Ngọc");
  assert.equal(ngoc.employee.group, "Kho BN");
  assert.equal(ngoc.employee.startDate, "2026-09-03");
});

test("falls back to Bếp bánh and flags a missing group when the department is unknown", () => {
  const rows = [row({ employeeCode: "00009", date: "2026-09-01", department: "Nhà bếp" })];
  const { add } = suggestCatalogSync({ period, rows, employees: [], previousEmployees: [] });

  assert.equal(add.length, 1);
  assert.equal(add[0].employee.group, "Bếp bánh");
  assert.deepEqual(add[0].missing, ["group", "salary"]);
});

test("reuses the previous period row (dropping end date) when the code was known", () => {
  const previous: PayrollEmployee = {
    code: "00020",
    name: "Saly",
    group: "Bếp bánh",
    employmentType: "official",
    monthlySalary: 6_500_000,
    hourlyRate: null,
    overtimeRate: 30_000,
    allowance: 200_000,
    startDate: "2026-09-03",
    endDate: "2026-09-30",
  };
  const rows = [row({ employeeCode: "00020", date: "2026-09-03", employeeName: "Tên khác" })];

  const { add } = suggestCatalogSync({ period, rows, employees: [], previousEmployees: [previous] });

  assert.equal(add.length, 1);
  assert.equal(add[0].source, "previous_period");
  assert.deepEqual(add[0].missing, []);
  assert.equal(add[0].employee.name, "Saly");
  assert.equal(add[0].employee.group, "Bếp bánh");
  assert.equal(add[0].employee.employmentType, "official");
  assert.equal(add[0].employee.monthlySalary, 6_500_000);
  assert.equal(add[0].employee.overtimeRate, 30_000);
  assert.equal(add[0].employee.allowance, 200_000);
  assert.equal(add[0].employee.startDate, "2026-09-03");
  assert.equal(add[0].employee.endDate, null);
});

test("flags missing salary/hourly rate for the built-in catalogue rows", () => {
  const rows = [row({ employeeCode: "00030", date: "2026-09-01", department: "Bếp bánh" })];
  const partTime: PayrollEmployee = {
    code: "00031",
    name: "Part-time",
    group: "Bếp bánh",
    employmentType: "part_time",
    hourlyRate: null,
  };
  const { add } = suggestCatalogSync({
    period,
    rows: [...rows, row({ employeeCode: "00031", date: "2026-09-02" })],
    employees: [],
    previousEmployees: [partTime],
  });

  const official = add.find((item) => item.code === "00030")!;
  assert.deepEqual(official.missing, ["salary"]);
  const part = add.find((item) => item.code === "00031")!;
  assert.deepEqual(part.missing, ["hourly_rate"]);
});

test("no attendance rows means both suggestion lists are empty", () => {
  const result = suggestCatalogSync({
    period,
    rows: [],
    employees: [employee({ code: "00001" })],
    previousEmployees: [employee({ code: "00002" })],
  });

  assert.deepEqual(result, { add: [], maybeLeft: [] });
});

test("duplicate codes in the file produce a single suggestion", () => {
  const rows = [
    row({ employeeCode: "00005", date: "2026-09-01" }),
    row({ employeeCode: "00005", date: "2026-09-02" }),
  ];
  const { add } = suggestCatalogSync({ period, rows, employees: [], previousEmployees: [] });

  assert.equal(add.length, 1);
  assert.equal(add[0].code, "00005");
  assert.equal(add[0].attendanceDays, 2);
});

test("lists active employees without attendance as maybeLeft, never as a deletion", () => {
  const rows = [row({ employeeCode: "00001", date: "2026-09-01" })];
  const employees: PayrollEmployee[] = [
    employee({ code: "00001" }),
    employee({ code: "00002" }),
    employee({ code: "00003", terminated: true }),
    employee({ code: "00004", endDate: "2026-08-31" }),
    employee({ code: "00005", endDate: "2026-09-15" }),
  ];

  const { maybeLeft } = suggestCatalogSync({ period, rows, employees, previousEmployees: [] });

  assert.deepEqual(
    maybeLeft.map((item) => item.code),
    ["00002"],
  );
  assert.equal(maybeLeft[0].employee.endDate, "2026-08-31");
  assert.equal(maybeLeft[0].employee.terminated, undefined);
  assert.equal(maybeLeft[0].attendanceDays, 0);
  assert.equal(maybeLeft[0].missing.length, 0);
});
