import assert from "node:assert/strict";
import test from "node:test";

import { employeeState, fixedMonthlyPay, summarizeCatalog } from "./catalog-summary.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { PayrollEmployee, PayrollPeriod } from "./types.ts";

const PERIOD: PayrollPeriod = {
  code: "T11.2026",
  name: "Kỳ lương tháng 11/2026",
  dateFrom: "2026-11-01",
  dateTo: "2026-11-30",
  standardDaysByGroup: {},
  defaultStandardDays: 26,
  holidays: [],
  rules: resolveRulesConfig(),
  status: "draft",
};

const official: PayrollEmployee = {
  code: "O1", name: "Chính thức", group: "Kho BN", employmentType: "official", monthlySalary: 5_000_000, allowance: 300_000,
};
const partTime: PayrollEmployee = {
  code: "P1", name: "Part-time", group: "Kho BN", employmentType: "part_time", hourlyRate: 23_000,
};
const driverNext: PayrollEmployee = {
  code: "G1", name: "Giao sau", group: "Giao hàng", employmentType: "delivery", monthlySalary: 2_000_000, deliveryUnitBase: 2_000_000, startDate: "2026-12-01",
};
const driverNow: PayrollEmployee = {
  code: "G2", name: "Giao nay", group: "Giao hàng", employmentType: "delivery", monthlySalary: 2_000_000, deliveryUnitBase: 1_000_000,
};
const left: PayrollEmployee = {
  code: "L1", name: "Đã nghỉ", group: "Bếp bánh", employmentType: "official", monthlySalary: 6_000_000, terminated: true,
};

test("employee state follows start, end and termination", () => {
  assert.equal(employeeState(official, PERIOD), "active");
  assert.equal(employeeState(driverNext, PERIOD), "upcoming");
  assert.equal(employeeState(left, PERIOD), "left");
  assert.equal(employeeState({ ...official, endDate: "2026-10-31" }, PERIOD), "left");
});

test("fixed monthly pay by employment type", () => {
  assert.equal(fixedMonthlyPay(official), 5_300_000);
  assert.equal(fixedMonthlyPay(partTime), 0);
  assert.equal(fixedMonthlyPay(driverNow), 3_000_000);
});

test("fund = fixed pay of active staff + part-time hours worked so far", () => {
  const summary = summarizeCatalog({
    period: PERIOD,
    employees: [official, partTime, driverNext, driverNow, left],
    measures: { P1: { partTimeHours: { value: 10, source: "manual" } } },
  });
  assert.equal(summary.estimateAvailable, true);
  assert.equal(summary.activeCount, 3);
  assert.equal(summary.upcomingCount, 1);
  assert.equal(summary.partTimeCount, 1);
  assert.equal(summary.fixed, 5_300_000 + 3_000_000);
  assert.equal(summary.partTimeEstimate, 230_000);
  assert.equal(summary.fund, 8_530_000);

  const kho = summary.groups.find((group) => group.group === "Kho BN");
  assert.equal(kho?.activeCount, 2);
  assert.equal(kho?.fund, 5_530_000);
  const giao = summary.groups.find((group) => group.group === "Giao hàng");
  assert.equal(giao?.activeCount, 1);
  assert.equal(giao?.upcomingCount, 1);
  assert.equal(giao?.fund, 3_000_000);
  const bep = summary.groups.find((group) => group.group === "Bếp bánh");
  assert.equal(bep?.leftCount, 1);
  assert.equal(bep?.fund, 0);
  assert.deepEqual(summary.groups.map((group) => group.group), ["Văn phòng", "Bếp bánh", "Kho BN", "Giao hàng"]);
});
