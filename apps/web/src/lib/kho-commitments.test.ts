import assert from "node:assert/strict";
import test from "node:test";

import {
  commitmentByItem,
  commitmentBySku,
  dayLabel,
  parseKhoCommitments,
  type KhoCommitments,
} from "./kho-commitments.ts";

function fullPayload(): KhoCommitments {
  return {
    as_of: "2026-10-22",
    items: [
      {
        kitchen_inventory_item_id: "11111111-1111-4111-8111-111111111111",
        location: "q7",
        committed_qty: 12.5,
        unit: "kg",
        next_date: "2026-10-23",
        sources: [
          {
            kind: "pxk",
            ref: "PXK-NVL-Q7-20261023-001",
            date: "2026-10-23",
            qty: 12.5,
          },
        ],
      },
      {
        kitchen_inventory_item_id: "22222222-2222-4222-8222-222222222222",
        location: "tan_tao",
        committed_qty: 3,
        unit: "g",
        next_date: null,
        sources: [{ kind: "pxk", ref: "manual_daily", date: "2026-10-25", qty: 3 }],
      },
    ],
    skus: [
      {
        location: "tan_tao",
        sku_id: "33333333-3333-4333-8333-333333333333",
        sku_code: "BMQ-001",
        name: "Bánh mì tươi",
        unit: "que",
        on_hand: 100,
        incoming_qty: 0,
        committed_qty: 70,
        overdue_qty: 10,
        available: 20,
        orders: 4,
        next_date: "2026-10-23",
      },
      {
        location: "q7",
        sku_id: "44444444-4444-4444-8444-444444444444",
        sku_code: "Q7-CROISSANT",
        name: "Croissant",
        unit: "cái",
        on_hand: 30,
        incoming_qty: 0,
        committed_qty: 18,
        overdue_qty: 0,
        available: 12,
        orders: 2,
        next_date: "2026-10-24",
      },
    ],
    gaps: {
      pxk_lines_unposted: 2,
      pxk_unposted_issues: ["PXK-NVL-Q7-20261023-002", "PXK-NVL-Q7-20261023-003"],
    },
  };
}

test("parseKhoCommitments accepts a full payload", () => {
  const payload = fullPayload();
  assert.deepEqual(parseKhoCommitments(payload), payload);
});

test("parseKhoCommitments rejects a bad shape", () => {
  assert.throws(() => parseKhoCommitments(null), TypeError);
  assert.throws(() => parseKhoCommitments({}), TypeError);
  assert.throws(
    () => parseKhoCommitments({ ...fullPayload(), items: "nope" }),
    TypeError,
  );
  assert.throws(
    () => parseKhoCommitments({ ...fullPayload(), as_of: "2026-02-31" }),
    TypeError,
  );

  const badNumber: any = fullPayload();
  badNumber.items[0].committed_qty = "12";
  assert.throws(() => parseKhoCommitments(badNumber), TypeError);

  const infinite: any = fullPayload();
  infinite.skus[0].available = Number.POSITIVE_INFINITY;
  assert.throws(() => parseKhoCommitments(infinite), TypeError);

  const badDate: any = fullPayload();
  badDate.skus[0].next_date = 42;
  assert.throws(() => parseKhoCommitments(badDate), TypeError);

  const badSource: any = fullPayload();
  badSource.items[0].sources[0].kind = "manual";
  assert.throws(() => parseKhoCommitments(badSource), TypeError);

  const badGaps: any = fullPayload();
  badGaps.gaps.pxk_unposted_issues = "PXK-1";
  assert.throws(() => parseKhoCommitments(badGaps), TypeError);
});

test("commitmentByItem and commitmentBySku key by location", () => {
  const parsed = parseKhoCommitments(fullPayload());
  const byItem = commitmentByItem(parsed);
  assert.equal(byItem.size, 2);
  assert.equal(
    byItem.get("q7:11111111-1111-4111-8111-111111111111")?.committed_qty,
    12.5,
  );
  assert.equal(
    byItem.get("tan_tao:22222222-2222-4222-8222-222222222222")?.next_date,
    null,
  );
  assert.equal(byItem.get("q7:22222222-2222-4222-8222-222222222222"), undefined);

  const bySku = commitmentBySku(parsed);
  assert.equal(bySku.size, 2);
  assert.equal(bySku.get("tan_tao:BMQ-001")?.available, 20);
  assert.equal(bySku.get("q7:Q7-CROISSANT")?.orders, 2);
  assert.equal(bySku.get("tan_tao:Q7-CROISSANT"), undefined);
});

test("dayLabel covers today, tomorrow and month ends", () => {
  assert.equal(dayLabel("2026-10-22", "2026-10-22"), "hôm nay");
  assert.equal(dayLabel("2026-10-22", "2026-10-23"), "ngày mai");
  assert.equal(dayLabel("2026-10-31", "2026-11-01"), "ngày mai");
  assert.equal(dayLabel("2026-10-31", "2026-11-02"), "02/11");
  assert.equal(dayLabel("2026-12-31", "2027-01-01"), "ngày mai");
  assert.equal(dayLabel("2026-10-22", "2026-10-20"), "20/10");
  assert.equal(dayLabel("2026-10-22", null), "—");
});
