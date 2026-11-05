import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayrollNotes } from "./notes.ts";
import { buildPayrollPdf, formatPdfCell } from "./export-pdf.ts";
import { T09_FIXTURE } from "./payroll-bn-t09.fixture.ts";
import type { IssueReview } from "./issue-review.ts";
import type { AdjustmentField } from "./types.ts";

const ADJUSTMENT_LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

function exportRows(): (string | number)[][] {
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  const notes = new Map<string, string[]>();
  for (const item of T09_FIXTURE.adjustments) {
    notes.set(item.employeeCode, [...(notes.get(item.employeeCode) ?? []), item.reason]);
  }
  return buildPayrollExportRows(T09_FIXTURE.period, result, notes);
}

test("formatPdfCell formats numbers in vi-VN and leaves text untouched", () => {
  assert.equal(formatPdfCell(1_234_567), "1.234.567");
  assert.equal(formatPdfCell(1_234_567.5), "1.234.567,5");
  assert.equal(formatPdfCell(0), "0");
  assert.equal(formatPdfCell("Nguyễn Lê Huyền Trang"), "Nguyễn Lê Huyền Trang");
  assert.equal(formatPdfCell(""), "");
});

test("buildPayrollPdf returns a non-empty PDF blob starting with %PDF", async () => {
  const originalFetch = globalThis.fetch;
  // Font fetch is stubbed out: buildPayrollPdf must still produce a valid PDF.
  globalThis.fetch = (async () => {
    throw new Error("offline test");
  }) as unknown as typeof fetch;

  try {
    const blob = await buildPayrollPdf(exportRows());

    assert.equal(blob.type, "application/pdf");
    assert.ok(blob.size > 0, "the PDF blob must not be empty");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "%PDF");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildPayrollPdf handles a long missing check-out note", async () => {
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  const workDates = [
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
    "2026-09-06",
    "2026-09-07",
    "2026-09-30",
    "2026-10-01",
  ];
  const reviews: IssueReview[] = workDates.map((workDate) => ({
    employeeCode: "BN03",
    workDate,
    issueCode: "missing_check_out",
    decision: "excluded",
    note: "Đã đối chiếu với quản lý",
  }));
  const notes = buildPayrollNotes(result.employees, T09_FIXTURE.adjustments, ADJUSTMENT_LABELS, reviews);
  const rows = buildPayrollExportRows(T09_FIXTURE.period, result, notes);
  const employee = rows.find((row) => row[0] === "BN03")!;
  const longNote =
    "Ngày công không được tính do không chấm công giờ ra: 03/09, 04/09, 05/09, 06/09, 07/09, 30/09, 01/10. " +
    "Vui lòng liên hệ cấp quản lý để giải trình. Nếu được duyệt, ngày lương sẽ được chuyển bù vào tháng sau.";
  assert.ok(String(employee[15]).endsWith(longNote));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline test");
  }) as unknown as typeof fetch;

  try {
    const blob = await buildPayrollPdf(rows);

    assert.equal(blob.type, "application/pdf");
    assert.ok(blob.size > 0, "the PDF blob must not be empty");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "%PDF");
    assert.ok(bytes.length > 1000, "the PDF must contain rendered data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
