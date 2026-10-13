import assert from "node:assert/strict";
import test from "node:test";

import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE, isAiQuotaError } from "./ai-errors.ts";

test("detects the structured edge code", () => {
  assert.equal(isAiQuotaError({ success: false, code: AI_QUOTA_CODE, error: AI_QUOTA_MESSAGE }), true);
  assert.equal(isAiQuotaError({ code: AI_QUOTA_CODE }), true);
});

test("detects the code nested in an error/detail object", () => {
  assert.equal(isAiQuotaError({ error: { code: "insufficient_quota" } }), true);
  assert.equal(isAiQuotaError({ detail: "ai_quota_exhausted: upstream 503" }), true);
});

test("detects a PostgREST-style detail string with the code prefix", () => {
  assert.equal(isAiQuotaError({ detail: "PGRST202: ai_quota_exhausted" }), true);
  assert.equal(isAiQuotaError("postgrest error: insufficient_quota"), true);
});

test("detects a raw insufficient_quota string", () => {
  assert.equal(isAiQuotaError("insufficient_quota"), true);
  assert.equal(isAiQuotaError('{"error":{"type":"insufficient_quota"}}'), true);
});

test("ignores unrelated errors and empty values", () => {
  assert.equal(isAiQuotaError({ code: "not_owner", error: "Forbidden" }), false);
  assert.equal(isAiQuotaError("Edge Function returned a non-2xx status code"), false);
  assert.equal(isAiQuotaError(null), false);
  assert.equal(isAiQuotaError(undefined), false);
  assert.equal(isAiQuotaError(new Error("network timeout")), false);
});
