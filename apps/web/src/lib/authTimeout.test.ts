// Offline tests for the bounded auth-call helper.
import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_CALL_TIMEOUT_MS, withAuthTimeout } from "./authTimeout.ts";

test("resolves a settling promise and keeps its value", async () => {
  assert.equal(await withAuthTimeout(Promise.resolve(7)), 7);
});

test("propagates the original rejection", async () => {
  await assert.rejects(withAuthTimeout(Promise.reject(new Error("boom"))), /boom/);
});

test("a promise that never settles times out instead of hanging", async () => {
  await assert.rejects(withAuthTimeout(new Promise(() => {}), 20), /auth-timeout/);
});

test("a late resolution after timeout cannot revive the result", async () => {
  let release;
  const stuck = new Promise((resolve) => {
    release = resolve;
  });
  await assert.rejects(withAuthTimeout(stuck, 20), /auth-timeout/);
  release("late");
});

test("default bound is 8s", () => {
  assert.equal(AUTH_CALL_TIMEOUT_MS, 8000);
});
