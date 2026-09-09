import assert from "node:assert/strict";
import test from "node:test";
import { validateDataFile, dataSourcesSchema, DATA_FILE_LIMIT, DATA_REQUIRED_FIELDS, DATA_ENTITIES } from "./bmqDataSources.ts";
import { parseAnalyticsResponse, buildAnalyticsRequest } from "./bmqAnalytics.ts";
test("uploads enforce type, non-empty size and 1 MiB limit before transfer", () => {
  for (const name of ["a.csv", "A.JSON"]) assert.doesNotThrow(() => validateDataFile({ name, size: 30 }, "dataset", "en"));
  assert.doesNotThrow(() => validateDataFile({ name: "guide.md", size: DATA_FILE_LIMIT }, "document", "vi"));
  for (const file of [{ name: "x.csv", size: 0 }, { name: "x.json", size: DATA_FILE_LIMIT + 1 }, { name: "x.exe", size: 20 }]) assert.throws(() => validateDataFile(file, "dataset", "en"));
  assert.throws(() => validateDataFile({ name: "guide.md", size: 10 }, "dataset", "en"));
});
test("source schema keeps failed validation evidence and freshness", () => {
  const source = { id: "s1", source: "pos", entity: "orders", filename: "orders.csv", records: 0, status: "rejected", ingested_at: "2026-09-09T00:00:00Z", kind: "dataset", error: "Missing product" };
  assert.equal(dataSourcesSchema.parse({ sources: [source] }).sources[0].error, "Missing product");
  assert.throws(() => dataSourcesSchema.parse({ sources: [{ ...source, records: "unknown" }] }));
  assert.equal(Object.keys(DATA_REQUIRED_FIELDS).length, DATA_ENTITIES.length);
});
test("knowledge citations remain visible metadata but are never sent back as chat history", () => {
  const citations = [{ id: "k1", title: "Operations", source: "manual", updated_at: "2026-09-09" }];
  const result = parseAnalyticsResponse({ answer: "From [k1]", requestId: "r", provenance: { lane: "knowledge", model: "gpt-5.6-luna", queries: [], elapsedMs: 20, citations } });
  assert.deepEqual(result.provenance.citations, citations);
  assert.deepEqual(buildAnalyticsRequest("next", "/", "BMQ", [{ id: "r", role: "assistant", text: result.answer, citations }]).history, [{ role: "assistant", text: result.answer }]);
});
