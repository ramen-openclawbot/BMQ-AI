// Display helpers for Kho văn phòng (vi-VN numbers, dd/mm dates from YYYY-MM-DD without time-zone shifts).
const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

export const fmtNum = (n: number) => nf.format(n);
export const fmtMoney = (n: number) => `${nf.format(Math.round(n))}đ`;
export function fmtMillion(n: number) {
  if (n >= 1e6) return `${nf.format(Math.round(n / 1e5) / 10)} triệu`;
  if (n >= 1e3) return `${nf.format(Math.round(n / 1e3))} nghìn`;
  return fmtMoney(n);
}
/** "2026-10-12" -> "12/10"; read as text so a phone on another time zone never shows the day before. */
export const fmtDate = (d: string | null | undefined) => (d && d.length >= 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "—");

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function dayDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const pa = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const pb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((pb - pa) / 86400000);
}
