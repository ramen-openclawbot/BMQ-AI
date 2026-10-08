import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  });
  assert.equal(parsed.rows[1].checkIn, "08:00:00");
  assert.equal(parsed.rows[1].checkOut, "17:00:00");
  assert.equal(parsed.rows[1].department, null);
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
