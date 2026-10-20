import { formatVndMillions } from "./format.ts";
import type { FinanceCloseCheck, FinanceVarianceLine } from "./types.ts";

/** Revenue channels are stored with their Vietnamese ledger names; the module is English. */
const CHANNEL_LABELS: Record<string, string> = {
  "ĐẠI LÝ": "Dealers",
  "BÁNH NGỌT": "Pastry accounts",
  "BÁNH NGỘT": "Pastry accounts",
  "B2B BMQ": "B2B accounts",
  "Retail Kiosk": "Retail kiosks",
};

export function channelLabel(code: string): string {
  return CHANNEL_LABELS[code] ?? code;
}

/** English label for any P&L or variance line. Revenue lines show the channel only. */
export function lineLabel(section: string, lineCode: string, label: string): string {
  if (section === "revenue" && label.startsWith("Revenue — ")) return channelLabel(lineCode);
  if (lineCode === "REVENUE_TOTAL") return "Revenue";
  return label.replace(/^Revenue — (.+)$/, (_, channel: string) => channelLabel(channel));
}

/** Whether a line is better when it rises (revenue and profit) or when it falls (costs). */
export function risesAreGood(section: string, lineCode: string): boolean {
  if (section === "revenue") return true;
  return lineCode === "GROSS_PROFIT" || lineCode === "EBITDA" || lineCode === "REVENUE_TOTAL";
}

export type Tone = "good" | "bad" | "neutral";

/** Colour says good or bad, never up or down; no change or no baseline stays neutral. */
export function deltaTone(section: string, lineCode: string, delta: number | null): Tone {
  if (delta === null || delta === 0) return "neutral";
  const up = delta > 0;
  return up === risesAreGood(section, lineCode) ? "good" : "bad";
}

export function signedMillions(value: number | null): string {
  if (value === null) return "—";
  const text = formatVndMillions(Math.abs(value)) ?? "—";
  if (value === 0) return text;
  return `${value > 0 ? "+" : "−"}${text}`;
}

/** Driver wording for a variance row; a line with no prior month is new, not unexplained. */
export function driverText(line: FinanceVarianceLine): string | null {
  if (!line.flagged) return null;
  if (line.flag_reason === "no_prior" || (line.prior === null && line.current !== null)) {
    return "New this month — no prior-month amount to compare.";
  }
  if (line.current === null && line.prior !== null) return "Nothing recorded this month.";
  return line.driver_text;
}

/** Three biggest leaf movements, in English, built from the lines as shown. */
export function varianceSummary(lines: FinanceVarianceLine[], month: string, priorMonth: string): string {
  const movers = lines
    .filter((line) => line.level === "leaf" && line.delta !== null && line.delta !== 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 3)
    .map((line) => `${lineLabel(line.section, line.line_code, line.label)} ${signedMillions(line.delta)}`);
  const head = `${monthName(month)} against ${monthName(priorMonth)}.`;
  return movers.length ? `${head} Biggest movements: ${movers.join(", ")}.` : `${head} No line moved.`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" -> "September 2026"; short -> "Sep". */
export function monthName(key: string, short = false): string {
  const [year, month] = key.split("-").map(Number);
  const name = MONTHS[(month || 1) - 1] ?? key;
  return short ? name.slice(0, 3) : `${name} ${year}`;
}

export interface CloseProgress {
  pass: number;
  total: number;
  attention: number;
}

/** Info checks are context, not steps; they are left out of the count. */
export function closeProgress(checks: FinanceCloseCheck[]): CloseProgress {
  const steps = checks.filter((check) => check.status !== "info");
  return {
    pass: steps.filter((check) => check.status === "pass").length,
    total: steps.length,
    attention: steps.filter((check) => check.status === "warn" || check.status === "fail").length,
  };
}

/** Round axis maximum and ticks for a column chart (zero baseline, 4 steps). */
export function niceScale(max: number, steps = 4): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / steps;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? raw;
  const top = unit * Math.ceil(max / unit) === max ? unit * (Math.ceil(max / unit) + 1) : unit * Math.ceil(max / unit);
  const ticks: number[] = [];
  for (let value = 0; value <= top + unit / 2; value += unit) ticks.push(value);
  return { top, ticks };
}
