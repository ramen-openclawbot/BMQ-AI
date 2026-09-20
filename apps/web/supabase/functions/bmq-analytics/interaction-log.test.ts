// Offline tests for BMQ analytics interaction capture: per-event identity,
// nested secret redaction, separate known/unknown usage with NULL unknowns,
// executed-vs-page filters, original answer reference and REAL Jev telemetry.
import test from "node:test";
import assert from "node:assert/strict";
import { buildInteractionRecord, buildJevRow, minimizeContext, redactSecrets, sanitizeNested, RETENTION_DAYS, type CaptureEvent } from "./interaction-log.ts";

const NOW = new Date("2026-09-20T03:00:00.000Z");

function event(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    requestId: "req-1234",
    identity: { userId: "owner-1" },
    body: {
      language: "vi",
      question: "Doanh thu hôm nay?",
      conversationId: "conv-12345678",
      page: { route: "/finance-control/revenue", label: "Doanh thu", filters: { range: "today" } },
      history: [{ role: "user", text: "secret previous text" }, { role: "assistant", text: "old answer" }],
    },
    presented: {
      answer: "Doanh thu có kiểm soát hôm nay là 1.000.000đ",
      provenance: {
        lane: "fast",
        model: null,
        queries: [{ metric: "controlled_revenue", time_range: "today", dimensions: ["channel"], limit: 20 }],
        modelCalls: 0,
        usage: { input: 0, output: 0 },
        elapsedMs: 12,
        cacheHits: 0,
        semanticVersion: "bmq-analytics-v1",
      },
    },
    status: "success",
    now: NOW,
    ...overrides,
  };
}

test("successful capture preserves the requestId, final question, answer and executed filters", async () => {
  const row = await buildInteractionRecord(event());
  assert.equal(row.request_id, "req-1234");
  assert.equal(row.question_text, "Doanh thu hôm nay?");
  assert.equal(row.answer_text, "Doanh thu có kiểm soát hôm nay là 1.000.000đ");
  assert.equal(row.response_status, "success");
  assert.equal(row.known_usage.answered, true);
  assert.equal(row.unknown_usage.unresolved, false);
  assert.equal(row.model_route, "fast");
  assert.equal(row.source_route, "/finance-control/revenue");
  // Page filters are context; executed filters are what actually ran.
  assert.deepEqual(row.page_filters, { range: "today" });
  assert.deepEqual(row.executed_filters, { metrics: ["controlled_revenue"], periods: ["today"], dimensions: ["channel"], queryCount: 1 });
  assert.deepEqual(row.understood_intent.metrics, ["controlled_revenue"]);
  assert.equal(row.capture_status, "captured");
  const retentionDays = (Date.parse(row.retention_expires_at) - NOW.getTime()) / 86_400_000;
  assert.equal(retentionDays, RETENTION_DAYS);
});

test("unknown usage numbers stay null instead of being fabricated as zero", async () => {
  const row = await buildInteractionRecord(event({ status: "error", responseCode: "timeout", presented: null, body: { question: "Doanh thu?" } }));
  assert.equal(row.known_usage.tokens, null);
  assert.equal(row.known_usage.modelCalls, null);
  assert.equal(row.known_usage.elapsedMs, null);
  assert.equal(row.known_usage.cacheHits, null);
  assert.equal(row.known_usage.queryCount, 0);
});

test("distinct real error events keep distinct identities", async () => {
  const base = event({ status: "error", responseCode: "timeout", presented: null });
  const a = await buildInteractionRecord({ ...base, requestId: "event-a" });
  const b = await buildInteractionRecord({ ...base, requestId: "event-b" });
  assert.equal(a.request_id, "event-a");
  assert.notEqual(a.request_id, b.request_id);
  assert.doesNotMatch(a.request_id, /^err-[0-9a-f]{40}$/);
  // No caller identity at all still yields a unique per-event id.
  const generatedA = await buildInteractionRecord({ ...base, requestId: "" });
  const generatedB = await buildInteractionRecord({ ...base, requestId: "" });
  assert.match(generatedA.request_id, /^err-/);
  assert.notEqual(generatedA.request_id, generatedB.request_id);
  assert.equal(generatedA.response_status, "error");
  assert.equal(generatedA.unknown_usage.errored, true);
});

test("context minimization never stores history text or question text", () => {
  const context = minimizeContext(event().body);
  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes("secret previous text"));
  assert.ok(!serialized.includes("Doanh thu hôm nay?"));
  assert.equal(context.historyCount, 2);
  assert.deepEqual(context.filterKeys, ["range"]);
});

test("obvious secrets are redacted and flagged", async () => {
  const row = await buildInteractionRecord(event({ body: { question: "token Bearer abcdefgh1234567890 và password=hunter2" } }));
  assert.ok(!row.question_text.includes("abcdefgh1234567890"));
  assert.ok(!row.question_text.includes("hunter2"));
  assert.equal(row.redaction_applied, true);
  assert.equal(row.capture_status, "redacted");
});

test("nested metadata is sanitized too, not only the question", async () => {
  const row = await buildInteractionRecord(event({
    body: { question: "ok", page: { filters: { token: "Bearer abcdefgh1234567890" } } },
    presented: { provenance: { lane: "fast", semanticVersion: "api_key=SECRETVALUE12345", queries: [] } },
  }));
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("abcdefgh1234567890"));
  assert.ok(!serialized.includes("SECRETVALUE12345"));
  assert.equal(sanitizeNested({ nested: { password: "hunter2" } }) !== null, true);
  const sanitized = sanitizeNested({ nested: { password: "hunter2" } }) as { nested: { password: string } };
  assert.equal(sanitized.nested.password, "[redacted]");
});

test("abstained answers are recorded as unknown, not as successful usage", async () => {
  const row = await buildInteractionRecord(event({
    status: "abstained",
    presented: { provenance: { lane: "abstain", queries: [], model: null, modelCalls: 1 } },
  }));
  assert.equal(row.response_status, "abstained");
  assert.equal(row.known_usage.answered, false);
  assert.equal(row.unknown_usage.abstained, true);
  assert.equal(row.unknown_usage.unresolved, true);
});

test("question text is bounded and an empty question cannot break the not-null column", async () => {
  const row = await buildInteractionRecord(event({ body: { question: "   " } }));
  assert.equal(row.question_text, "(empty question)");
  assert.equal(row.answer_text, "Doanh thu có kiểm soát hôm nay là 1.000.000đ");
});

test("REAL Jev telemetry is extracted from usage/timings/counts and absent when not supplied", () => {
  assert.equal(buildJevRow(event()), null);
  const row = buildJevRow(event({
    presented: {
      provenance: {
        jev: {
          model: "jev-1", promptVersion: "p3", registryVersion: "r7",
          attempted: true, decided: true, screen: "pass", circuit: "closed",
          metric: "dealer_order_count", metricProbability: 0.99,
          period: "this_week", periodProbability: 0.98,
          support: "supported_unqualified", supportProbability: 0.97,
          threshold: 0.8, fallback: null, cost: null,
          usage: { input: 500, output: 20 },
          timings: { totalMs: 200, providerMs: 120 },
          counts: { warehouseReads: 2, plannerCalls: 1, narrationCalls: 0 },
        },
      },
    },
  }));
  assert.ok(row);
  assert.equal(row?.request_id, "req-1234");
  assert.equal(row?.metric, "dealer_order_count");
  assert.equal(row?.metric_probability, 0.99);
  assert.equal(row?.period, "this_week");
  assert.equal(row?.support, "supported_unqualified");
  assert.equal(row?.prompt_version, "p3");
  assert.equal(row?.registry_version, "r7");
  assert.equal(row?.attempted, true);
  assert.deepEqual(row?.token_counts, { input: 500, output: 20 });
  assert.equal(row?.stage_timings.totalMs, 200);
  assert.equal(row?.counts.warehouseReads, 2);
  assert.equal(row?.cost, null);
  assert.equal(row?.decision, "dealer_order_count");
  assert.ok(JSON.stringify(row).includes("dealer_order_count"));
});

test("Jev cost is preserved when known and unknown values stay null", () => {
  const row = buildJevRow(event({ presented: { provenance: { jev: { metric: "m", cost: 0.0021, usage: { input: 10 }, timings: {} } } } }));
  assert.equal(row?.cost, 0.0021);
  assert.equal(row?.token_counts.output, null);
  assert.equal(row?.metric_probability, null);
});

test("redactSecrets reports no change for clean text", () => {
  assert.deepEqual(redactSecrets("Doanh thu hôm nay?"), { text: "Doanh thu hôm nay?", redacted: false });
});

test('capture keeps bounded citation and snapshot source references for later verification', async () => {
  const row = await buildInteractionRecord(event({ presented: {
    provenance: {
      semanticVersion: 'warehouse-fixture-v1',
      citations: ['chunk-fixture-1'],
      evidence: [{ source: 'fixture-source', snapshot_id: 'snapshot-fixture-1', source_observed_at: '2026-09-20T03:00:00Z', authorization: 'never-store-this' }],
    },
  } }));
  assert.deepEqual(row.provenance.citations, ['chunk-fixture-1']);
  assert.deepEqual(row.provenance.evidence, [{ source: 'fixture-source', snapshot_id: 'snapshot-fixture-1', source_observed_at: '2026-09-20T03:00:00Z', authorization: '[redacted]' }]);
  assert.equal(JSON.stringify(row).includes('never-store-this'), false);
});
