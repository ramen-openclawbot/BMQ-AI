import assert from "node:assert/strict";
import test from "node:test";

import {
  isStaleLinkError,
  parseQ7ExactLinkBatch,
  parseQ7MaterialLinkResult,
  parseQ7MaterialLinkReview,
  q7MaterialLinkErrorCode,
  q7MaterialLinkErrorText,
} from "./q7-material-links.ts";

const validReview = {
  items: [
    {
      item_id: "11111111-1111-1111-1111-111111111111",
      item_code: "NVL-001",
      name: "Bột mì 888",
      unit: "g",
      exact_material: {
        id: "22222222-2222-2222-2222-222222222222",
        material_code: "NVL-BOT-MI",
        canonical_name: "Bột mì",
        default_unit: "g",
      },
      material_unit: "g",
      unit_status: "same",
      auto_factor: null,
      factor_suggestion: null,
      candidates: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          material_code: "NVL-BOT-MI",
          canonical_name: "Bột mì",
          default_unit: "g",
          unit_status: "same",
          score: 1,
        },
      ],
    },
    {
      item_id: "33333333-3333-3333-3333-333333333333",
      item_code: null,
      name: "Đường cát",
      unit: "kg",
      exact_material: null,
      material_unit: null,
      unit_status: null,
      auto_factor: null,
      factor_suggestion: null,
      candidates: [],
    },
    {
      item_id: "55555555-5555-5555-5555-555555555555",
      item_code: "NVL-003",
      name: "Trứng gà 60gr",
      unit: "quả",
      exact_material: {
        id: "66666666-6666-6666-6666-666666666666",
        material_code: "NVL-TRUNG",
        canonical_name: "Trứng gà",
        default_unit: "g",
      },
      material_unit: "g",
      unit_status: "needs_factor",
      auto_factor: null,
      factor_suggestion: 60,
      candidates: [],
    },
  ],
  counts: { total: 3, exact: 2, auto: 0, needs_factor: 1, linked_total: 5 },
};

test("parseQ7MaterialLinkReview accepts a valid payload", () => {
  const review = parseQ7MaterialLinkReview(validReview);
  assert.equal(review.items.length, 3);
  assert.equal(review.items[0].exact_material?.material_code, "NVL-BOT-MI");
  assert.equal(review.items[0].candidates[0].score, 1);
  assert.equal(review.items[0].candidates[0].unit_status, "same");
  assert.equal(review.items[1].item_code, null);
  assert.equal(review.items[1].exact_material, null);
  assert.equal(review.items[1].unit_status, null);
  assert.equal(review.items[2].unit_status, "needs_factor");
  assert.equal(review.items[2].factor_suggestion, 60);
  assert.deepEqual(review.counts, {
    total: 3,
    exact: 2,
    auto: 0,
    needs_factor: 1,
    linked_total: 5,
  });
});

test("parseQ7MaterialLinkReview rejects missing and malformed fields", () => {
  assert.throws(() => parseQ7MaterialLinkReview(null), TypeError);
  assert.throws(() => parseQ7MaterialLinkReview({ items: [], counts: {} }), TypeError);
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: {},
        counts: { total: 0, exact: 0, auto: 0, needs_factor: 0, linked_total: 0 },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: [{ ...validReview.items[0], item_id: 42 }],
        counts: { total: 1, exact: 1, auto: 0, needs_factor: 0, linked_total: 0 },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: [{ ...validReview.items[0], exact_material: { id: "x" } }],
        counts: { total: 1, exact: 1, auto: 0, needs_factor: 0, linked_total: 0 },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: [{ ...validReview.items[0], candidates: [{ id: "x" }] }],
        counts: { total: 1, exact: 1, auto: 0, needs_factor: 0, linked_total: 0 },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: [{ ...validReview.items[2], unit_status: "maybe" }],
        counts: { total: 1, exact: 1, auto: 0, needs_factor: 1, linked_total: 0 },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7MaterialLinkReview({
        items: [{ ...validReview.items[2], factor_suggestion: "sixty" }],
        counts: { total: 1, exact: 1, auto: 0, needs_factor: 1, linked_total: 0 },
      }),
    TypeError,
  );
});

test("parseQ7MaterialLinkReview accepts an auto pair with a computed factor", () => {
  const review = parseQ7MaterialLinkReview({
    items: [
      {
        ...validReview.items[0],
        name: "Bột mì 25kg",
        unit: "kg",
        exact_material: { ...validReview.items[0].exact_material, default_unit: "g" },
        material_unit: "g",
        unit_status: "auto",
        auto_factor: 25000,
        factor_suggestion: null,
      },
    ],
    counts: { total: 1, exact: 1, auto: 1, needs_factor: 0, linked_total: 0 },
  });
  assert.equal(review.items[0].unit_status, "auto");
  assert.equal(review.items[0].auto_factor, 25000);
});

test("parseQ7MaterialLinkResult accepts a valid link result", () => {
  const result = parseQ7MaterialLinkResult({
    item_id: "11111111-1111-1111-1111-111111111111",
    material_id: "22222222-2222-2222-2222-222222222222",
    material_code: "NVL-BOT-MI",
    canonical_name: "Bột mì",
    created_material: true,
    request_id: "44444444-4444-4444-4444-444444444444",
  });
  assert.equal(result.created_material, true);
  assert.equal(result.request_id, "44444444-4444-4444-4444-444444444444");
});

test("parseQ7MaterialLinkResult tolerates a null request id and rejects bad fields", () => {
  const result = parseQ7MaterialLinkResult({
    item_id: "a",
    material_id: "b",
    material_code: "c",
    canonical_name: "d",
    created_material: false,
    request_id: null,
  });
  assert.equal(result.request_id, null);
  assert.throws(() => parseQ7MaterialLinkResult({}), TypeError);
  assert.throws(
    () =>
      parseQ7MaterialLinkResult({
        item_id: "a",
        material_id: "b",
        material_code: "c",
        canonical_name: "d",
        created_material: "yes",
        request_id: null,
      }),
    TypeError,
  );
});

test("parseQ7ExactLinkBatch accepts successes, needs_factor and per-item failures", () => {
  const batch = parseQ7ExactLinkBatch({
    linked: 3,
    needs_factor: [
      {
        item_id: "55555555-5555-5555-5555-555555555555",
        name: "Khoai tây 25kg",
        unit: "bao",
        material_unit: "g",
        factor_suggestion: 25000,
      },
      {
        item_id: "77777777-7777-7777-7777-777777777777",
        name: "Nước mắm",
        unit: "bình",
        material_unit: "g",
        factor_suggestion: null,
      },
    ],
    failed: [
      {
        item_id: "11111111-1111-1111-1111-111111111111",
        name: "Bột mì 888",
        error: "unit_unmapped",
      },
    ],
  });
  assert.equal(batch.linked, 3);
  assert.equal(batch.needs_factor.length, 2);
  assert.equal(batch.needs_factor[0].factor_suggestion, 25000);
  assert.equal(batch.needs_factor[1].factor_suggestion, null);
  assert.equal(batch.failed[0].error, "unit_unmapped");
});

test("parseQ7ExactLinkBatch rejects malformed payloads", () => {
  assert.throws(() => parseQ7ExactLinkBatch({ linked: 1 }), TypeError);
  assert.throws(
    () => parseQ7ExactLinkBatch({ linked: "not-a-number", needs_factor: [], failed: [] }),
    TypeError,
  );
  assert.throws(
    () => parseQ7ExactLinkBatch({ linked: 0, needs_factor: [], failed: [{ item_id: "a" }] }),
    TypeError,
  );
  assert.throws(
    () =>
      parseQ7ExactLinkBatch({
        linked: 0,
        needs_factor: [{ item_id: "a" }],
        failed: [],
      }),
    TypeError,
  );
});

test("q7MaterialLinkErrorText maps known codes and falls back", () => {
  assert.equal(
    q7MaterialLinkErrorText("insufficient_privilege"),
    "Không có quyền liên kết NVL với Material Master.",
  );
  assert.match(q7MaterialLinkErrorText("item_already_linked"), /người khác gắn mã/);
  assert.match(q7MaterialLinkErrorText("item_not_eligible"), /người khác gắn mã hoặc đã ngưng dùng/);
  assert.match(q7MaterialLinkErrorText("material_inactive"), /ngừng hoạt động/);
  assert.match(q7MaterialLinkErrorText("unit_factor_required"), /hệ số quy đổi/);
  assert.equal(q7MaterialLinkErrorText("something_else"), "Không liên kết được NVL. Vui lòng thử lại.");
  assert.equal(q7MaterialLinkErrorText(null), "Không liên kết được NVL. Vui lòng thử lại.");
});

test("q7MaterialLinkErrorCode extracts a known code from an error", () => {
  assert.equal(q7MaterialLinkErrorCode(new Error("item_already_linked")), "item_already_linked");
  assert.equal(
    q7MaterialLinkErrorCode({ message: 'postgres error: material_inactive' }),
    "material_inactive",
  );
  assert.equal(q7MaterialLinkErrorCode(new Error("unit_factor_required")), "unit_factor_required");
  assert.equal(q7MaterialLinkErrorCode(new Error("boom")), null);
});

test("stale link errors (someone else linked first) trigger a refresh", () => {
  assert.equal(isStaleLinkError(new Error("item_already_linked")), true);
  assert.equal(isStaleLinkError(new Error("item_not_eligible")), true);
  assert.equal(isStaleLinkError(new Error("unit_factor_required")), false);
});
