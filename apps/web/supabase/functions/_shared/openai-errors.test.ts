import {
  AI_QUOTA_CODE,
  AI_QUOTA_MESSAGE,
  AI_RATE_LIMIT_CODE,
  AI_RATE_LIMIT_MESSAGE,
  AI_UPSTREAM_CODE,
  aiErrorJson,
  classifyOpenAIError,
  getAiErrorInfo,
  AiOpenAIError,
} from "./openai-errors.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = "values differ"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("insufficient_quota body maps to ai_quota_exhausted / 503", () => {
  const info = classifyOpenAIError(
    429,
    JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }),
  );
  assertEqual(info.kind, "quota");
  assertEqual(info.code, AI_QUOTA_CODE);
  assertEqual(info.httpStatus, 503);
  assertEqual(info.message, AI_QUOTA_MESSAGE);
  const body = aiErrorJson(info);
  assertEqual(body.success, false);
  assertEqual(body.code, AI_QUOTA_CODE);
  assertEqual(body.error, AI_QUOTA_MESSAGE);
});

Deno.test("plain 429 rate limit maps to ai_rate_limited", () => {
  const info = classifyOpenAIError(429, JSON.stringify({ error: { message: "Rate limit reached" } }));
  assertEqual(info.kind, "rate_limit");
  assertEqual(info.code, AI_RATE_LIMIT_CODE);
  assertEqual(info.httpStatus, 429);
  assertEqual(info.message, AI_RATE_LIMIT_MESSAGE);
});

Deno.test("500 maps to ai_upstream_error / 502", () => {
  const info = classifyOpenAIError(500, "internal server error");
  assertEqual(info.kind, "other");
  assertEqual(info.code, AI_UPSTREAM_CODE);
  assertEqual(info.httpStatus, 502);
});

Deno.test("billing_hard_limit and exceeded quota text also count as quota", () => {
  assertEqual(classifyOpenAIError(400, '{"code":"billing_hard_limit_reached"}').code, AI_QUOTA_CODE);
  assertEqual(
    classifyOpenAIError(429, "You exceeded your current quota, please check your plan").code,
    AI_QUOTA_CODE,
  );
});

Deno.test("DeepSeek 402 Insufficient Balance maps to ai_quota_exhausted / 503", () => {
  const info = classifyOpenAIError(
    402,
    JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }),
  );
  assertEqual(info.kind, "quota");
  assertEqual(info.code, AI_QUOTA_CODE);
  assertEqual(info.httpStatus, 503);
  assertEqual(info.message, AI_QUOTA_MESSAGE);
});

Deno.test("body insufficient balance (any case) counts as quota even without 402", () => {
  assertEqual(
    classifyOpenAIError(400, '{"error":{"message":"Insufficient Balance"}}').code,
    AI_QUOTA_CODE,
  );
});

Deno.test("plain 402 without a known body pattern still counts as quota", () => {
  assertEqual(classifyOpenAIError(402, "payment required").code, AI_QUOTA_CODE);
});

Deno.test("AiOpenAIError carries code and info for callers", () => {
  const error = new AiOpenAIError(classifyOpenAIError(429, "insufficient_quota"));
  assertEqual(error.code, AI_QUOTA_CODE);
  assertEqual(error.httpStatus, 503);
  assertEqual(getAiErrorInfo(error)?.code, AI_QUOTA_CODE);
});
