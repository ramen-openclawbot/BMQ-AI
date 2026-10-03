import assert from "node:assert/strict";
import test from "node:test";

import { summarizeApprovalResults } from "./approval-results.ts";

test("counts every fulfilled approval and nothing else", () => {
  const summary = summarizeApprovalResults(
    ["a", "b", "c"],
    [
      { status: "fulfilled", value: { approved: true } },
      { status: "fulfilled", value: { approved: true } },
      { status: "fulfilled", value: { approved: true } },
    ],
  );
  assert.deepEqual(summary, { count: 3, approved: 3, failed: [] });
});

test("mixed partial success keeps each failed id and message", () => {
  const summary = summarizeApprovalResults(
    ["ok", "boom", "not-approved"],
    [
      { status: "fulfilled", value: { approved: true } },
      { status: "rejected", reason: new Error("material not ready") },
      { status: "fulfilled", value: { approved: false } },
    ],
  );
  assert.equal(summary.count, 3);
  assert.equal(summary.approved, 1);
  assert.deepEqual(summary.failed, [
    { id: "boom", message: "material not ready" },
    { id: "not-approved", message: "Không duyệt được phiếu" },
  ]);
});

test("never counts a rejected request as approved", () => {
  const summary = summarizeApprovalResults(
    ["a", "b"],
    [
      { status: "rejected", reason: "network down" },
      { status: "rejected", reason: new Error("permission denied") },
    ],
  );
  assert.equal(summary.approved, 0);
  assert.deepEqual(summary.failed, [
    { id: "a", message: "network down" },
    { id: "b", message: "permission denied" },
  ]);
});

test("reads a structured error message and handles a missing result", () => {
  const summary = summarizeApprovalResults(
    ["a", "b"],
    [
      { status: "rejected", reason: { message: "has_payments" } },
      undefined as unknown as PromiseSettledResult<{ approved: boolean }>,
    ],
  );
  assert.equal(summary.approved, 0);
  assert.deepEqual(summary.failed, [
    { id: "a", message: "has_payments" },
    { id: "b", message: "Không nhận được kết quả duyệt" },
  ]);
});
