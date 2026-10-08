// Issue review decisions for the Bếp BN attendance.
//
// The anomaly detector flags everything; this module records what a human
// decided about the reviewable flags and turns those decisions into the rows
// actually fed to the payroll engine. An `accepted` decision keeps the row as
// is (a missing check-out still counts one công, as on the hand-made sheet);
// an `excluded` decision drops that employee's row for that date.
//
// Pure and dependency-free so it can be unit-tested with node:test.

import type { Anomaly, AnomalyCode } from "./anomalies.ts";
import type { AttendanceRow } from "./types.ts";

export type IssueDecision = "accepted" | "excluded";

export interface IssueReview {
  employeeCode: string;
  /** YYYY-MM-DD. */
  workDate: string;
  issueCode: AnomalyCode;
  decision: IssueDecision;
  /** Required (non-blank) when the decision is `excluded`. */
  note: string | null;
}

/** The anomaly codes a human has to decide on before approving attendance. */
export const REVIEWABLE_ISSUE_CODES: readonly AnomalyCode[] = [
  "missing_check_out",
  "missing_check_in",
  "no_machine_data",
  "duplicate_time",
  "holiday_attendance",
];

const REVIEWABLE = new Set<AnomalyCode>(REVIEWABLE_ISSUE_CODES);

/** Stable key shared by an anomaly and the review that resolves it. */
export function issueKey(anomaly: Pick<Anomaly, "code" | "employeeCode" | "date">): string {
  return `${anomaly.code}|${anomaly.employeeCode}|${anomaly.date ?? ""}`;
}

/** Same key shape as issueKey, for a persisted review. */
export function reviewKey(review: Pick<IssueReview, "issueCode" | "employeeCode" | "workDate">): string {
  return `${review.issueCode}|${review.employeeCode}|${review.workDate}`;
}

/**
 * Only dated anomalies of a reviewable code block approval. `unknown_employee`
 * and `missing_attendance` are fixed in the catalogue instead.
 */
export function requiresReview(anomaly: Anomaly): boolean {
  return anomaly.date !== null && REVIEWABLE.has(anomaly.code);
}

/**
 * The rows used for payroll: a row disappears only when an `excluded` review
 * matches its employee code and date. Everything else is returned untouched.
 */
export function applyIssueReviews(
  rows: readonly AttendanceRow[],
  reviews: readonly IssueReview[],
): AttendanceRow[] {
  const excluded = new Set<string>();
  for (const review of reviews) {
    if (review.decision === "excluded") {
      excluded.add(`${review.employeeCode}|${review.workDate}`);
    }
  }
  return rows.filter((row) => !excluded.has(`${row.employeeCode}|${row.date}`));
}

export interface IssueSummary {
  total: number;
  reviewed: number;
  pending: number;
  pendingKeys: string[];
}

/** Count the reviewable anomalies that still need a decision. */
export function summarizeIssues(
  anomalies: readonly Anomaly[],
  reviews: readonly IssueReview[],
): IssueSummary {
  const reviewedKeys = new Set(reviews.map((review) => reviewKey(review)));
  const pendingKeys: string[] = [];
  let total = 0;
  let reviewed = 0;

  for (const anomaly of anomalies) {
    if (!requiresReview(anomaly)) continue;
    total += 1;
    const key = issueKey(anomaly);
    if (reviewedKeys.has(key)) reviewed += 1;
    else pendingKeys.push(key);
  }

  return { total, reviewed, pending: pendingKeys.length, pendingKeys };
}
