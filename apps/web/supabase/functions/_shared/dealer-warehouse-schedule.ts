const VIETNAM_UTC_OFFSET_HOURS = 7;

/**
 * Warehouse Zalo notifications may run from 20:00:00 through 23:59:59
 * in Vietnam (UTC+7). Vietnam does not observe daylight saving time.
 */
export const isWarehouseNotificationWindow = (now: Date): boolean => {
  if (!Number.isFinite(now.getTime())) return false;
  const vietnamHour = (now.getUTCHours() + VIETNAM_UTC_OFFSET_HOURS) % 24;
  return vietnamHour >= 20 && vietnamHour <= 23;
};

/** The 23:59 Vietnam scan creates the one-per-day warehouse digest. */
export const isWarehouseDailyDigestTime = (now: Date): boolean => {
  if (!Number.isFinite(now.getTime())) return false;
  const vietnamHour = (now.getUTCHours() + VIETNAM_UTC_OFFSET_HOURS) % 24;
  return vietnamHour === 23 && now.getUTCMinutes() === 59;
};

export const warehouseVietnamDayRange = (now: Date): {
  dateKey: string;
  startsAt: string;
  endsBefore: string;
} | null => {
  if (!Number.isFinite(now.getTime())) return null;
  const offsetMs = VIETNAM_UTC_OFFSET_HOURS * 60 * 60 * 1000;
  const vietnamDate = new Date(now.getTime() + offsetMs);
  const startUtcMs = Date.UTC(
    vietnamDate.getUTCFullYear(),
    vietnamDate.getUTCMonth(),
    vietnamDate.getUTCDate(),
  ) - offsetMs;
  return {
    dateKey: vietnamDate.toISOString().slice(0, 10),
    startsAt: new Date(startUtcMs).toISOString(),
    endsBefore: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
};
