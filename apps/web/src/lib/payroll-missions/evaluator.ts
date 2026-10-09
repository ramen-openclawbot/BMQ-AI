// Deterministic mission evaluator (no LLM).
//
// Each auto-verified template turns the attendance rows of the mission period M
// into one of three outcomes: achieved, not_achieved or needs_review. A day the
// machine marked with an anomaly (manual entry without a machine number,
// duplicated time) can never be silently treated as achieved.

import type {
  MissionAttendanceRow,
  MissionEvaluation,
  MissionTemplate,
} from "./types.ts";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timeToSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** check-in → check-out span in hours, +24h for an overnight shift. */
export function workedHours(row: MissionAttendanceRow): number {
  const checkIn = timeToSeconds(row.checkIn);
  const checkOut = timeToSeconds(row.checkOut);
  if (checkIn === null || checkOut === null) return 0;
  let diff = checkOut - checkIn;
  if (diff < 0) diff += 86400;
  return diff / 3600;
}

function attended(row: MissionAttendanceRow): boolean {
  return row.checkIn !== null || row.checkOut !== null;
}

function hasAbnormalFlag(row: MissionAttendanceRow): boolean {
  return row.flags.includes("no_machine_data") || row.flags.includes("duplicate_time");
}

function evaluateDungGio(template: MissionTemplate, rows: readonly MissionAttendanceRow[]): MissionEvaluation {
  const tolerance = toNumber(template.params.dung_sai_phut);
  if (tolerance === null) {
    return {
      status: "needs_review",
      reason: "Thiếu tham số dung_sai_phut",
      evidence: { template: template.code },
    };
  }

  // Only HC (hành chính) days count. A V shift is never "on time"; it is simply
  // not part of the criterion. The Sớm (early-leave) column is deliberately not
  // read here — T-DUNGGIO is about lateness only.
  const hcRows = rows.filter((row) => row.shift === "HC" && attended(row));
  const unreadable = hcRows.filter((row) => row.checkIn !== null && row.lateMinutes === null);
  if (unreadable.length > 0) {
    return {
      status: "needs_review",
      reason: "Ngày ca HC thiếu số liệu Trễ",
      evidence: {
        template: template.code,
        dung_sai_phut: tolerance,
        unreadable_dates: unreadable.map((row) => row.date),
      },
    };
  }

  const lateRows = hcRows.filter((row) => row.lateMinutes !== null && row.lateMinutes > tolerance);
  // so_ngay_tre_toi_da — allowed late days; unset means none (the strictest reading).
  const maxLateDays = toNumber(template.params.so_ngay_tre_toi_da) ?? 0;
  const ignoredVDays = rows.filter((row) => row.shift === "V" && attended(row)).length;
  const evidence = {
    template: template.code,
    dung_sai_phut: tolerance,
    so_ngay_tre_toi_da: maxLateDays,
    considered_days: hcRows.length,
    late_days: lateRows.length,
    late_dates: lateRows.map((row) => row.date),
    ignored_v_days: ignoredVDays,
  };

  if (hcRows.length === 0) {
    return { status: "needs_review", reason: "Không có ngày ca HC để chấm", evidence };
  }
  if (lateRows.length > maxLateDays) {
    return { status: "not_achieved", reason: `${lateRows.length} ngày trễ`, evidence };
  }
  return {
    status: "achieved",
    reason: lateRows.length === 0 ? "Không có ngày trễ" : `${lateRows.length} ngày trễ, trong mức cho phép`,
    evidence,
  };
}

function evaluateChamDu(template: MissionTemplate, rows: readonly MissionAttendanceRow[]): MissionEvaluation {
  const attendedRows = rows.filter(attended);
  const missing = attendedRows.filter(
    (row) => (row.checkIn === null) !== (row.checkOut === null),
  );
  const abnormal = attendedRows.filter(hasAbnormalFlag);
  const evidence = {
    template: template.code,
    attended_days: attendedRows.length,
    missing_punch_dates: missing.map((row) => row.date),
    abnormal_dates: abnormal.map((row) => row.date),
  };

  if (missing.length > 0) {
    return { status: "not_achieved", reason: `${missing.length} ngày thiếu giờ vào/ra`, evidence };
  }
  if (abnormal.length > 0) {
    return { status: "needs_review", reason: `${abnormal.length} ngày có cờ bất thường`, evidence };
  }
  if (attendedRows.length === 0) {
    return { status: "needs_review", reason: "Không có ngày chấm công", evidence };
  }
  return { status: "achieved", reason: "Chấm đủ giờ vào/ra", evidence };
}

function evaluateGioiHanGio(template: MissionTemplate, rows: readonly MissionAttendanceRow[]): MissionEvaluation {
  const minHours = toNumber(template.params.gio_toi_thieu);
  const maxHours = toNumber(template.params.gio_toi_da);
  if (minHours === null || maxHours === null) {
    return {
      status: "needs_review",
      reason: "Thiếu tham số gio_toi_thieu hoặc gio_toi_da",
      evidence: { template: template.code },
    };
  }
  const totalHours = rows.filter(attended).reduce((sum, row) => sum + workedHours(row), 0);
  const evidence = { template: template.code, gio_toi_thieu: minHours, gio_toi_da: maxHours, total_hours: totalHours };
  // The cap is mandatory: unlimited extra hours never earn a mission.
  if (totalHours < minHours || totalHours > maxHours) {
    return { status: "not_achieved", reason: `Tổng ${totalHours} giờ ngoài mốc ${minHours}–${maxHours} giờ`, evidence };
  }
  return { status: "achieved", reason: `Tổng ${totalHours} giờ trong mốc ${minHours}–${maxHours} giờ`, evidence };
}

function evaluateChuyenCan(template: MissionTemplate, rows: readonly MissionAttendanceRow[]): MissionEvaluation {
  const minimumDays = toNumber(template.params.so_ngay_toi_thieu);
  if (minimumDays === null) {
    return {
      status: "needs_review",
      reason: "Thiếu tham số so_ngay_toi_thieu",
      evidence: { template: template.code },
    };
  }
  const dates = new Set(rows.filter(attended).map((row) => row.date));
  const evidence = { template: template.code, so_ngay_toi_thieu: minimumDays, attendance_days: dates.size };
  if (dates.size >= minimumDays) {
    return { status: "achieved", reason: `${dates.size} ngày có mặt`, evidence };
  }
  return { status: "not_achieved", reason: `${dates.size} ngày có mặt`, evidence };
}

/** Judge one mission from the attendance rows of its period. Pure. */
export function evaluateMission(input: {
  template: MissionTemplate;
  attendance: readonly MissionAttendanceRow[];
}): MissionEvaluation {
  const { template, attendance } = input;

  if (template.verification === "manager") {
    return {
      status: "needs_review",
      reason: "Chờ quản lý xác nhận",
      evidence: { template: template.code },
    };
  }

  switch (template.code) {
    case "T-DUNGGIO":
      return evaluateDungGio(template, attendance);
    case "T-CHAMDU":
      return evaluateChamDu(template, attendance);
    case "T-GIOPT":
      return evaluateGioiHanGio(template, attendance);
    case "T-CHUYENCAN":
      return evaluateChuyenCan(template, attendance);
    case "T-QL":
      return {
        status: "needs_review",
        reason: "Chờ quản lý xác nhận",
        evidence: { template: template.code },
      };
    default:
      throw new Error(`Chưa hỗ trợ chấm mẫu nhiệm vụ: ${String(template.code)}`);
  }
}
