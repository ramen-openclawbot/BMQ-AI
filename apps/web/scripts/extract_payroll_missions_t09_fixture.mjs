#!/usr/bin/env node
// Extract the T09.2026 mission fixture from the original machine workbook.
//
// Usage:
//   node apps/web/scripts/extract_payroll_missions_t09_fixture.mjs \
//     "/path/to/Bảng_chấm_công_BEP_BN_T09.26.xls"
//
// The attendance part is read exclusively through the payroll parser
// (attendance-parser.ts) so the fixture uses the exact same normalisation as the
// engine. The extra machine columns (Trễ / Sớm / Ca) are copied verbatim by
// (employee, date) and the derived anomaly flags are added, because the payroll
// parser deliberately ignores those columns.
//
// The output is generated, never hand-edited.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

import {
  normalizeDateCell,
  parseAttendanceWorkbook,
} from "../src/lib/payroll-bn/attendance-parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_WEB_ROOT = resolve(__dirname, "..");

const SOURCE_SHEET = "XuatLuoi";
const PERIOD = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

// Employee metadata for the seven codes the task needs. Names/groups/rates are
// the real T09 catalogue (output/payroll-bn-seed-t09.sql); the script writes
// them so the fixture is self-contained.
const EMPLOYEES = [
  { code: "00001", name: "Trần Kỳ Duyên", group: "Kho BN", employmentType: "part_time", hourlyRate: 23000, startDate: null },
  { code: "00002", name: "Hùng Kim Ngọc", group: "Kho BN", employmentType: "part_time", hourlyRate: 23000, startDate: null },
  { code: "00005", name: "Nguyễn Anh Thư", group: "Bếp bánh", employmentType: "official", monthlySalary: 7000000, overtimeRate: 30000, startDate: "2025-01-01" },
  { code: "00006", name: "Hồng", group: "Kho BN", employmentType: "official", monthlySalary: 5000000, overtimeRate: 25000, startDate: "2026-09-30" },
  { code: "00030", name: "Lê Nguyễn Hoàng Long", group: "Bếp bánh", employmentType: "part_time", hourlyRate: 30000, startDate: "2025-01-01" },
  { code: "00033", name: "Phan Huỳnh Thu Thảo", group: "Bếp bánh", employmentType: "part_time", hourlyRate: 30000, startDate: "2025-01-01" },
  { code: "00034", name: "Hà Tuấn Huy", group: "Bếp bánh", employmentType: "official", monthlySalary: 17000000, startDate: "2025-01-01" },
];

// The counts the test contract relies on (spec bảng 4.1 was not shipped with the
// task; these are the values the agreed tests assert). A mismatch must stop the
// run instead of rewriting the numbers.
const EXPECTED_HC_LATE_DAYS = {
  "00001": 10,
  "00002": 7,
  "00005": 1,
  "00006": 0,
  "00030": 0,
  "00033": 0,
  "00034": 0,
};

function pad5(value) {
  return String(value).trim().padStart(5, "0");
}

function cellNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flagsFor({ checkIn, checkOut, shift, lateMinutes }) {
  const flags = [];
  if (checkIn !== null && checkOut === null) flags.push("missing_check_out");
  if (checkIn === null && checkOut !== null) flags.push("missing_check_in");
  if (
    (checkIn !== null || checkOut !== null) &&
    (shift === null || shift === undefined) &&
    (lateMinutes === null || lateMinutes === undefined)
  ) {
    flags.push("no_machine_data");
  }
  if (checkIn !== null && checkOut !== null && checkIn === checkOut) flags.push("duplicate_time");
  return flags;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Thiếu đường dẫn file chấm công gốc.");
    process.exit(2);
  }

  const workbook = XLSX.read(readFileSync(inputPath), { type: "buffer", cellDates: false });
  const markerSheet = workbook.SheetNames.find((name) => {
    const first = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false })[0];
    return String(first?.[0] ?? "").startsWith(`## Sheet: ${SOURCE_SHEET}`);
  });
  const actualSheet = markerSheet ?? workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === SOURCE_SHEET.toLowerCase(),
  );
  if (!actualSheet) {
    console.error(`Không tìm thấy sheet ${SOURCE_SHEET} hoặc dấu ## Sheet: ${SOURCE_SHEET}.`);
    process.exit(1);
  }

  // The original .xls stores UTF-8 bytes that SheetJS reads back as latin1.
  // Re-decode every text cell so the payroll parser sees the real Vietnamese
  // headers; the numeric cells (times, ngày, Trễ, Sớm) stay untouched.
  const rawMatrix = XLSX.utils.sheet_to_json(workbook.Sheets[actualSheet], {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  const decode = (value) =>
    typeof value === "string" ? Buffer.from(value, "latin1").toString("utf8") : value;
  const matrix = rawMatrix.map((row) => row.map(decode));
  const headerRowIndex = matrix.findIndex((row) =>
    row.some((cell) => String(cell ?? "").trim() === "Mã Nhân Viên"),
  );
  if (headerRowIndex < 0) {
    console.error("Không tìm thấy dòng tiêu đề chấm công.");
    process.exit(1);
  }
  const header = matrix[headerRowIndex].map((cell) => String(cell ?? "").trim());
  const column = (needle) => header.findIndex((name) => name === needle);

  const rawByKey = new Map();
  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const row = matrix[i];
    if (!row || row.every((cell) => cell === null || cell === undefined || cell === "")) continue;
    const code = pad5(row[column("Mã Nhân Viên")]);
    const date = normalizeDateCell(row[column("Ngày")]);
    if (!date) continue;
    const rawShift = row[column("Ca")];
    const shift = rawShift === "HC" || rawShift === "V" ? rawShift : null;
    rawByKey.set(`${code}|${date}`, {
      shift,
      lateMinutes: cellNumber(row[column("Trễ")]),
      earlyMinutes: cellNumber(row[column("Sớm")]),
    });
  }

  // Delegate the attendance normalisation to the payroll parser: rebuild a
  // workbook whose sheet has the exact name the parser expects.
  const normalized = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(normalized, XLSX.utils.aoa_to_sheet(matrix), SOURCE_SHEET);
  const normalizedBytes = XLSX.write(normalized, { type: "buffer", bookType: "xlsx" });
  const parsed = parseAttendanceWorkbook(normalizedBytes, PERIOD);

  const targetCodes = new Set(EMPLOYEES.map((employee) => employee.code));
  const rows = [];
  for (const parsedRow of parsed.rows) {
    const code = pad5(parsedRow.employeeCode);
    if (!targetCodes.has(code)) continue;
    const extra = rawByKey.get(`${code}|${parsedRow.date}`) ?? {
      shift: null,
      lateMinutes: null,
      earlyMinutes: null,
    };
    rows.push({
      employeeCode: code,
      employeeName: parsedRow.employeeName,
      date: parsedRow.date,
      checkIn: parsedRow.checkIn,
      checkOut: parsedRow.checkOut,
      shift: extra.shift,
      lateMinutes: extra.lateMinutes,
      earlyMinutes: extra.earlyMinutes,
      flags: flagsFor({
        checkIn: parsedRow.checkIn,
        checkOut: parsedRow.checkOut,
        shift: extra.shift,
        lateMinutes: extra.lateMinutes,
      }),
    });
  }
  rows.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode) || a.date.localeCompare(b.date));

  const hcLateCounts = {};
  for (const employee of EMPLOYEES) {
    hcLateCounts[employee.code] = rows.filter(
      (row) => row.employeeCode === employee.code && row.shift === "HC" && (row.lateMinutes ?? 0) > 0,
    ).length;
  }

  console.log("Số ngày ca HC có Trễ > 0:");
  for (const employee of EMPLOYEES) {
    console.log(`  ${employee.code} ${employee.name}: ${hcLateCounts[employee.code]}`);
  }

  let mismatched = false;
  for (const [code, expected] of Object.entries(EXPECTED_HC_LATE_DAYS)) {
    if (hcLateCounts[code] !== expected) {
      mismatched = true;
      console.error(`LỆCH: ${code} HC Trễ>0 = ${hcLateCounts[code]}, kỳ vọng ${expected}`);
    }
  }

  if (mismatched) {
    const diffPath = resolve(REPO_WEB_ROOT, "..", "output", "payroll-missions-fixture-diff.md");
    const lines = [
      "# Chênh lệch fixture T09 — nhiệm vụ thưởng",
      "",
      "Bảng 4.1 của đặc tả không có trong repo. Đối chiếu với hợp đồng test đã thoả thuận:",
      "",
      "| Mã NV | Ca HC có Trễ > 0 | Kỳ vọng |",
      "|---|---|---|",
      ...EMPLOYEES.map(
        (employee) =>
          `| ${employee.code} | ${hcLateCounts[employee.code]} | ${EXPECTED_HC_LATE_DAYS[employee.code]} |`,
      ),
      "",
      "→ Lệch: dừng, không sửa fixture.",
      "",
    ];
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, lines.join("\n"), "utf8");
    console.error(`Đã ghi chênh lệch vào ${diffPath}`);
    process.exit(1);
  }

  const periodDate = PERIOD;
  const lines = [];
  lines.push("// AUTO-GENERATED by apps/web/scripts/extract_payroll_missions_t09_fixture.mjs");
  lines.push("// Nguồn: Bảng_chấm_công_BEP_BN_T09.26.xls (sheet XuatLuoi) — KHÔNG SỬA TAY.");
  lines.push("//");
  lines.push("// Dòng chấm công được parse bằng payroll-bn/attendance-parser.ts; cột Trễ / Sớm /");
  lines.push("// Ca và cờ bất thường được giữ nguyên từ file gốc. Tham số/thưởng không nằm ở đây.");
  lines.push("");
  lines.push('import { resolveRulesConfig } from "../payroll-bn/rules-config.ts";');
  lines.push('import type { PayrollEmployee, PayrollPeriod } from "../payroll-bn/types.ts";');
  lines.push('import type { MissionAttendanceRow } from "./types.ts";');
  lines.push("");
  lines.push(`export const MISSIONS_T09_SOURCE = ${JSON.stringify(inputPath)};`);
  lines.push("");
  lines.push("export const MISSIONS_T09_PERIOD: PayrollPeriod = {");
  lines.push('  code: "T09.2026",');
  lines.push('  name: "Kỳ lương tháng 09/2026 — Bếp BN",');
  lines.push(`  dateFrom: ${JSON.stringify(periodDate.dateFrom)},`);
  lines.push(`  dateTo: ${JSON.stringify(periodDate.dateTo)},`);
  lines.push('  standardDaysByGroup: { "Văn phòng": 22, "Bếp bánh": 26, "Kho BN": 26 },');
  lines.push("  defaultStandardDays: 26,");
  lines.push('  holidays: ["2026-09-01", "2026-09-02"],');
  lines.push("  rules: resolveRulesConfig(),");
  lines.push('  status: "draft",');
  lines.push("};");
  lines.push("");
  lines.push("export const MISSIONS_T09_EMPLOYEES: PayrollEmployee[] = [");
  for (const employee of EMPLOYEES) {
    const parts = [
      `code: ${JSON.stringify(employee.code)}`,
      `name: ${JSON.stringify(employee.name)}`,
      `group: ${JSON.stringify(employee.group)}`,
      `employmentType: ${JSON.stringify(employee.employmentType)}`,
      `monthlySalary: ${employee.monthlySalary ?? null}`,
      `hourlyRate: ${employee.hourlyRate ?? null}`,
      "allowance: null",
      `overtimeRate: ${employee.overtimeRate ?? null}`,
      "standardDaysOverride: null",
      `startDate: ${employee.startDate ? JSON.stringify(employee.startDate) : null}`,
      "endDate: null",
      "terminated: false",
    ];
    lines.push(`  { ${parts.join(", ")} },`);
  }
  lines.push("];");
  lines.push("");
  lines.push("export const MISSIONS_T09_ROWS: MissionAttendanceRow[] = [");
  for (const row of rows) {
    lines.push(
      `  { employeeCode: ${JSON.stringify(row.employeeCode)}, employeeName: ${JSON.stringify(
        row.employeeName,
      )}, date: ${JSON.stringify(row.date)}, checkIn: ${
        row.checkIn ? JSON.stringify(row.checkIn) : "null"
      }, checkOut: ${row.checkOut ? JSON.stringify(row.checkOut) : "null"}, shift: ${
        row.shift ? JSON.stringify(row.shift) : "null"
      }, lateMinutes: ${row.lateMinutes ?? "null"}, earlyMinutes: ${
        row.earlyMinutes ?? "null"
      }, flags: ${JSON.stringify(row.flags)} },`,
    );
  }
  lines.push("];");
  lines.push("");

  const outPath = resolve(
    REPO_WEB_ROOT,
    "src",
    "lib",
    "payroll-missions",
    "missions-t09.fixture.ts",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`Đã ghi ${rows.length} dòng của ${EMPLOYEES.length} nhân viên vào ${outPath}`);
}

main();
