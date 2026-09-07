import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fetchAllPages } from "./npp-debt-pagination.ts";

type Row = { id: string };

function rows(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(offset + index + 1) }));
}

test("fetchAllPages returns more than 1,000 rows without truncation", async () => {
  const source = rows(1_359);

  const result = await fetchAllPages((from, to) =>
    Promise.resolve({ data: source.slice(from, to + 1), error: null })
  );

  assert.equal(result.length, 1_359);
  assert.equal(result.at(-1)?.id, "1359");
});

test("fetchAllPages combines multiple full and partial pages", async () => {
  const source = rows(2_501);
  const requestedRanges: Array<[number, number]> = [];

  const result = await fetchAllPages((from, to) => {
    requestedRanges.push([from, to]);
    return Promise.resolve({ data: source.slice(from, to + 1), error: null });
  });

  assert.equal(result.length, 2_501);
  assert.deepEqual(requestedRanges, [[0, 999], [1_000, 1_999], [2_000, 2_999]]);
});

test("fetchAllPages checks the page after an exact boundary", async () => {
  const source = rows(2_000);
  const requestedRanges: Array<[number, number]> = [];

  const result = await fetchAllPages((from, to) => {
    requestedRanges.push([from, to]);
    return Promise.resolve({ data: source.slice(from, to + 1), error: null });
  });

  assert.equal(result.length, 2_000);
  assert.deepEqual(requestedRanges, [[0, 999], [1_000, 1_999], [2_000, 2_999]]);
});

test("fetchAllPages returns an empty array for an empty result", async () => {
  const result = await fetchAllPages<Row>(() => Promise.resolve({ data: [], error: null }));

  assert.deepEqual(result, []);
});

test("fetchAllPages rejects an intermediate page error without returning partial data", async () => {
  const expectedError = { message: "second page failed" };
  let calls = 0;

  await assert.rejects(
    fetchAllPages<Row>(() => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? { data: rows(1_000), error: null }
        : { data: null, error: expectedError });
    }),
    (error) => error === expectedError
  );
  assert.equal(calls, 2);
});

test("NPP ranking and debt queries paginate with stable id tie-breaks", () => {
  const source = readFileSync(new URL("../pages/NppDebtManagement.tsx", import.meta.url), "utf8");
  const rankingQuery = source.slice(
    source.indexOf('queryKey: ["debt-customer-revenue-ranking"'),
    source.indexOf("const customerRevenueById")
  );
  const debtQuery = source.slice(
    source.indexOf('queryKey: ["debt-ledger-lines"'),
    source.indexOf("const summaries")
  );

  assert.match(rankingQuery, /fetchAllPages/);
  assert.match(rankingQuery, /\.order\("gross_revenue", \{ ascending: false \}\)[\s\S]*\.order\("id", \{ ascending: true \}\)[\s\S]*\.range\(from, to\)/);
  assert.doesNotMatch(rankingQuery, /\.limit\(10000\)/);

  assert.match(debtQuery, /fetchAllPages/);
  assert.match(debtQuery, /\.order\("revenue_date", \{ ascending: true \}\)[\s\S]*\.order\("id", \{ ascending: true \}\)[\s\S]*\.range\(from, to\)/);
  assert.doesNotMatch(debtQuery, /\.limit\(5000\)/);
});
