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
