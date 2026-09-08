import { test } from "node:test";
import assert from "node:assert/strict";
import { executeQuery } from "./data.ts";

type Row = Record<string, any>;
function database(tables: Record<string, Row[]>, options: { cap?: number; error?: boolean; changeCount?: boolean } = {}) {
  const calls: Array<{ table: string; filters: unknown[]; select?: string }> = [];
  let reads = 0;
  return {
    calls,
    from(table: string) {
      const call = { table, filters: [] as unknown[], select: "" };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      let lo = 0, hi = 499;
      const get = (r: Row, k: string) => k.split(".").reduce((o, key) => o?.[key], r as any);
      const builder = {
        select(columns: string, opts: unknown) { call.select = columns; assert.deepEqual(opts, { count: "exact" }); return this; },
        eq(k: string, v: unknown) { call.filters.push(["eq", k, v]); rows = rows.filter(r => get(r, k) === v); return this; },
        in(k: string, vs: unknown[]) { call.filters.push(["in", k, vs]); rows = rows.filter(r => vs.includes(get(r, k))); return this; },
        gte(k: string, v: string) { rows = rows.filter(r => get(r, k) >= v); return this; },
        lte(k: string, v: string) { rows = rows.filter(r => get(r, k) <= v); return this; },
        order(k: string) { assert.equal(k, "id"); rows.sort((a, b) => a.id.localeCompare(b.id)); return this; },
        range(from: number, to: number) { lo = from; hi = to; return this; },
        async abortSignal(signal: AbortSignal) {
          signal.throwIfAborted(); reads++;
          return { data: rows.slice(lo, Math.min(hi + 1, lo + (options.cap ?? 500))), error: options.error ? {} : null, count: rows.length + (options.changeCount && reads > 1 ? 1 : 0) };
        },
      };
      return builder;
    },
  };
}
const query = (metric: string, dimension: string | null = null, limit = 20) => ({ metric, dimension, start: "2026-09-01", end: "2026-09-09", limit });
const run = (db: ReturnType<typeof database>, metric: string, dimension: string | null = null) => executeQuery(db, query(metric, dimension), new AbortController().signal);

test("controlled revenue follows approved and controlled/trusted, not audited or generic net", async () => {
  const rows = [
    ["a", 100, "approved", "controlled"], ["b", 25, "approved", "trusted"],
    ["c", 900, "draft", "controlled"], ["d", 800, "approved", "draft"],
  ].map(([id, gross_revenue, approval_status, status]) => ({ id, gross_revenue, approval_status, source_document: { status }, revenue_date: "2026-09-08", channel: "B2B" }));
  const db = database({ revenue_ledger_lines: rows });
  const result = await run(db, "controlled_revenue", "channel");
  assert.deepEqual(result.rows, [{ dimension: "B2B", value: 125 }]);
  assert.match(result.note, /không gọi là net revenue/);
});

test("purchase count uses dates and retains all statuses including cancelled", async () => {
  const db = database({ purchase_orders: [
    { id: "a", status: "cancelled", order_date: "2026-09-01" },
    { id: "b", status: "received", order_date: "2026-09-09" },
    { id: "c", status: "received", order_date: "2026-09-10" },
  ] });
  assert.equal((await run(db, "purchase_order_count")).rows[0].value, 2);
});

test("low stock counts equality and null threshold; never sums quantities across units", async () => {
  const db = database({ inventory_items: [
    { id: "a", category: "food", quantity: 2, min_stock: 2 },
    { id: "b", category: "food", quantity: 0, min_stock: null },
    { id: "c", category: "food", quantity: 3, min_stock: 2 },
  ] });
  const result = await run(db, "low_stock_count");
  assert.equal(result.rows[0].value, 2);
  assert.match(result.note, /không áp khoảng ngày/);
});

test("supplier debt subtracts allocations and clamps each request, excludes paid requests", async () => {
  const db = database({ payment_requests: [
    { id: "a", total_amount: 100, payment_status: "partial", payment_method: "cash" },
    { id: "b", total_amount: 20, payment_status: "unpaid", payment_method: "cash" },
    { id: "c", total_amount: 999, payment_status: "paid", payment_method: "cash" },
  ], payment_allocations: [
    { id: "p1", payment_request_id: "a", amount: 35 },
    { id: "p2", payment_request_id: "a", amount: 5 },
    { id: "p3", payment_request_id: "b", amount: 30 },
  ] });
  const result = await run(db, "supplier_debt", "payment_method");
  assert.deepEqual(result.rows, [{ dimension: "cash", value: 60 }]);
  assert.match(result.note, /không phải công nợ NPP/);
});

test("complete pagination and top group disclosure", async () => {
  const db = database({ purchase_orders: Array.from({ length: 1201 }, (_, i) => ({ id: String(i).padStart(5, "0"), status: i < 1200 ? "received" : "draft", order_date: "2026-09-01" })) });
  const result = await executeQuery(db, query("purchase_order_count", "status", 1), new AbortController().signal);
  assert.deepEqual(result.rows, [{ dimension: "received", value: 1200 }]);
  assert.match(result.note, /1\/2 nhóm cao nhất/);
  assert.equal(db.calls.length, 3);
  const lowest = await executeQuery(db, { ...query("purchase_order_count", "status", 1), sort: "asc" }, new AbortController().signal);
  assert.deepEqual(lowest.rows, [{ dimension: "draft", value: 1 }]);
  assert.match(lowest.note, /nhóm thấp nhất/);
});

test("debt child allocations are paginated rather than silently capped embedded relations", async () => {
  const tables = { payment_requests: [{ id: "r", total_amount: 1000, payment_status: "partial" }],
    payment_allocations: Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(4, "0"), payment_request_id: "r", amount: 1 })),
  };
  const db = database(tables);
  assert.equal((await run(db, "supplier_debt")).rows[0].value, 499);
  assert.equal(db.calls.filter(c => c.table === "payment_allocations").length, 2);
  await assert.rejects(run(database(tables, { cap: 100 }), "supplier_debt"), /INCOMPLETE_ANALYTICS_READ/);
});

test("fail closed on source cap, changing counts, excessive reads, malformed numbers and DB errors", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: String(i), order_date: "2026-09-01" }));
  await assert.rejects(run(database({ purchase_orders: rows }, { cap: 100 }), "purchase_order_count"), /INCOMPLETE_ANALYTICS_READ/);
  await assert.rejects(run(database({ purchase_orders: rows }, { changeCount: true }), "purchase_order_count"), /DATA_CHANGED_RETRY/);
  await assert.rejects(run(database({ purchase_orders: Array.from({ length: 10001 }, (_, i) => ({ id: String(i), order_date: "2026-09-01" })) }), "purchase_order_count"), /BUDGET/);
  await assert.rejects(run(database({ inventory_items: [{ id: "a", quantity: "NaN", min_stock: 0 }] }), "low_stock_count"), /INVALID_NUMERIC/);
  await assert.rejects(run(database({}, { error: true }), "low_stock_count"), /READ_FAILED/);
});

test("unknown metrics, incompatible dimensions, aborts never start DB reads", async () => {
  const db = database({});
  await assert.rejects(run(db, "__proto__"), /UNKNOWN_METRIC/);
  await assert.rejects(run(db, "low_stock_count", "date"), /INCOMPATIBLE/);
  await assert.rejects(executeQuery(db, query("low_stock_count"), AbortSignal.abort()));
  assert.equal(db.calls.length, 0);
});
