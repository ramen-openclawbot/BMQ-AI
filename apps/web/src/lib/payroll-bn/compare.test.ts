import assert from "node:assert/strict";
import test from "node:test";

import { comparePayroll } from "./compare.ts";
import type { PayrollGroup, PayrollResult } from "./types.ts";

interface EmployeePay {
  code: string;
  group: PayrollGroup;
  net: bigint;
}

/**
 * Minimal result carrying exactly what comparePayroll reads: employee lines,
 * group lines and the total. Other engine fields are irrelevant here.
 */
function payroll(periodCode: string, employees: EmployeePay[]): PayrollResult {
  const employeeLines = employees.map((employee) => ({
    kind: "employee" as const,
    employeeCode: employee.code,
    employeeName: `NV ${employee.code}`,
    group: employee.group,
    employmentType: "official" as const,
    netPayRounded: employee.net,
    shortShiftDays: [],
  }));

  const groupTotals = new Map<PayrollGroup, bigint>();
  for (const employee of employees) {
    groupTotals.set(employee.group, (groupTotals.get(employee.group) ?? 0n) + employee.net);
  }
  const groupLines = [...groupTotals].map(([group, netPayRounded]) => ({
    kind: "group" as const,
    group,
    netPayRounded,
  }));

  const totalNet = employees.reduce((sum, employee) => sum + employee.net, 0n);
  const total = { kind: "total" as const, netPayRounded: totalNet };

  return {
    periodCode,
    lines: [...employeeLines, ...groupLines, total] as unknown as PayrollResult["lines"],
    employees: employeeLines as unknown as PayrollResult["employees"],
    groups: groupLines as unknown as PayrollResult["groups"],
    total: total as unknown as PayrollResult["total"],
    warnings: [],
  };
}

test("tính đúng phần trăm tăng, giảm và không đổi", () => {
  const previous = payroll("T08.2026", [
    { code: "E1", group: "Bếp bánh", net: 10_000_000n },
    { code: "E2", group: "Bếp bánh", net: 4_000_000n },
    { code: "E3", group: "Văn phòng", net: 3_000_000n },
  ]);
  const current = payroll("T09.2026", [
    { code: "E1", group: "Bếp bánh", net: 12_000_000n },
    { code: "E2", group: "Bếp bánh", net: 3_600_000n },
    { code: "E3", group: "Văn phòng", net: 3_000_000n },
  ]);

  const comparison = comparePayroll(current, previous);

  assert.equal(comparison.byEmployee.get("E1"), 20);
  assert.equal(comparison.byEmployee.get("E2"), -10);
  assert.equal(comparison.byEmployee.get("E3"), 0);
});

test("tính phần trăm theo nhóm và tổng cộng", () => {
  const previous = payroll("T08.2026", [
    { code: "E1", group: "Bếp bánh", net: 10_000_000n },
    { code: "E2", group: "Bếp bánh", net: 4_000_000n },
    { code: "E3", group: "Văn phòng", net: 3_000_000n },
  ]);
  const current = payroll("T09.2026", [
    { code: "E1", group: "Bếp bánh", net: 12_000_000n },
    { code: "E2", group: "Bếp bánh", net: 3_600_000n },
    { code: "E3", group: "Văn phòng", net: 3_000_000n },
  ]);

  const comparison = comparePayroll(current, previous);

  // Bếp bánh: (15.600.000 - 14.000.000) / 14.000.000 = 11,428…% → 11,4.
  assert.equal(comparison.byGroup.get("Bếp bánh"), 11.4);
  assert.equal(comparison.byGroup.get("Văn phòng"), 0);
  // Tổng: (18.600.000 - 17.000.000) / 17.000.000 = 9,411…% → 9,4.
  assert.equal(comparison.total, 9.4);
});

test("trả null cho nhân viên mới, kỳ trước bằng 0 và khi không có kỳ trước", () => {
  const previous = payroll("T08.2026", [
    { code: "E1", group: "Bếp bánh", net: 0n },
  ]);
  const current = payroll("T09.2026", [
    { code: "E1", group: "Bếp bánh", net: 5_000_000n },
    { code: "E2", group: "Bếp bánh", net: 5_000_000n },
  ]);

  const withZero = comparePayroll(current, previous);
  assert.equal(withZero.byEmployee.get("E1"), null);
  assert.equal(withZero.byEmployee.get("E2"), null);
  assert.equal(withZero.byGroup.get("Bếp bánh"), null);
  assert.equal(withZero.total, null);

  const withoutPrevious = comparePayroll(current, null);
  assert.deepEqual([...withoutPrevious.byEmployee], [
    ["E1", null],
    ["E2", null],
  ]);
  assert.deepEqual([...withoutPrevious.byGroup], [["Bếp bánh", null]]);
  assert.equal(withoutPrevious.total, null);
});

test("làm tròn 1 chữ số thập phân và giữ chính xác với bigint lớn", () => {
  // 0,05% — đúng nửa bước 0,1 nên làm tròn lên thành 0,1.
  const tinyPrevious = payroll("T08.2026", [{ code: "E1", group: "Kho BN", net: 2_000_000n }]);
  const tinyCurrent = payroll("T09.2026", [{ code: "E1", group: "Kho BN", net: 2_001_000n }]);
  assert.equal(comparePayroll(tinyCurrent, tinyPrevious).byEmployee.get("E1"), 0.1);

  // 2^53 + 1: vượt giới hạn số nguyên an toàn của Number, nhưng 25% là chính xác.
  const bigPrevious = payroll("T08.2026", [
    { code: "E1", group: "Kho BN", net: 9_007_199_254_740_993n },
  ]);
  const bigCurrent = payroll("T09.2026", [
    { code: "E1", group: "Kho BN", net: 11_258_999_068_426_241n },
  ]);
  assert.equal(comparePayroll(bigCurrent, bigPrevious).byEmployee.get("E1"), 25);
});
