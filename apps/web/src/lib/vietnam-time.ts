export const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

const vietnamDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: VIETNAM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getVietnamDateKey(date = new Date()): string {
  return vietnamDateFormatter.format(date);
}

export function getVietnamDayUtcRange(date = new Date()): { startIso: string; endIso: string; dateKey: string } {
  const dateKey = getVietnamDateKey(date);
  const [year, month, day] = dateKey.split("-").map(Number);

  if (!year || !month || !day) {
    throw new Error(`Invalid Vietnam date key: ${dateKey}`);
  }

  const startUtcMs = Date.UTC(year, month - 1, day, -7, 0, 0, 0);
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
    dateKey,
  };
}

const vietnamDisplayDate = new Intl.DateTimeFormat("vi-VN", {
  timeZone: VIETNAM_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const vietnamDisplayTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: VIETNAM_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** dd/MM/yyyy in Vietnam time, whatever the browser's own timezone or locale. */
export function formatVietnamDate(value: string | number | Date): string {
  // A bare "YYYY-MM-DD" (a Postgres date) is a calendar day, not an instant: never shift it.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDateKeyVi(value);
  return vietnamDisplayDate.format(new Date(value));
}

/** dd/MM/yyyy HH:mm in Vietnam time, whatever the browser's own timezone or locale. */
export function formatVietnamDateTime(value: string | number | Date): string {
  const date = new Date(value);
  return `${vietnamDisplayDate.format(date)} ${vietnamDisplayTime.format(date)}`;
}

/** "2026-10-08" (a date input value) → "08/10/2026", independent of the browser locale. */
export function formatDateKeyVi(dateKey: string | null | undefined): string {
  const [year, month, day] = String(dateKey || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : "--/--/----";
}
