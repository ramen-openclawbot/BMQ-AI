import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayrollPdf, formatPdfCell } from "./export-pdf.ts";
import { T09_FIXTURE } from "./payroll-bn-t09.fixture.ts";

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
