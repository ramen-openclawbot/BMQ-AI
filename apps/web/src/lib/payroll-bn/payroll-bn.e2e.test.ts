// End-to-end checks against the real Bếp BN source workbooks.
//
// The original attendance/payroll files are intentionally NOT stored in the
// repository, so this test only runs when the operator points
// `BMQ_PAYROLL_SOURCE_DIR` at the folder holding them. Without the variable the
// whole file is skipped and the rest of the suite stays self-contained.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseAttendanceFile } from "./attendance-parser.ts";

const SOURCE_DIR = process.env.BMQ_PAYROLL_SOURCE_DIR;

const OUTPUT_DIR = resolve(process.cwd(), "..", "..", "output", "payroll-bn-reconcile");

interface RealCase {
  key: string;
  token: RegExp;
  period: { dateFrom: string; dateTo: string };
  expectedRows: number;
  expectedEmployees: number;
}

const CASES: RealCase[] = [
  {
    key: "T08",
    token: /t[\s._-]*0?8(?!\d)/i,
    period: { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
    expectedRows: 496,
    expectedEmployees: 16,
  },
  {
    key: "T09",
    token: /t[\s._-]*0?9(?!\d)/i,
    period: { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
    expectedRows: 450,
    expectedEmployees: 15,
  },
];

function findWorkbook(dir: string, token: RegExp): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(xls|xlsx)$/i.test(entry.name)) continue;
    if (!token.test(entry.name)) continue;
    return join(dir, entry.name);
  }
  return null;
}

test(
  "real Bếp BN workbooks parse with the expected row and employee counts",
  { skip: !SOURCE_DIR },
  async (t) => {
    const dir = SOURCE_DIR!;
    if (!existsSync(dir)) {
      t.skip(`BMQ_PAYROLL_SOURCE_DIR does not exist: ${dir}`);
      return;
    }

    mkdirSync(OUTPUT_DIR, { recursive: true });

    for (const realCase of CASES) {
      const workbook = findWorkbook(dir, realCase.token);
      if (!workbook) {
        t.diagnostic(`Không tìm thấy file ${realCase.key} trong ${dir} — bỏ qua case này.`);
        continue;
      }

      const bytes = new Uint8Array(readFileSync(workbook));
      const parsed = await parseAttendanceFile(bytes, realCase.period);
      const codes = new Set(parsed.rows.map((row) => row.employeeCode));

      assert.equal(parsed.rows.length, realCase.expectedRows, `${realCase.key}: số dòng`);
      assert.equal(codes.size, realCase.expectedEmployees, `${realCase.key}: số mã nhân viên`);

      // Reporting-only summary; it deliberately contains no money.
      const summary = {
        key: realCase.key,
        workbook: workbook.split(/[\\/]/).pop(),
        sha256: parsed.sha256,
        sheetName: parsed.sheetName,
        rowCount: parsed.rows.length,
        employeeCount: codes.size,
        ignoredHeaders: parsed.ignoredHeaders,
        rowsByEmployee: Object.fromEntries(
          [...codes].sort().map((code) => [
            code,
            parsed.rows.filter((row) => row.employeeCode === code).length,
          ]),
        ),
      };
      writeFileSync(
        join(OUTPUT_DIR, `${realCase.key}-parse.json`),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );
    }
  },
);
