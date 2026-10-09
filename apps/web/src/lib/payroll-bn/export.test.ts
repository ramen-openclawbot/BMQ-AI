import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { computePayroll } from "./engine.ts";
import { buildPayrollExportRows, buildPayrollWorkbook, payrollExportFileName, PAYROLL_EXPORT_HEADER } from "./export.ts";
import { T09_FIXTURE } from "./payroll-bn-t09.fixture.ts";

function exportT09() {
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  const notes = new Map<string, string[]>();
  for (const item of T09_FIXTURE.adjustments) notes.set(item.employeeCode, [...(notes.get(item.employeeCode) ?? []), item.reason]);
  return buildPayrollExportRows(T09_FIXTURE.period, result, notes);
}

test("export rows follow the draft table: 20 employees, 3 group lines, 1 total", () => {
  const rows = exportT09();
  const header = rows.findIndex((row) => row[0] === PAYROLL_EXPORT_HEADER[0]);
  const body = rows.slice(header + 1);
  assert.equal(body.length, 20 + 3 + 1);
  assert.deepEqual(body.filter((row) => String(row[1]).startsWith("Nhóm ")).map((row) => row[1]), [
    "Nhóm Văn phòng",
    "Nhóm Bếp bánh",
    "Nhóm Kho BN",
  ]);
  const total = body.at(-1)!;
  assert.equal(total[1], "Tổng cộng");
  assert.equal(total[14], 96_681_000);
  assert.equal(total[13], 96_680_374.62);
  assert.equal(total[12], 0); // Thưởng nhiệm vụ
  assert.equal(PAYROLL_EXPORT_HEADER[12], "Thưởng nhiệm vụ");
});

test("export keeps exact per-employee values and notes", () => {
  const rows = exportT09();
  const huy = rows.find((row) => row[1] === "Hà Tuấn Huy")!;
  assert.equal(huy[6], 11); // NC tính lương
  assert.equal(huy[9], 7_192_307.69); // lương ngày công
  assert.equal(huy[10], 0); // no overtime rate
  assert.equal(huy[14], 7_192_000);
  const trang = rows.find((row) => row[1] === "Nguyễn Lê Huyền Trang")!;
  assert.match(String(trang[15]), /Chốt lương/);
  const long = rows.find((row) => row[1] === "Lê Nguyễn Hoàng Long")!;
  assert.equal(long[3], ""); // part-time has no standard days
  assert.equal(long[9], 6_152_100);
});

test("workbook round-trips through xlsx with the status in the title", () => {
  const rows = exportT09();
  const bytes = buildPayrollWorkbook(rows);
  const sheet = XLSX.read(bytes, { type: "array" }).Sheets["Bang luong"];
  const back = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });
  assert.match(String(back[1][0]), /Nháp, chưa chốt/);
  assert.equal(back.at(-1)![14], 96_681_000);
  assert.equal(payrollExportFileName(T09_FIXTURE.period), "bang-luong-bep-bn-T09.2026-nhap.xlsx");
});
