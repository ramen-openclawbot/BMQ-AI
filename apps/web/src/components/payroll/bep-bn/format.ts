// Display-only formatting for the Bếp BN payroll panel. Amounts stay exact
// rationals in the engine; they are converted to numbers only to render text.

import { rationalToNumber, type Rational } from "@/lib/payroll-bn/money.ts";
import type { AnomalyCode } from "@/lib/payroll-bn/anomalies.ts";
import type { AdjustmentField } from "@/lib/payroll-bn/types.ts";

const numberFormat = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

export function formatQuantity(value: Rational): string {
  const number = rationalToNumber(value);
  return number === 0 ? "–" : numberFormat.format(number);
}

export function formatMoney(value: Rational): string {
  const number = rationalToNumber(value);
  return number === 0 ? "–" : numberFormat.format(number);
}

export function formatVnd(value: bigint): string {
  return value === 0n ? "0" : numberFormat.format(Number(value));
}

export function formatAdjustmentValue(value: number | string): string {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? numberFormat.format(number) : String(value);
}

export function formatTime(value: string | null): string {
  return value ? value.slice(0, 5) : "--:--";
}

export function formatDayMonth(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export const ANOMALY_LABELS: Record<AnomalyCode, string> = {
  missing_check_out: "Thiếu giờ ra",
  missing_check_in: "Thiếu giờ vào",
  no_machine_data: "Máy không có số liệu",
  duplicate_time: "Trùng giờ với người khác",
  unknown_employee: "Mã không có trong danh mục",
  missing_attendance: "Không có chấm công",
  holiday_attendance: "Chấm công ngày lễ",
};

export const ADJUSTMENT_LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

export const VALUELESS_ADJUSTMENTS: ReadonlySet<AdjustmentField> = new Set(["exclude_overtime", "exclude_holiday"]);
