import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRequest, parseAnalyticsResponse, readAnalyticsError, type AnalyticsMessage } from "./bmqAnalytics.ts";

test("request contains only current page and last six role/text messages, never IDs or credentials", () => {
  const history: AnalyticsMessage[] = Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`, role: index % 2 ? "assistant" : "user", text: `message ${index}` }));
  const request = buildAnalyticsRequest(" Doanh thu? ", "/finance-control/revenue", "Doanh thu", history);
  assert.equal(request.question, "Doanh thu?");
  assert.deepEqual(request.page, { route: "/finance-control/revenue", label: "Doanh thu", filters: {} });
  assert.equal(request.history.length, 6);
  assert.deepEqual(request.history[0], { role: "user", text: "message 4" });
  assert.deepEqual(Object.keys(request).sort(), ["history", "page", "question"]);
});

test("history is bounded and does not mutate displayed messages", () => {
  const history: AnalyticsMessage[] = [{ id: "1", role: "assistant", text: "a".repeat(10000) }];
  assert.equal(buildAnalyticsRequest("x", "/", "BMQ", history).history[0].text.length, 2000);
  assert.equal(history[0].text.length, 10000);
});

test("malformed or error-only responses cannot appear as successful answers", () => {
  for (const payload of [null, { answer: "" }, { error: "denied" }, { answer: "fake", requestId: "1" }]) {
    assert.throws(() => parseAnalyticsResponse(payload), /chưa hợp lệ/);
  }
  const result = parseAnalyticsResponse({ answer: "Kết quả", requestId: "r1", provenance: { lane: "fast", model: null, queries: [], elapsedMs: 23 } });
  assert.equal(result.answer, "Kết quả");
});


test("selected filters are retained separately from the current route", () => {
  assert.deepEqual(buildAnalyticsRequest("Doanh thu", "/finance-control/revenue", "Doanh thu", [], { period: "2026-09", status: "posted" }).page,
    { route: "/finance-control/revenue", label: "Doanh thu", filters: { period: "2026-09", status: "posted" } });
});

test("HTTP guidance is bounded and malformed or network errors stay generic", async () => {
  const guidance = await readAnalyticsError({ context: Response.json({ error: "Luna chưa cấu hình" }) });
  assert.equal(guidance, "Luna chưa cấu hình");
  assert.equal((await readAnalyticsError({ context: Response.json({ error: "a".repeat(700) }) })).length, 500);
  for (const error of [new Error("raw transport details"), { context: new Response("not JSON") }, { context: Response.json({ error: { stack: "internal" } }) }]) {
    assert.equal(await readAnalyticsError(error), "Chưa gửi được câu hỏi tới BMQ. Vui lòng thử lại.");
  }
});
