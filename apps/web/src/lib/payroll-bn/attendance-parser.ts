// Attendance workbook parser for the Bếp BN payroll.
//
// Reads the "XuatLuoi" sheet from an .xls (BIFF) or .xlsx workbook (SheetJS
// handles both), maps columns by their Vietnamese header names — the Phòng ban
// column is optional — normalises HH:MM / HH:MM:SS and never reads the
// machine-computed Công / Tổng giờ / Tăng ca columns.

import * as XLSX from "xlsx";

import type { AttendanceRow } from "./types.ts";

export const ATTENDANCE_SHEET_NAME = "XuatLuoi";

export interface PeriodRange {
  dateFrom: string;
  dateTo: string;
}

export interface AttendanceParseResult {
  sheetName: string;
  headers: string[];
  rows: AttendanceRow[];
  /** Headers that look machine-computed and were deliberately ignored. */
  ignoredHeaders: string[];
}

export type AttendanceParseErrorCode =
  | "workbook_unreadable"
  | "sheet_not_found"
  | "missing_required_columns"
  | "invalid_date"
  | "invalid_time"
  | "date_out_of_period"
  | "missing_employee_code"
  | "duplicate_employee_day";

export class AttendanceParseError extends Error {
  readonly code: AttendanceParseErrorCode;
  readonly details: unknown;

  constructor(code: AttendanceParseErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AttendanceParseError";
    this.code = code;
    this.details = details ?? null;
  }
}

type AttendanceColumn =
  | "employeeCode"
  | "employeeName"
  | "date"
  | "checkIn"
  | "checkOut"
  | "department"
  | "shift"
  | "lateMinutes"
  | "earlyMinutes";

const REQUIRED_COLUMNS: AttendanceColumn[] = [
  "employeeCode",
  "employeeName",
  "date",
  "checkIn",
  "checkOut",
];

const HEADER_ALIASES: Record<AttendanceColumn, string[]> = {
  employeeCode: ["ma nv", "ma nhan vien", "ma nhan vien nv", "employee code", "ma", "code"],
  employeeName: ["ten nv", "ten nhan vien", "ho ten", "ten", "employee name", "name"],
  date: ["ngay", "ngay lam", "ngay lam viec", "ngay cham cong", "work date", "date"],
  checkIn: ["gio vao", "gio check in", "check in", "checkin", "vao"],
  checkOut: ["gio ra", "gio check out", "check out", "checkout", "ra"],
  department: ["phong ban", "bo phan", "khu vuc", "department"],
  // The machine columns the payroll engine deliberately ignores but the mission
  // module needs. Missing columns stay null; they never change R1–R9.
  shift: ["ca", "ca lam", "ca lam viec", "shift"],
  lateMinutes: ["tre", "di tre", "tre phut", "phut tre", "late"],
  earlyMinutes: ["som", "ve som", "som phut", "phut som", "early"],
};

const MACHINE_COMPUTED_HEADER = /(^|\s)(cong|tong gio|tang ca|tong cong|gio cong)(\s|$)/;

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchColumn(header: string, column: AttendanceColumn): boolean {
  const aliases = HEADER_ALIASES[column];
  return aliases.some((alias) => header === alias || header.startsWith(`${alias} `));
}

interface ColumnMapping {
  employeeCode: number;
  employeeName: number;
  date: number;
  checkIn: number;
  checkOut: number;
  department: number;
  shift: number;
  lateMinutes: number;
  earlyMinutes: number;
}

function mapHeaders(headerRow: unknown[]): ColumnMapping {
  const normalized = headerRow.map((cell) => normalizeHeader(cell));
  const mapping: ColumnMapping = {
    employeeCode: -1,
    employeeName: -1,
    date: -1,
    checkIn: -1,
    checkOut: -1,
    department: -1,
    shift: -1,
    lateMinutes: -1,
    earlyMinutes: -1,
  };
  const columns: AttendanceColumn[] = [
    "employeeCode",
    "employeeName",
    "date",
    "checkIn",
    "checkOut",
    "department",
    "shift",
    "lateMinutes",
    "earlyMinutes",
  ];
  for (const column of columns) {
    const index = normalized.findIndex((header) => header.length > 0 && matchColumn(header, column));
    mapping[column] = index;
  }
  return mapping;
}

function hasAllRequired(mapping: ColumnMapping): boolean {
  return REQUIRED_COLUMNS.every((column) => mapping[column] >= 0);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value).trim();
}

/** Machine shift column: only HC / V are recognised, everything else is null. */
function cellToShift(value: unknown): "HC" | "V" | null {
  const text = cellToText(value);
  return text === "HC" || text === "V" ? text : null;
}

/** Machine minutes column (Trễ / Sớm): a non-negative integer or null. */
function cellToMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

/** Normalise Excel serial / Date / Vietnamese text dates to YYYY-MM-DD. */
export function normalizeDateCell(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = (XLSX as unknown as { SSF: { parse_date_code: (n: number) => any } }).SSF.parse_date_code(value);
    if (!parsed) return null;
    return `${pad4(parsed.y)}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
  }
  if (value instanceof Date) {
    return `${pad4(value.getUTCFullYear())}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (match) return `${match[3]}-${pad2(Number(match[2]))}-${pad2(Number(match[1]))}`;
  return null;
}

function secondsToHms(totalSeconds: number): string {
  const seconds = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Normalise Excel serial / Date / HH:MM(:SS) text to HH:MM:SS. */
export function normalizeTimeCell(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    const fraction = value % 1;
    if (fraction === 0 && value >= 1) return null;
    return secondsToHms(Math.round(fraction * 86400));
  }
  if (value instanceof Date) {
    return secondsToHms(
      value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds(),
    );
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = match[3] ? Number(match[3]) : 0;
  if (h > 23 || m > 59 || s > 59) return null;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function isIsoDateInRange(date: string, period: PeriodRange): boolean {
  return date >= period.dateFrom && date <= period.dateTo;
}

function asMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  return rows.map((row) => (Array.isArray(row) ? row : [row]));
}

/**
 * Parse an attendance workbook. Structural problems throw AttendanceParseError;
 * empty check-in/check-out cells are kept as null so anomalies.ts can flag them.
 */
export function parseAttendanceWorkbook(
  input: Uint8Array | ArrayBuffer,
  period: PeriodRange,
): AttendanceParseResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  } catch (error) {
    throw new AttendanceParseError("workbook_unreadable", "Không đọc được file chấm công.", String(error));
  }

  const sheetName = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === ATTENDANCE_SHEET_NAME.toLowerCase(),
  );
  if (!sheetName) {
    throw new AttendanceParseError(
      "sheet_not_found",
      `Không tìm thấy sheet ${ATTENDANCE_SHEET_NAME}.`,
      workbook.SheetNames,
    );
  }

  const matrix = asMatrix(workbook.Sheets[sheetName]);
  let headerRowIndex = -1;
  let mapping: ColumnMapping | null = null;
  for (let i = 0; i < Math.min(matrix.length, 20); i += 1) {
    const candidate = mapHeaders(matrix[i]);
    if (hasAllRequired(candidate)) {
      headerRowIndex = i;
      mapping = candidate;
      break;
    }
  }
  if (headerRowIndex === -1 || !mapping) {
    throw new AttendanceParseError(
      "missing_required_columns",
      "Thiếu cột bắt buộc trong sheet XuatLuoi.",
      { required: REQUIRED_COLUMNS },
    );
  }

  const headers = matrix[headerRowIndex].map((cell) => String(cell ?? "").trim());
  const ignoredHeaders = headers.filter((header) => MACHINE_COMPUTED_HEADER.test(normalizeHeader(header)));

  const rows: AttendanceRow[] = [];
  const seen = new Set<string>();
  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const raw = matrix[i];
    if (!raw || raw.every((cell) => cell === null || cell === undefined || cell === "")) continue;

    const employeeCode = cellToText(raw[mapping.employeeCode]);
    const employeeName = cellToText(raw[mapping.employeeName]);
    const dateRaw = raw[mapping.date];
    const checkInRaw = raw[mapping.checkIn];
    const checkOutRaw = raw[mapping.checkOut];

    if (employeeCode === "") {
      throw new AttendanceParseError(
        "missing_employee_code",
        `Dòng ${i + 1}: thiếu mã nhân viên.`,
        { row: i + 1 },
      );
    }

    const date = normalizeDateCell(dateRaw);
    if (!date) {
      throw new AttendanceParseError(
        "invalid_date",
        `Dòng ${i + 1}: ngày không hợp lệ.`,
        { row: i + 1, value: dateRaw ?? null },
      );
    }
    if (!isIsoDateInRange(date, period)) {
      throw new AttendanceParseError(
        "date_out_of_period",
        `Dòng ${i + 1}: ngày ${date} ngoài kỳ ${period.dateFrom}..${period.dateTo}.`,
        { row: i + 1, date },
      );
    }

    const checkIn = normalizeTimeCell(checkInRaw);
    if (checkInRaw !== null && checkInRaw !== undefined && String(checkInRaw).trim() !== "" && !checkIn) {
      throw new AttendanceParseError(
        "invalid_time",
        `Dòng ${i + 1}: giờ vào không hợp lệ.`,
        { row: i + 1, value: checkInRaw ?? null },
      );
    }

    const checkOut = normalizeTimeCell(checkOutRaw);
    if (checkOutRaw !== null && checkOutRaw !== undefined && String(checkOutRaw).trim() !== "" && !checkOut) {
      throw new AttendanceParseError(
        "invalid_time",
        `Dòng ${i + 1}: giờ ra không hợp lệ.`,
        { row: i + 1, value: checkOutRaw ?? null },
      );
    }

    const key = `${employeeCode}|${date}`;
    if (seen.has(key)) {
      throw new AttendanceParseError(
        "duplicate_employee_day",
        `Dòng ${i + 1}: ${employeeCode} đã có chấm công ngày ${date}.`,
        { row: i + 1, employeeCode, date },
      );
    }
    seen.add(key);

    const department =
      mapping.department >= 0 ? cellToText(raw[mapping.department]) : "";
    const shift = mapping.shift >= 0 ? cellToShift(raw[mapping.shift]) : null;
    const lateMinutes = mapping.lateMinutes >= 0 ? cellToMinutes(raw[mapping.lateMinutes]) : null;
    const earlyMinutes = mapping.earlyMinutes >= 0 ? cellToMinutes(raw[mapping.earlyMinutes]) : null;

    rows.push({
      employeeCode,
      employeeName,
      date,
      checkIn,
      checkOut,
      department: department === "" ? null : department,
      shift,
      lateMinutes,
      earlyMinutes,
    });
  }

  return { sheetName, headers, rows, ignoredHeaders };
}

/** SHA-256 (lowercase hex) of the raw file bytes. */
export async function computeFileSha256(input: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface AttendanceFileParseResult extends AttendanceParseResult {
  sha256: string;
}

/** Parse plus file hash in one call (the hash is what the DB import dedupes). */
export async function parseAttendanceFile(
  input: Uint8Array | ArrayBuffer,
  period: PeriodRange,
): Promise<AttendanceFileParseResult> {
  const sha256 = await computeFileSha256(input);
  const parsed = parseAttendanceWorkbook(input, period);
  return { ...parsed, sha256 };
}
