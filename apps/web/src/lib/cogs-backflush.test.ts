import assert from "node:assert/strict";
import test from "node:test";

import {
  coveragePct,
  gapCount,
  parseCogsOverview,
  parseCogsTrace,
  type CogsOverview,
} from "./cogs-backflush.ts";

function overviewPayload(): CogsOverview {
  return {
    as_of: "2026-10-22",
    from: "2026-10-01",
    to: "2026-10-21",
    settings: [
      {
        location: "q7",
        enabled: true,
        start_date: "2026-10-23",
        cutover_date: "2026-10-16",
        updated_at: "2026-10-22T03:00:00+00:00",
      },
      {
        location: "tan_tao",
        enabled: false,
        start_date: null,
        cutover_date: "2026-10-15",
        updated_at: null,
      },
    ],
    last_run: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      started_at: "2026-10-22T03:00:00+00:00",
      finished_at: "2026-10-22T03:00:02+00:00",
      window_from: "2026-10-15",
      window_to: "2026-11-05",
      dry_run: false,
      posted_rows: 4,
      summary: { lines_read: 120 },
      error: null,
    },
    coverage: [
      {
        channel: "BÁNH NGỌT",
        lines: 80,
        qty: 100,
        value: 10_000_000,
        mapped_lines: 78,
        mapped_qty: 98,
        mapped_value: 9_800_000,
        mapped_pct: 97.5,
        mapped_value_pct: 98,
      },
      {
        channel: "BÁNH MÌ",
        lines: 20,
        qty: 30,
        value: 2_000_000,
        mapped_lines: 10,
        mapped_qty: 15,
        mapped_value: 1_000_000,
        mapped_pct: 50,
        mapped_value_pct: 50,
      },
    ],
    items: [
      {
        item_id: "11111111-1111-4111-8111-111111111111",
        name: "Bột mì",
        unit: "kg",
        location: "q7",
        recipe_qty: 12.5,
        pxk_usage: 8,
        posted_cogs: 10.5,
      },
    ],
    gaps: {
      products: [
        {
          map_id: "22222222-2222-4222-8222-222222222222",
          channel: "BÁNH MÌ",
          product_code: "123456",
          name: "Bánh mì đặc biệt",
          lines: 2,
          qty: 3,
          value: 150000,
          candidates: [{ sku_code: "BMQ-001", score: 0.91 }],
        },
      ],
      ingredients: [
        {
          canonical_material_id: "33333333-3333-4333-8333-333333333333",
          material_name: "Bơ",
          recipe_unit: "kg",
          reason: "unit",
          sku_codes: ["BMQ-001"],
          candidates: [],
        },
      ],
      recipes: [{ sku_code: "BMQ-002", name: "Bánh mì đông lạnh", reason: "no_recipe", lines: 1 }],
    },
  };
}

test("parseCogsOverview accepts a full RPC payload", () => {
  const payload = overviewPayload();
  assert.deepEqual(parseCogsOverview(payload), payload);
});

test("parseCogsOverview defaults missing keys to zeroes and empty arrays", () => {
  const parsed = parseCogsOverview({});
  assert.equal(parsed.as_of, null);
  assert.deepEqual(parsed.settings, []);
  assert.equal(parsed.last_run, null);
  assert.deepEqual(parsed.coverage, []);
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.gaps, { products: [], ingredients: [], recipes: [] });

  const partial = parseCogsOverview({
    coverage: [{ channel: "BÁNH NGỌT" }],
    gaps: { products: [{ name: "Thiếu map" }] },
  });
  assert.equal(partial.coverage[0].value, 0);
  assert.equal(partial.coverage[0].mapped_value, 0);
  assert.equal(partial.gaps.products[0].lines, 0);
  assert.deepEqual(partial.gaps.products[0].candidates, []);

  assert.deepEqual(parseCogsOverview(null), parseCogsOverview({}));
});

test("parseCogsTrace keeps rows and tolerates a missing payload", () => {
  const trace = parseCogsTrace({
    location: "q7",
    item_id: "11111111-1111-4111-8111-111111111111",
    from: "2026-10-01",
    to: "2026-10-21",
    rows: [
      {
        revenue_date: "2026-10-15",
        sku_id: "44444444-4444-4444-8444-444444444444",
        sku_code: "BMQ-001",
        sku_name: "Bánh mì tươi",
        revenue_line_id: "55555555-5555-4555-8555-555555555555",
        channel: "BÁNH NGỌT",
        ref: "SO-100",
        version_id: "66666666-6666-4666-8666-666666666666",
        version_no: 3,
        version_no_text: "3",
        recipe_unit: "kg",
        recipe_qty: 1.25,
        stock_qty: 1250,
        status: "ok",
      },
    ],
  });
  assert.equal(trace.location, "q7");
  assert.equal(trace.rows.length, 1);
  assert.equal(trace.rows[0].recipe_qty, 1.25);
  assert.equal(trace.rows[0].version_no, 3);

  const empty = parseCogsTrace({});
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.location, "q7");
  assert.equal(empty.item_id, "");
  assert.deepEqual(parseCogsTrace(null).rows, []);
});

test("coveragePct weighs by revenue value and gapCount totals every gap kind", () => {
  const overview = parseCogsOverview(overviewPayload());
  const expected = (9_800_000 + 1_000_000) / (10_000_000 + 2_000_000) * 100;
  assert.equal(coveragePct(overview.coverage), expected);
  assert.equal(coveragePct(overview), expected);
  assert.equal(coveragePct([]), 0);
  assert.equal(coveragePct({ coverage: [] }), 0);

  assert.equal(gapCount(overview.gaps), 3);
  assert.equal(gapCount(overview), 3);
  assert.equal(gapCount({ products: [], ingredients: [], recipes: [] }), 0);
});
