// Node tests for the stock count session parsers and summarizeStockCount.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSaveLineResult,
  parseStockCountReview,
  parseStockCountSession,
  summarizeStockCount,
  type StockCountLine,
} from "./stock-count.ts";

function validLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    target_kind: "item",
    target_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    target_code: "NVL-001",
    target_name: "Bột mì",
    unit: "g",
    item_class: "raw_material",
    book_qty: 12.5,
    counted_qty: null,
    note: null,
    counted_by: null,
    counted_at: null,
    difference_qty: null,
    result: null,
    ...overrides,
  };
}

function validSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    location: "tan_tao",
    count_date: "2026-10-30",
    status: "open",
    opened_by: "33333333-3333-3333-3333-333333333333",
    submitted_by: null,
    submitted_by_name: null,
    opened_at: "2026-10-30T02:00:00+00:00",
    submitted_at: null,
    note: null,
    summary: null,
    lines: [
      validLine(),
      validLine({
        id: "44444444-4444-4444-4444-444444444444",
        target_kind: "sku",
        target_code: "BMQ-001",
        target_name: "Bánh mì que Pate",
        unit: "gói",
        item_class: "finished_goods",
        book_qty: 4,
        counted_qty: 6,
        difference_qty: 2,
      }),
    ],
    ...overrides,
  };
}

test("parseStockCountReview reads the open session, history and flags", () => {
  const review = parseStockCountReview({
    open_session: validSession(),
    history: [
      validSession({
        id: "55555555-5555-5555-5555-555555555555",
        status: "submitted",
        submitted_by: "33333333-3333-3333-3333-333333333333",
        submitted_by_name: "Nguyễn Văn A",
        submitted_at: "2026-10-29T03:00:00+00:00",
        summary: {
          counted: 3,
          skipped: 3,
          adjusted: 2,
          total_abs_diff: 9,
          lines_with_diff: 2,
        },
        lines: undefined,
      }),
      validSession({
        id: "66666666-6666-6666-6666-666666666666",
        status: "cancelled",
      }),
    ],
    cutover_date: "2026-10-30",
    can_edit: true,
  });

  assert.equal(review.open_session?.location, "tan_tao");
  assert.equal(review.open_session?.lines.length, 2);
  assert.equal(review.open_session?.lines[1].target_kind, "sku");
  assert.equal(review.open_session?.lines[1].counted_qty, 6);
  assert.equal(review.open_session?.lines[1].difference_qty, 2);
  assert.equal(review.history.length, 2);
  assert.equal(review.history[0].status, "submitted");
  assert.equal(review.history[0].submitted_by_name, "Nguyễn Văn A");
  assert.deepEqual(review.history[0].summary, {
    counted: 3,
    skipped: 3,
    adjusted: 2,
    total_abs_diff: 9,
    lines_with_diff: 2,
  });
  assert.deepEqual(review.history[0].lines, []);
  assert.equal(review.cutover_date, "2026-10-30");
  assert.equal(review.can_edit, true);
});

test("parseStockCountReview keeps an absent open session null", () => {
  const review = parseStockCountReview({
    open_session: null,
    history: [],
    cutover_date: null,
    can_edit: false,
  });
  assert.equal(review.open_session, null);
  assert.deepEqual(review.history, []);
  assert.equal(review.cutover_date, null);
  assert.equal(review.can_edit, false);
});

test("parseStockCountSession preserves a null counted qty", () => {
  const session = parseStockCountSession(validSession());
  assert.equal(session.id, "22222222-2222-2222-2222-222222222222");
  assert.equal(session.status, "open");
  assert.equal(session.summary, null);
  assert.equal(session.lines[0].counted_qty, null);
  assert.equal(session.lines[0].difference_qty, null);
  assert.equal(session.lines[1].counted_qty, 6);
});

test("parseSaveLineResult reads a saved line with difference_qty and result", () => {
  const line = parseSaveLineResult(
    validLine({
      counted_qty: 15,
      difference_qty: 2.5,
      counted_by: "33333333-3333-3333-3333-333333333333",
      counted_at: "2026-10-30T02:10:00+00:00",
      result: { status: "adjustment_recorded" },
    }),
  );
  assert.equal(line.counted_qty, 15);
  assert.equal(line.difference_qty, 2.5);
  assert.equal(line.counted_by, "33333333-3333-3333-3333-333333333333");
  assert.deepEqual(line.result, { status: "adjustment_recorded" });
});

test("missing required fields throw with the offending path", () => {
  const noId = validLine();
  delete noId.id;
  assert.throws(() => parseStockCountSession(validSession({ lines: [noId] })), /id/);

  const noBook = validLine();
  delete noBook.book_qty;
  assert.throws(() => parseSaveLineResult(noBook), /book_qty/);

  const badClass = validLine({ item_class: "unknown" });
  assert.throws(() => parseSaveLineResult(badClass), /item_class/);

  const badKind = validLine({ target_kind: "material" });
  assert.throws(() => parseSaveLineResult(badKind), /target_kind/);
});

test("parseStockCountReview rejects a malformed payload", () => {
  assert.throws(() => parseStockCountReview(null), TypeError);
  assert.throws(
    () => parseStockCountReview({ open_session: null, history: {}, cutover_date: null, can_edit: true }),
    TypeError,
  );
  assert.throws(
    () =>
      parseStockCountReview({
        open_session: validSession({ location: "hq" }),
        history: [],
        cutover_date: null,
        can_edit: true,
      }),
    TypeError,
  );
});

test("summarizeStockCount counts, skips and sums the book differences", () => {
  const lines: StockCountLine[] = [
    parseSaveLineResult(validLine({ book_qty: 10, counted_qty: 12, difference_qty: 2 })),
    parseSaveLineResult(validLine({ id: "b", book_qty: 5, counted_qty: 5, difference_qty: 0 })),
    parseSaveLineResult(validLine({ id: "c", book_qty: 7.5, counted_qty: 3, difference_qty: -4.5 })),
    parseSaveLineResult(validLine({ id: "d", book_qty: 9, counted_qty: null, difference_qty: null })),
    parseSaveLineResult(validLine({ id: "e", book_qty: 1, counted_qty: 0, difference_qty: -1 })),
  ];
  assert.deepEqual(summarizeStockCount(lines), {
    counted: 4,
    skipped: 1,
    adjusted: 3,
    total_abs_diff: 7.5,
    lines_with_diff: 3,
  });
});

test("summarizeStockCount of an untouched session is all zero", () => {
  const lines: StockCountLine[] = [
    parseStockCountSession(validSession({ lines: [validLine()] })).lines[0],
  ];
  assert.deepEqual(summarizeStockCount(lines), {
    counted: 0,
    skipped: 1,
    adjusted: 0,
    total_abs_diff: 0,
    lines_with_diff: 0,
  });
});
