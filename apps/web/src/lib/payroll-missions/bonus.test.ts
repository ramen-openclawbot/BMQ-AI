// Mission bonus ledger tests (node:test).
//
// THUONG_FIXTURE = 100.000 đồng is a FIXTURE value, not a real reward level.

import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "../payroll-bn/engine.ts";
import { rational } from "../payroll-bn/money.ts";
import { T09_FIXTURE } from "../payroll-bn/payroll-bn-t09.fixture.ts";
import { computeMissionBonus } from "./bonus.ts";
import { assertMissionPeriodOpen } from "./lifecycle.ts";
import { buildMissionTemplate } from "./templates.ts";

const THUONG_FIXTURE = 100_000;

test("Long 6.152.100 + 100.000 cùng kỳ → 6.252.100, thực nhận 6.252.000", () => {
  const employees = T09_FIXTURE.employees.map((employee) =>
    employee.code === "BN08" ? { ...employee, missionBonus: THUONG_FIXTURE } : employee,
  );
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  const long = result.employees.find((line) => line.employeeCode === "BN08");
  assert.ok(long);
  assert.deepEqual(long!.partTimePay, rational(6_152_100));
  assert.deepEqual(long!.missionBonus, rational(THUONG_FIXTURE));
  assert.deepEqual(long!.grossPay, rational(6_252_100));
  assert.equal(long!.netPayRounded, 6_252_000n);
});

test("chạy hai lần → một khoản (dedupe theo mission_id)", () => {
  const entries = [
    {
      missionId: "mission-1",
      employeeCode: "BN08",
      missionCode: "T-DUNGGIO" as const,
      status: "achieved" as const,
      mode: "pay" as const,
      rewardVnd: THUONG_FIXTURE,
    },
  ];
  const first = computeMissionBonus({ entries, budgetVnd: 1_000_000 });
  const second = computeMissionBonus({ entries, budgetVnd: 1_000_000 });
  assert.deepEqual(first, second);
  assert.equal(first.totalVnd, THUONG_FIXTURE);
  assert.equal(first.lines.length, 1);

  const duplicated = computeMissionBonus({ entries: [...entries, ...entries], budgetVnd: 1_000_000 });
  assert.equal(duplicated.lines.length, 1);
  assert.equal(duplicated.totalVnd, THUONG_FIXTURE);
});

test("kỳ đã chốt → lỗi; template chưa cấu hình thưởng → không cộng tiền", () => {
  assert.throws(() => assertMissionPeriodOpen("locked"), /đã chốt/);
  assertMissionPeriodOpen("draft");

  const template = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 0 } });
  assert.equal(template.rewardVnd, null);

  const noReward = computeMissionBonus({
    entries: [
      {
        employeeCode: "BN08",
        missionCode: "T-DUNGGIO",
        status: "achieved",
        mode: "pay",
        rewardVnd: template.rewardVnd,
      },
    ],
    budgetVnd: 1_000_000,
  });
  assert.equal(noReward.totalVnd, 0);
  assert.deepEqual(noReward.lines, []);
});

test("reconcile_only không bao giờ cộng tiền, kể cả khi đạt", () => {
  const result = computeMissionBonus({
    entries: [
      {
        employeeCode: "BN08",
        missionCode: "T-GIOPT",
        status: "achieved",
        mode: "reconcile_only",
        rewardVnd: THUONG_FIXTURE,
      },
    ],
    budgetVnd: 1_000_000,
  });
  assert.equal(result.totalVnd, 0);
  assert.deepEqual(result.lines, []);
});

test("trần null (chưa cấu hình) → không cộng tiền", () => {
  const result = computeMissionBonus({
    entries: [
      {
        employeeCode: "BN08",
        missionCode: "T-DUNGGIO",
        status: "achieved",
        mode: "pay",
        rewardVnd: THUONG_FIXTURE,
      },
    ],
    budgetVnd: null,
  });
  assert.equal(result.totalVnd, 0);
  assert.deepEqual(result.lines, []);
});
