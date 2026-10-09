// Candidate generator for the Bếp BN surprise-reward missions.
//
// A suggestion for period M is derived from the latest attendance (period M−1)
// and the employee catalogue of M. Every suggestion carries a deterministic
// reason with the underlying numbers so a manager can decide. The generator
// never publishes and never enforces the 2-employee limit — that belongs to the
// publish step on the server.

import type { PayrollEmployee, PayrollPeriod } from "../payroll-bn/types.ts";
import { isMissionTemplateAutoSuggest } from "./templates.ts";
import type {
  MissionAttendanceRow,
  MissionSuggestion,
  MissionTemplate,
  MissionTemplateCode,
} from "./types.ts";

export interface MissionGeneratorInput {
  period: PayrollPeriod;
  employees: readonly PayrollEmployee[];
  /** Attendance rows of the latest period (M−1). */
  previousRows: readonly MissionAttendanceRow[];
  templates: readonly MissionTemplate[];
  /** Suggestions already persisted, so a rerun never duplicates them. */
  existing?: readonly { employeeCode: string; templateCode: MissionTemplateCode }[];
}

function groupRowsByEmployee(
  rows: readonly MissionAttendanceRow[],
): Map<string, MissionAttendanceRow[]> {
  const map = new Map<string, MissionAttendanceRow[]>();
  for (const row of rows) {
    const list = map.get(row.employeeCode) ?? [];
    list.push(row);
    map.set(row.employeeCode, list);
  }
  return map;
}

function matchesAppliesTo(employee: PayrollEmployee, template: MissionTemplate): boolean {
  const groups = template.appliesTo.groups;
  if (groups && groups.length > 0 && !groups.includes(employee.group)) return false;
  const types = template.appliesTo.employmentTypes;
  if (types && types.length > 0 && !types.includes(employee.employmentType)) return false;
  return true;
}

function attended(row: MissionAttendanceRow): boolean {
  return row.checkIn !== null || row.checkOut !== null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function suggestFor(
  template: MissionTemplate,
  employee: PayrollEmployee,
  rows: readonly MissionAttendanceRow[],
): MissionSuggestion | null {
  switch (template.code) {
    case "T-DUNGGIO": {
      const tolerance = toNumber(template.params.dung_sai_phut) ?? 0;
      const minimum = toNumber(template.params.nguong_de_xuat);
      if (minimum === null) return null;
      const lateDates = rows
        .filter((row) => row.shift === "HC" && attended(row))
        .filter((row) => row.lateMinutes !== null && row.lateMinutes > tolerance)
        .map((row) => row.date)
        .sort();
      if (lateDates.length < minimum) return null;
      return {
        employeeCode: employee.code,
        employeeName: employee.name,
        templateCode: template.code,
        reasonText: `${lateDates.length} ngày trễ`,
        sourceMetrics: {
          so_ngay_tre: lateDates.length,
          dung_sai_phut: tolerance,
          nguong_de_xuat: minimum,
        },
      };
    }
    case "T-CHAMDU": {
      const minimum = toNumber(template.params.nguong_de_xuat);
      if (minimum === null) return null;
      const missingDates = rows
        .filter((row) => attended(row) && (row.checkIn === null) !== (row.checkOut === null))
        .map((row) => row.date)
        .sort();
      if (missingDates.length < minimum) return null;
      return {
        employeeCode: employee.code,
        employeeName: employee.name,
        templateCode: template.code,
        reasonText: `${missingDates.length} ngày thiếu giờ vào/ra`,
        sourceMetrics: { so_ngay_thieu_cham: missingDates.length, nguong_de_xuat: minimum },
      };
    }
    case "T-GIOPT": {
      // Part-time staff who clocked in last period; the target is the
      // gio_toi_thieu–gio_toi_da window, never "more hours".
      if (employee.employmentType !== "part_time") return null;
      const minimum = toNumber(template.params.gio_toi_thieu);
      const maximum = toNumber(template.params.gio_toi_da);
      if (minimum === null || maximum === null) return null;
      const attendedRows = rows.filter(attended);
      if (attendedRows.length === 0) return null;
      const total = attendedRows.reduce((sum, row) => sum + hoursBetween(row), 0);
      const rounded = Math.round(total * 100) / 100;
      return {
        employeeCode: employee.code,
        employeeName: employee.name,
        templateCode: template.code,
        reasonText: `Tháng trước ${rounded} giờ; mốc ${minimum}–${maximum} giờ`,
        sourceMetrics: { tong_gio: rounded, gio_toi_thieu: minimum, gio_toi_da: maximum },
      };
    }
    default:
      return null;
  }
}

function hoursBetween(row: MissionAttendanceRow): number {
  const parse = (value: string | null): number | null => {
    if (!value) return null;
    const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + (match[3] ? Number(match[3]) : 0);
  };
  const start = parse(row.checkIn);
  const end = parse(row.checkOut);
  if (start === null || end === null) return 0;
  let diff = end - start;
  if (diff < 0) diff += 86400;
  return diff / 3600;
}

/**
 * Suggest candidates for period M. Deterministic ordering (employee_code then
 * template code), idempotent against `existing`.
 */
export function generateMissionSuggestions(input: MissionGeneratorInput): MissionSuggestion[] {
  const rowsByEmployee = groupRowsByEmployee(input.previousRows);
  const existing = new Set(
    (input.existing ?? []).map((item) => `${item.employeeCode}|${item.templateCode}`),
  );
  const templates = input.templates
    .filter((template) => template.enabled && isMissionTemplateAutoSuggest(template.code))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
  const employees = input.employees.slice().sort((a, b) => a.code.localeCompare(b.code));

  const suggestions: MissionSuggestion[] = [];
  for (const employee of employees) {
    if (employee.terminated) continue;
    const rows = rowsByEmployee.get(employee.code) ?? [];
    for (const template of templates) {
      if (!matchesAppliesTo(employee, template)) continue;
      if (
        employee.startDate &&
        employee.startDate > input.period.dateFrom &&
        !template.prorateAllowed
      ) {
        continue;
      }
      if (existing.has(`${employee.code}|${template.code}`)) continue;
      const suggestion = suggestFor(template, employee, rows);
      if (suggestion) suggestions.push(suggestion);
    }
  }

  return suggestions.sort(
    (a, b) =>
      a.employeeCode.localeCompare(b.employeeCode) ||
      a.templateCode.localeCompare(b.templateCode),
  );
}
