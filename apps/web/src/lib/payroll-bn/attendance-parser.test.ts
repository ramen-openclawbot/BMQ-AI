import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";

import {
  AttendanceParseError,
  computeFileSha256,
  normalizeDateCell,
  normalizeTimeCell,
  parseAttendanceFile,
  parseAttendanceWorkbook,
} from "./attendance-parser.ts";
import {
  MISSIONS_T09_PERIOD,
  MISSIONS_T09_ROWS,
} from "../payroll-missions/missions-t09.fixture.ts";

const PERIOD = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };

const HEADERS = ["Mã NV", "Tên NV", "Ngày", "Giờ vào", "Giờ ra", "Phòng ban", "Công", "Tổng giờ", "Tăng ca"];

function buildWorkbook(rows: unknown[][], bookType: "xlsx" | "biff8"): Uint8Array {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "XuatLuoi");
  const output = XLSX.write(workbook, { type: "array", bookType });
  return new Uint8Array(output as ArrayBuffer);
}

function sheetName(bookType: "xlsx" | "biff8", name: string): Uint8Array {
  const worksheet = XLSX.utils.aoa_to_sheet([[1]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, name);
  const output = XLSX.write(workbook, { type: "array", bookType });
  return new Uint8Array(output as ArrayBuffer);
}

test("parses .xlsx columns by header name and normalises HH:MM", () => {
  const bytes = buildWorkbook(
    [
      HEADERS,
      ["BN01", "Bếp 1", "2026-08-01", "8:00", "17:30", "Bếp", 1, 9.5, 1.5],
      ["BN02", "Bếp 2", "2026-08-01", "08:00:00", "17:00:00", null, 1, 9, 1],
    ],
    "xlsx",
  );
  const parsed = parseAttendanceWorkbook(bytes, PERIOD);
  assert.equal(parsed.sheetName, "XuatLuoi");
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], {
    employeeCode: "BN01",
    employeeName: "Bếp 1",
    date: "2026-08-01",
    checkIn: "08:00:00",
    checkOut: "17:30:00",
    department: "Bếp",
    shift: null,
    lateMinutes: null,
    earlyMinutes: null,
  });
  assert.equal(parsed.rows[1].checkIn, "08:00:00");
  assert.equal(parsed.rows[1].checkOut, "17:00:00");
  assert.equal(parsed.rows[1].department, null);
});

test("stores Ca / Trễ / Sớm when present and leaves them null when absent", () => {
  const headers = [...HEADERS, "Ca", "Trễ", "Sớm"];
  const bytes = buildWorkbook(
    [
      headers,
      ["BN01", "Bếp 1", "2026-08-01", "08:04", "17:57", "Bếp", 1, 9.5, 1.5, "HC", 4, 0],
      ["BN02", "Bếp 2", "2026-08-02", "12:45", "18:05", "Bếp", 1, 5, 0, "V", 0, 0],
      ["BN03", "Bếp 3", "2026-08-03", "08:00", "17:00", "Bếp", 1, 9, 1, "Sai", "", ""],
    ],
    "xlsx",
  );
  const parsed = parseAttendanceWorkbook(bytes, PERIOD);
  assert.deepEqual(parsed.rows[0].shift, "HC");
  assert.equal(parsed.rows[0].lateMinutes, 4);
  assert.equal(parsed.rows[0].earlyMinutes, 0);
  assert.equal(parsed.rows[1].shift, "V");
  assert.equal(parsed.rows[2].shift, null);
  assert.equal(parsed.rows[2].lateMinutes, null);
  assert.equal(parsed.rows[2].earlyMinutes, null);
});

test("parses .xls (BIFF) workbooks", () => {
  const bytes = buildWorkbook(
    [HEADERS.slice(0, 5), ["BN03", "Phụ bếp", "2026-08-02", "07:30", "16:30"]],
    "biff8",
  );
  const parsed = parseAttendanceWorkbook(bytes, PERIOD);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].checkIn, "07:30:00");
  assert.equal(parsed.rows[0].checkOut, "16:30:00");
  assert.equal(parsed.rows[0].department, null);
});

test("ignores machine-computed Công / Tổng giờ / Tăng ca columns", () => {
  const bytes = buildWorkbook(
    [HEADERS, ["BN01", "Bếp 1", "2026-08-01", "08:00", "17:00", "Bếp", 99, 88, 77]],
    "xlsx",
  );
  const parsed = parseAttendanceWorkbook(bytes, PERIOD);
  assert.deepEqual(parsed.ignoredHeaders, ["Công", "Tổng giờ", "Tăng ca"]);
  assert.equal(parsed.rows[0].checkIn, "08:00:00");
  assert.equal(parsed.rows[0].checkOut, "17:00:00");
});

test("normalises Excel serial times and Vietnamese text dates", () => {
  assert.equal(normalizeTimeCell(0.5), "12:00:00");
  assert.equal(normalizeTimeCell(0.25), "06:00:00");
  assert.equal(normalizeDateCell("15/08/2026"), "2026-08-15");
  assert.equal(normalizeDateCell("2026-8-5"), "2026-08-05");
});

test("throws sheet_not_found when XuatLuoi is absent", () => {
  const bytes = sheetName("xlsx", "Sheet1");
  assert.throws(
    () => parseAttendanceWorkbook(bytes, PERIOD),
    (error: unknown) => error instanceof AttendanceParseError && error.code === "sheet_not_found",
  );
});

test("throws missing_required_columns when a mandatory column is absent", () => {
  const bytes = buildWorkbook([["Mã NV", "Tên NV", "Ngày", "Giờ vào"], ["BN01", "Bếp 1", "2026-08-01", "08:00"]], "xlsx");
  assert.throws(
    () => parseAttendanceWorkbook(bytes, PERIOD),
    (error: unknown) => error instanceof AttendanceParseError && error.code === "missing_required_columns",
  );
});

test("rejects dates outside the period", () => {
  const bytes = buildWorkbook(
    [HEADERS.slice(0, 5), ["BN01", "Bếp 1", "2026-09-01", "08:00", "17:00"]],
    "xlsx",
  );
  assert.throws(
    () => parseAttendanceWorkbook(bytes, PERIOD),
    (error: unknown) => error instanceof AttendanceParseError && error.code === "date_out_of_period",
  );
});

test("rejects a duplicate employee/day row", () => {
  const bytes = buildWorkbook(
    [
      HEADERS.slice(0, 5),
      ["BN01", "Bếp 1", "2026-08-01", "08:00", "17:00"],
      ["BN01", "Bếp 1", "2026-08-01", "08:05", "17:00"],
    ],
    "xlsx",
  );
  assert.throws(
    () => parseAttendanceWorkbook(bytes, PERIOD),
    (error: unknown) => error instanceof AttendanceParseError && error.code === "duplicate_employee_day",
  );
});

test("rejects an invalid time value", () => {
  const bytes = buildWorkbook(
    [HEADERS.slice(0, 5), ["BN01", "Bếp 1", "2026-08-01", "25:99", "17:00"]],
    "xlsx",
  );
  assert.throws(
    () => parseAttendanceWorkbook(bytes, PERIOD),
    (error: unknown) => error instanceof AttendanceParseError && error.code === "invalid_time",
  );
});

test("the file sha256 matches node:crypto and is stable", async () => {
  const bytes = buildWorkbook([HEADERS.slice(0, 5), ["BN01", "Bếp 1", "2026-08-01", "08:00", "17:00"]], "xlsx");
  const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  assert.equal(await computeFileSha256(bytes), expected);
  const parsed = await parseAttendanceFile(bytes, PERIOD);
  assert.equal(parsed.sha256, expected);
  assert.equal(parsed.rows.length, 1);
});

// ---------------------------------------------------------------------------
// Original T09 machine workbook — only when the operator points the env var at
// it. Without PAYROLL_BN_T09_XLS the test is skipped, like the e2e workbook test.
// ---------------------------------------------------------------------------

const T09_XLS = process.env.PAYROLL_BN_T09_XLS;

function pad5(value: unknown): string {
  return String(value).trim().padStart(5, "0");
}

test(
  "T09 gốc: Ca và Trễ của Ngọc khớp missions-t09.fixture.ts",
  { skip: !T09_XLS },
  (t) => {
    const inputPath = T09_XLS as string;
    if (!existsSync(inputPath)) {
      t.skip(`PAYROLL_BN_T09_XLS does not exist: ${inputPath}`);
      return;
    }

    // The copies kept in the team runs are a text export of the machine file
    // ("## Sheet: XuatLuoi" then CSV rows); a real .xls/.xlsx is read as is.
    // Either way the rows go through the same upload parser with the machine's
    // own headers (Ca / Trễ / Sớm).
    const raw = readFileSync(inputPath);
    let bytes: Uint8Array;
    if (raw.subarray(0, 9).toString("utf8") === "## Sheet:") {
      const csvText = raw.toString("utf8").split("\n").slice(1).join("\n");
      const csv = XLSX.read(csvText, { type: "string", raw: true });
      const normalized = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(normalized, csv.Sheets[csv.SheetNames[0]], "XuatLuoi");
      bytes = new Uint8Array(XLSX.write(normalized, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer);
    } else {
      bytes = new Uint8Array(raw);
    }
    const parsed = parseAttendanceWorkbook(bytes, {
      dateFrom: MISSIONS_T09_PERIOD.dateFrom,
      dateTo: MISSIONS_T09_PERIOD.dateTo,
    });

    const parsedByDate = new Map(
      parsed.rows
        .filter((row) => pad5(row.employeeCode) === "00002")
        .map((row) => [row.date, row]),
    );
    const fixtureNgoc = MISSIONS_T09_ROWS.filter((row) => row.employeeCode === "00002");
    assert.ok(fixtureNgoc.length > 0);

    for (const expected of fixtureNgoc) {
      const actual = parsedByDate.get(expected.date);
      assert.ok(actual, `thiếu dòng Ngọc ${expected.date}`);
      assert.equal(actual!.shift, expected.shift, `Ca ${expected.date}`);
      assert.equal(actual!.lateMinutes ?? null, expected.lateMinutes ?? null, `Trễ ${expected.date}`);
      assert.equal(actual!.earlyMinutes ?? null, expected.earlyMinutes ?? null, `Sớm ${expected.date}`);
    }
  },
);
