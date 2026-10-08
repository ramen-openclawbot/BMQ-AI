import assert from "node:assert/strict";
import test from "node:test";

import {
  applyIssueReviews,
  issueKey,
  requiresReview,
  reviewKey,
  summarizeIssues,
  type IssueReview,
} from "./issue-review.ts";
import type { Anomaly } from "./anomalies.ts";
import type { AttendanceRow } from "./types.ts";

function anomaly(overrides: Partial<Anomaly> & { code: Anomaly["code"]; employeeCode: string }): Anomaly {
  return {
    severity: "warning",
    employeeName: null,
    date: "2026-09-03",
    detail: "test",
    ...overrides,
  };
}

function attendance(employeeCode: string, date: string): AttendanceRow {
  return {
    employeeCode,
    employeeName: `NV ${employeeCode}`,
    date,
    checkIn: "08:00:00",
    checkOut: "17:00:00",
    department: null,
  };
}

function review(overrides: Partial<IssueReview> & Pick<IssueReview, "employeeCode" | "workDate" | "issueCode" | "decision">): IssueReview {
  return { note: null, ...overrides };
}

test("issueKey is code|employeeCode|date and tolerates a null date", () => {
  assert.equal(
    issueKey(anomaly({ code: "missing_check_out", employeeCode: "00025", date: "2026-09-03" })),
    "missing_check_out|00025|2026-09-03",
  );
  assert.equal(
    issueKey(anomaly({ code: "missing_attendance", employeeCode: "00025", date: null })),
    "missing_attendance|00025|",
  );
  assert.equal(
    reviewKey(review({ employeeCode: "00025", workDate: "2026-09-03", issueCode: "missing_check_out", decision: "accepted" })),
    "missing_check_out|00025|2026-09-03",
  );
});

test("applyIssueReviews drops only excluded employee/date rows and never mutates others", () => {
  const rows = [
    attendance("00025", "2026-09-03"),
    attendance("00025", "2026-09-04"),
    attendance("00026", "2026-09-03"),
  ];
  const before = JSON.stringify(rows);

  const kept = applyIssueReviews(rows, [
    review({ employeeCode: "00025", workDate: "2026-09-03", issueCode: "missing_check_out", decision: "excluded", note: "chốt lương" }),
    review({ employeeCode: "00026", workDate: "2026-09-03", issueCode: "missing_check_in", decision: "accepted" }),
  ]);

  assert.deepEqual(
    kept.map((row) => `${row.employeeCode}|${row.date}`),
    ["00025|2026-09-04", "00026|2026-09-03"],
  );
  assert.equal(JSON.stringify(rows), before);
});

test("summarizeIssues only counts dated, reviewable anomalies", () => {
  const anomalies: Anomaly[] = [
    anomaly({ code: "missing_check_out", employeeCode: "00025", date: "2026-09-03" }),
    anomaly({ code: "missing_check_in", employeeCode: "00025", date: "2026-09-04" }),
    anomaly({ code: "holiday_attendance", employeeCode: "00026", date: "2026-09-02" }),
    // Fixed in the catalogue, they do not block approval.
    anomaly({ code: "unknown_employee", employeeCode: "00099", date: "2026-09-05" }),
    anomaly({ code: "missing_attendance", employeeCode: "00027", date: null }),
  ];

  const summary = summarizeIssues(anomalies, [
    review({ employeeCode: "00025", workDate: "2026-09-03", issueCode: "missing_check_out", decision: "accepted" }),
    review({ employeeCode: "00026", workDate: "2026-09-02", issueCode: "holiday_attendance", decision: "excluded", note: "lễ" }),
    // A review for a non-reviewable code must not count either.
    review({ employeeCode: "00099", workDate: "2026-09-05", issueCode: "unknown_employee", decision: "accepted" }),
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.reviewed, 2);
  assert.equal(summary.pending, 1);
  assert.deepEqual(summary.pendingKeys, ["missing_check_in|00025|2026-09-04"]);
});

test("requiresReview excludes non-reviewable codes and undated anomalies", () => {
  assert.equal(requiresReview(anomaly({ code: "no_machine_data", employeeCode: "1", date: "2026-09-01" })), true);
  assert.equal(requiresReview(anomaly({ code: "unknown_employee", employeeCode: "1", date: "2026-09-01" })), false);
  assert.equal(requiresReview(anomaly({ code: "missing_attendance", employeeCode: "1", date: null })), false);
});
