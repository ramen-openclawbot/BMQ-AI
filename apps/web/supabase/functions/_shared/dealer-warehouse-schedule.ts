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
