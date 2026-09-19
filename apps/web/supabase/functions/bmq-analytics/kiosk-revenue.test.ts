import { test } from "node:test";
import assert from "node:assert/strict";
import { runWarehouse } from "./warehouse.ts";
import { presentResponse } from "./presentation.ts";
import { vnToday } from "./core.ts";

const signal = new AbortController().signal;
const usage = { input: 1, output: 1, cached: 0 };
const page = { route: "/analytics", label: "Phân tích" };
const catalog = {
  metrics: {
    kiosk_sales_revenue: { label: "Kiosk derived sales revenue", label_vi: "Doanh thu bán hàng điểm bán (suy ra)", unit: "VND", dimensions: ["date", "location", "channel"] },
    kiosk_reported_amount: { label: "Kiosk reported channel amount", label_vi: "Số tiền theo kênh báo cáo điểm bán", unit: "VND", dimensions: ["date", "location"] },
  },
  dimensions: { date: "date", location: "location", channel: "channel" },
  version: "test",
};
const queryResult = {
  metric: "kiosk_sales_revenue",
  rows: [
    { channel: "khach_le", currency: "VND", kiosk_sales_revenue: "9226000", quantity: "659", unit_price_vnd: 14000 },
    { channel: "grabfood", currency: "VND", kiosk_sales_revenue: "21882000", quantity: "1563", unit_price_vnd: 14000 },
    { channel: "shopeefood", currency: "VND", kiosk_sales_revenue: "22036000", quantity: "1574", unit_price_vnd: 14000 },
    { channel: "befood", currency: "VND", kiosk_sales_revenue: "132000", quantity: "11", unit_price_vnd: 12000 },
  ],
  truncated: false,
  total: "53276000",
  total_quantity: "3807",
  total_currency: "VND",
  period: { start: "2026-09-01", end: "2026-09-30" },
  source: "Supabase.kiosk_daily_reports + kiosk_daily_report_channel_rows + kiosk_report_locations",
  definition: "Derived kiosk sales revenue: SUM(channel quantity x trusted channel unit price), September 2026 only.",
  definition_vi: "Doanh thu bán hàng điểm bán suy ra: tổng (số lượng theo kênh x đơn giá kênh tin cậy), chỉ tháng 9/2026.",
  unit: "VND",
  semantic_version: "bmq-operational-v3",
  source_observed_at: "2026-09-20T00:00:00Z",
  snapshot_id: "s1",
};

function warehouseCall(record: (body: any) => void) {
  return async (path: string, body: any) => {
    if (path === "/v1/semantic") return catalog;
    assert.equal(path, "/v1/query");
    record(body);
    return structuredClone(queryResult);
  };
}

const noFx = async () => { throw new Error("FX must not load for Vietnamese output"); };

test("doanh thu điểm bán routes to derived kiosk sales revenue, never the reported amount", async () => {
  let body: any;
  let modelCalls = 0;
  const answer = await runWarehouse(
    { language: "vi", question: "doanh thu điểm bán hôm nay", page, history: [] },
    warehouseCall((request) => { body = request; }),
    async () => { modelCalls++; throw new Error("planner must not run on the exact route"); },
    signal,
  );
  assert.equal(modelCalls, 0);
  assert.deepEqual(body, { metric: "kiosk_sales_revenue", time_range: "today", dimensions: ["channel"], limit: 20 });
  assert.equal(answer.provenance.lane, "semantic");
  assert.match(answer.answer, /Doanh thu bán hàng điểm bán/);
  assert.match(answer.answer, /Khách lẻ/);
  assert.match(answer.answer, /GrabFood/);
  assert.match(answer.answer, /beFood/);
  assert.match(answer.answer, /Tổng: 53276000 VND/);
  // The displayed total is the exact backend period aggregate, not a sum of the rows.
  assert.match(answer.answer, /659 × 14000 VND/);
  assert.doesNotMatch(answer.answer, /Số tiền theo kênh báo cáo/);
});

test("kiosk revenue periods and accentless/English phrasings stay deterministic", async () => {
  for (const [question, period] of [
    ["doanh thu điểm bán", "today"],
    ["doanh thu diem ban thang nay", "this_month"],
    ["doanh thu bán hàng điểm bán tháng trước", "previous_month"],
    ["kiosk revenue today", "today"],
    ["kiosk sales revenue last month", "previous_month"],
  ] as [string, string][]) {
    let body: any;
    const answer = await runWarehouse(
      { language: "vi", question, page, history: [] },
      warehouseCall((request) => { body = request; }),
      async () => { throw new Error(`planner must not run for ${question}`); },
      signal,
    );
    assert.equal(body.metric, "kiosk_sales_revenue", question);
    assert.equal(body.time_range, period, question);
    assert.deepEqual(body.dimensions, ["channel"], question);
    assert.equal(answer.provenance.lane, "semantic", question);
  }
});

test("the screenshot question uses an explicit September window and renders the exact total", async () => {
  const year = vnToday().slice(0, 4);
  let body: any;
  const answer = await runWarehouse(
    { language: "vi", question: "Doanh thu điểm bán tháng 9 là bao nhiêu", page, history: [] },
    warehouseCall((request) => { body = request; }),
    async () => { throw new Error("planner must not run on the exact route"); },
    signal,
  );
  assert.equal(body.metric, "kiosk_sales_revenue");
  // The explicit month becomes an explicit whole-month range for the current year.
  assert.deepEqual(body.time_range, { start: `${year}-09-01`, end: `${year}-09-30` });
  assert.deepEqual(body.dimensions, ["channel"]);
  const presented = await presentResponse(answer, "vi", signal, noFx);
  assert.match(presented.answer, /Tổng: 53\.276\.000 ₫/);
  assert.match(presented.answer, /Khách lẻ: 9\.226\.000 ₫/);
  assert.doesNotMatch(presented.answer, /khach_le|shopeefood|grabfood|befood/);
});

test("an explicit year on the screenshot question is preserved, never stripped", async () => {
  let body: any;
  await runWarehouse(
    { language: "vi", question: "doanh thu điểm bán tháng 9 năm 2025", page, history: [] },
    warehouseCall((request) => { body = request; }),
    async () => { throw new Error("planner must not run on the exact route"); },
    signal,
  );
  assert.deepEqual(body.time_range, { start: "2025-09-01", end: "2025-09-30" });
});

test("qualified kiosk revenue questions are not silently narrowed by the fast route", async () => {
  let modelCalls = 0;
  const prompts: string[] = [];
  const answer = await runWarehouse(
    { language: "vi", question: "doanh thu điểm bán theo từng ngày", page, history: [] },
    warehouseCall(() => { throw new Error("no deterministic query expected"); }),
    async (instructions: string) => { modelCalls++; prompts.push(instructions); return { value: { lane: "abstain", queries: [], search: "", clarification: "Anh nêu rõ kỳ và phạm vi nhé." }, usage }; },
    signal,
  );
  assert.equal(modelCalls, 1);
  assert.equal(answer.provenance.lane, "abstain");
  assert.match(prompts[0], /kiosk_sales_revenue with dimension channel/);
  assert.match(prompts[0], /never use kiosk_reported_amount for a revenue question/);
});

test("kiosk presentation shows the backend exact total even when the channel list is truncated", async () => {
  const truncated = {
    ...structuredClone(queryResult),
    rows: structuredClone(queryResult.rows).slice(0, 2),
    truncated: true,
    total: "53276000",
  };
  const response = {
    answer: "raw",
    provenance: { lane: "semantic" },
    presentation: [{ kind: "metric", query: { metric: "kiosk_sales_revenue", dimensions: ["channel"], time_range: "2026-09-01/2026-09-30" }, result: truncated, descriptor: catalog.metrics.kiosk_sales_revenue }],
  };
  const presented = await presentResponse(response as any, "vi", signal, noFx);
  assert.match(presented.answer, /Tổng: 53\.276\.000 ₫/);
  assert.match(presented.answer, /một phần/);
  // The exact total is not the partial sum of the two displayed channel rows.
  assert.notEqual("53276000", String(Number(truncated.rows[0].kiosk_sales_revenue) + Number(truncated.rows[1].kiosk_sales_revenue)));
});

test("a mixed-price channel group is shown honestly, with no fabricated single price", async () => {
  const mixed = {
    ...structuredClone(queryResult),
    rows: [{ channel: "befood", currency: "VND", kiosk_sales_revenue: "260000", quantity: "20", unit_price_vnd: null }],
    total: "260000",
    total_quantity: "20",
  };
  const response = {
    answer: "raw",
    provenance: { lane: "semantic" },
    presentation: [{ kind: "metric", query: { metric: "kiosk_sales_revenue", dimensions: ["channel"], time_range: "2026-09-01/2026-09-30" }, result: mixed, descriptor: catalog.metrics.kiosk_sales_revenue }],
  };
  const presented = await presentResponse(response as any, "vi", signal, noFx);
  assert.match(presented.answer, /beFood: 260\.000 ₫/);
  assert.match(presented.answer, /20 × nhiều mức giá/);
  assert.doesNotMatch(presented.answer, /20 × 1[24]\.000/);
});

test("kiosk presentation preserves every requested dimension and never claims zero on empty data", async () => {
  const render = (rows: any[], dimensions: string[], total: string) => presentResponse({
    answer: "raw", provenance: { lane: "semantic" },
    presentation: [{ kind: "metric", query: { metric: "kiosk_sales_revenue", dimensions }, descriptor: catalog.metrics.kiosk_sales_revenue,
      result: { rows, total, total_currency: "VND", truncated: false, period: { start: "2026-09-01", end: "2026-09-30" } } }],
  } as any, "vi", signal, noFx);
  const daily = await render([{ date: "2026-09-14", currency: "VND", quantity: "1", unit_price_vnd: 14000, kiosk_sales_revenue: "14000" }], ["date"], "14000");
  assert.match(daily.answer, /2026-09-14/);
  const located = await render([{ location: "HCM005-TN", channel: "grabfood", currency: "VND", quantity: "1", unit_price_vnd: 14000, kiosk_sales_revenue: "14000" }], ["location", "channel"], "14000");
  assert.match(located.answer, /HCM005-TN/);
  assert.match(located.answer, /GrabFood/);
  const empty = await render([], ["channel"], "0");
  assert.doesNotMatch(empty.answer, /Tổng: 0/);
  assert.match(empty.answer, /không đồng nghĩa bằng 0/);
});

test("English kiosk presentation keeps friendly labels and an explicit total", async () => {
  const response = {
    answer: "raw",
    provenance: { lane: "semantic" },
    presentation: [{ kind: "metric", query: { metric: "kiosk_sales_revenue", dimensions: ["channel"], time_range: "2026-09-01/2026-09-30" }, result: structuredClone(queryResult), descriptor: catalog.metrics.kiosk_sales_revenue }],
  };
  const presented = await presentResponse(response as any, "en", signal, async () => null);
  assert.match(presented.answer, /Total:/);
  assert.match(presented.answer, /Walk-in retail/);
  assert.match(presented.answer, /ShopeeFood/);
  assert.doesNotMatch(presented.answer, /khach_le/);
});

test("a malformed or missing exact total fails closed instead of falling back to row sums", async () => {
  await assert.rejects(
    () => runWarehouse(
      { language: "vi", question: "doanh thu điểm bán hôm nay", page, history: [] },
      async (path: string) => path === "/v1/semantic" ? catalog : { ...structuredClone(queryResult), total: undefined },
      async () => { throw new Error("planner must not run"); },
      signal,
    ),
    /invalid_result/,
  );
});

test("a warehouse without the derived metric does not fast-route kiosk revenue", async () => {
  let modelCalls = 0;
  const legacyCatalog = { metrics: { kiosk_reported_amount: catalog.metrics.kiosk_reported_amount }, dimensions: { date: "date", location: "location" }, version: "test" };
  const answer = await runWarehouse(
    { language: "vi", question: "doanh thu điểm bán hôm nay", page, history: [] },
    async (path: string) => path === "/v1/semantic" ? legacyCatalog : (() => { throw new Error("unexpected query"); })(),
    async () => { modelCalls++; return { value: { lane: "abstain", queries: [], search: "", clarification: "Chưa có chỉ số doanh thu điểm bán." }, usage }; },
    signal,
  );
  assert.equal(modelCalls, 1);
  assert.equal(answer.provenance.lane, "abstain");
});
