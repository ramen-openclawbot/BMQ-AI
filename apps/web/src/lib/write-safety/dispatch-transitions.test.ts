import assert from "node:assert/strict";
import test from "node:test";

import { DISPATCH_STATUSES, canTransition, nextStatus } from "./dispatch-transitions.ts";

test("allows only the ordered forward transitions", () => {
  assert.equal(canTransition("pending", "picked"), true);
  assert.equal(canTransition("picked", "dispatched"), true);
  assert.equal(canTransition("dispatched", "delivered"), true);
});

test("rejects skipped and backward transitions", () => {
  assert.equal(canTransition("pending", "dispatched"), false);
  assert.equal(canTransition("pending", "delivered"), false);
  assert.equal(canTransition("picked", "pending"), false);
  assert.equal(canTransition("dispatched", "picked"), false);
  assert.equal(canTransition("delivered", "dispatched"), false);
});

test("rejects unknown statuses", () => {
  assert.equal(canTransition("draft", "picked"), false);
  assert.equal(canTransition("pending", "bogus"), false);
  assert.equal(canTransition("", ""), false);
});

test("repeating the current status is an idempotent no-op", () => {
  for (const status of DISPATCH_STATUSES) {
    assert.equal(canTransition(status, status), true);
  }
});

test("nextStatus follows the ordered flow and stops at delivered", () => {
  assert.equal(nextStatus("pending"), "picked");
  assert.equal(nextStatus("picked"), "dispatched");
  assert.equal(nextStatus("dispatched"), "delivered");
  assert.equal(nextStatus("delivered"), null);
  assert.equal(nextStatus("unknown"), null);
});
