const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a DB value for display. A Postgres `date` ("2026-10-06") is a calendar day, so it becomes local
 * midnight of that day; `new Date("2026-10-06")` would be UTC midnight and show 05/10 on a phone set to a
 * US time zone (owner 14/10, GRN-000568). Timestamps keep the normal parse.
 */
export function parseDbDate(raw: string): Date {
  const match = DATE_ONLY.exec(raw);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(raw);
}
