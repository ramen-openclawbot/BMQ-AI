// Node tests for the Kho 2D delivery-gate helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDeliveryPayload,
  computeDeliveryVariance,
  evidencePath,
  mapDispatchQueue,
  shortfallErrorText,
} from "./dispatch-delivery.ts";

const DISPATCH_ID = "33333333-3333-3333-3333-333333333333";
const REQUEST_ID = "44444444-4444-4444-4444-444444444444";
const ITEM_A = "11111111-1111-1111-1111-111111111111";
const ITEM_B = "22222222-2222-2222-2222-222222222222";

test("computeDeliveryVariance: giao đủ", () => {
  assert.deepEqual(computeDeliveryVariance(10, 10), {
    expected: 10,
    delivered: 10,
    variance: 0,
    status: "full",
    over_delivered: false,
  });
});

test("computeDeliveryVariance: giao thiếu", () => {
  assert.deepEqual(computeDeliveryVariance(10, 7), {
    expected: 10,
    delivered: 7,
    variance: -3,
    status: "short",
    over_delivered: false,
  });
});

test("computeDeliveryVariance: giao 0", () => {
  assert.deepEqual(computeDeliveryVariance(10, 0), {
    expected: 10,
    delivered: 0,
    variance: -10,
    status: "short",
    over_delivered: false,
  });
});

test("computeDeliveryVariance: giao thừa được cảnh báo", () => {
  assert.deepEqual(computeDeliveryVariance(10, 12), {
    expected: 10,
    delivered: 12,
    variance: 2,
    status: "over",
    over_delivered: true,
  });
  assert.equal(computeDeliveryVariance(10, 10.5).over_delivered, true);
});

test("computeDeliveryVariance: thiếu / null coi là 0", () => {
  assert.deepEqual(computeDeliveryVariance(5, null), {
    expected: 5,
    delivered: 0,
    variance: -5,
    status: "short",
    over_delivered: false,
  });
  assert.deepEqual(computeDeliveryVariance(null, null), {
    expected: 0,
    delivered: 0,
    variance: 0,
    status: "full",
    over_delivered: false,
  });
});

test("buildDeliveryPayload tạo payload hợp lệ", () => {
  const payload = buildDeliveryPayload({
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    lines: [
      { item_id: ITEM_A, expected_qty: 4, delivered_qty: 4 },
      { item_id: ITEM_B, expected_qty: 0.5, delivered_qty: 0.5, source_line_key: "BMQ-002" },
    ],
    photoPaths: [`${DISPATCH_ID}/a.jpg`, `${DISPATCH_ID}/b.jpg`],
  });

  assert.deepEqual(payload, {
    p_dispatch_id: DISPATCH_ID,
    p_request_id: REQUEST_ID,
    p_lines: [
      {
        item_id: ITEM_A,
        delivered_qty: 4,
        source_line_key: null,
        shortfall_action: null,
        shortfall_note: null,
      },
      {
        item_id: ITEM_B,
        delivered_qty: 0.5,
        source_line_key: "BMQ-002",
        shortfall_action: null,
        shortfall_note: null,
      },
    ],
    p_photo_paths: [`${DISPATCH_ID}/a.jpg`, `${DISPATCH_ID}/b.jpg`],
  });
});

test("buildDeliveryPayload: giao đủ không cần shortfall_action", () => {
  const payload = buildDeliveryPayload({
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    lines: [{ item_id: ITEM_A, expected_qty: 10, delivered_qty: 10 }],
    photoPaths: [`${DISPATCH_ID}/a.jpg`],
  });
  assert.deepEqual(payload.p_lines[0], {
    item_id: ITEM_A,
    delivered_qty: 10,
    source_line_key: null,
    shortfall_action: null,
    shortfall_note: null,
  });
});

test("buildDeliveryPayload: giao thiếu + return_stock hợp lệ", () => {
  const payload = buildDeliveryPayload({
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    lines: [{ item_id: ITEM_A, expected_qty: 10, delivered_qty: 7, shortfall_action: "return_stock" }],
    photoPaths: [`${DISPATCH_ID}/a.jpg`],
  });
  assert.equal(payload.p_lines[0].shortfall_action, "return_stock");
  assert.equal(payload.p_lines[0].shortfall_note, null);
});

test("buildDeliveryPayload: giao thiếu + write_off có lý do", () => {
  const payload = buildDeliveryPayload({
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    lines: [
      {
        item_id: ITEM_A,
        expected_qty: 10,
        delivered_qty: 6,
        shortfall_action: "write_off",
        shortfall_note: "Hư hỏng khi vận chuyển",
      },
    ],
    photoPaths: [`${DISPATCH_ID}/a.jpg`],
  });
  assert.equal(payload.p_lines[0].shortfall_action, "write_off");
  assert.equal(payload.p_lines[0].shortfall_note, "Hư hỏng khi vận chuyển");
});

test("buildDeliveryPayload: giao thiếu không chọn bị chặn", () => {
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: DISPATCH_ID,
        requestId: REQUEST_ID,
        lines: [{ item_id: ITEM_A, expected_qty: 10, delivered_qty: 7 }],
        photoPaths: [`${DISPATCH_ID}/a.jpg`],
      }),
    /shortfall_action_required/,
  );
});

test("buildDeliveryPayload: write_off thiếu lý do bị chặn", () => {
  const base = {
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    photoPaths: [`${DISPATCH_ID}/a.jpg`],
  };
  assert.throws(
    () =>
      buildDeliveryPayload({
        ...base,
        lines: [{ item_id: ITEM_A, expected_qty: 10, delivered_qty: 7, shortfall_action: "write_off" }],
      }),
    /shortfall_note_required/,
  );
  assert.throws(
    () =>
      buildDeliveryPayload({
        ...base,
        lines: [
          {
            item_id: ITEM_A,
            expected_qty: 10,
            delivered_qty: 7,
            shortfall_action: "write_off",
            shortfall_note: "ab",
          },
        ],
      }),
    /shortfall_note_required/,
  );
});

test("buildDeliveryPayload: giao vượt bị chặn", () => {
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: DISPATCH_ID,
        requestId: REQUEST_ID,
        lines: [{ item_id: ITEM_A, expected_qty: 10, delivered_qty: 12 }],
        photoPaths: [`${DISPATCH_ID}/a.jpg`],
      }),
    /over_delivery_not_allowed/,
  );
});

test("shortfallErrorText dịch mã lỗi và có fallback", () => {
  assert.match(shortfallErrorText("over_delivery_not_allowed"), /không được lớn hơn/);
  assert.match(shortfallErrorText("shortfall_action_required"), /Trả lại kho/);
  assert.match(shortfallErrorText("shortfall_note_required"), /3 ký tự/);
  assert.equal(shortfallErrorText("some_unknown_code"), "some_unknown_code");
  assert.match(shortfallErrorText(null), /Không ghi được/);
});

test("buildDeliveryPayload chặn thiếu ảnh", () => {
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: DISPATCH_ID,
        requestId: REQUEST_ID,
        lines: [{ item_id: ITEM_A, expected_qty: 1, delivered_qty: 1 }],
        photoPaths: [],
      }),
    /at least 1 photo/,
  );
});

test("buildDeliveryPayload chặn quá 8 ảnh", () => {
  const photos = Array.from({ length: 9 }, (_, index) => `${DISPATCH_ID}/p${index}.jpg`);
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: DISPATCH_ID,
        requestId: REQUEST_ID,
        lines: [{ item_id: ITEM_A, expected_qty: 1, delivered_qty: 1 }],
        photoPaths: photos,
      }),
    /at most 8 photos/,
  );
});

test("buildDeliveryPayload chặn số âm, NaN và thiếu dòng", () => {
  const base = {
    dispatchId: DISPATCH_ID,
    requestId: REQUEST_ID,
    photoPaths: [`${DISPATCH_ID}/a.jpg`],
  };
  assert.throws(
    () =>
      buildDeliveryPayload({ ...base, lines: [{ item_id: ITEM_A, expected_qty: 5, delivered_qty: -1 }] }),
    /greater than or equal to 0/,
  );
  assert.throws(
    () =>
      buildDeliveryPayload({
        ...base,
        lines: [{ item_id: ITEM_A, expected_qty: 5, delivered_qty: Number.NaN }],
      }),
    /finite number/,
  );
  assert.throws(() => buildDeliveryPayload({ ...base, lines: [] }), /at least one line/);
});

test("buildDeliveryPayload chặn thiếu dispatch / request id", () => {
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: "",
        requestId: REQUEST_ID,
        lines: [{ item_id: ITEM_A, expected_qty: 1, delivered_qty: 1 }],
        photoPaths: [`${DISPATCH_ID}/a.jpg`],
      }),
    /dispatchId is required/,
  );
  assert.throws(
    () =>
      buildDeliveryPayload({
        dispatchId: DISPATCH_ID,
        requestId: "  ",
        lines: [{ item_id: ITEM_A, expected_qty: 1, delivered_qty: 1 }],
        photoPaths: [`${DISPATCH_ID}/a.jpg`],
      }),
    /requestId is required/,
  );
});

test("evidencePath làm sạch tên file có ký tự lạ", () => {
  assert.equal(evidencePath(DISPATCH_ID, "photo (1).jpg"), `${DISPATCH_ID}/photo_1_.jpg`);
  assert.equal(evidencePath(DISPATCH_ID, "../../etc/passwd"), `${DISPATCH_ID}/passwd`);
  assert.equal(evidencePath(DISPATCH_ID, "a/b\\c.png"), `${DISPATCH_ID}/c.png`);
  assert.equal(evidencePath(DISPATCH_ID, ".."), `${DISPATCH_ID}/evidence.jpg`);
  const spaced = evidencePath(DISPATCH_ID, "anh chụp ảnh.jpg");
  assert.match(spaced, new RegExp(`^${DISPATCH_ID}/[A-Za-z0-9._-]+$`));
  assert.equal(spaced.includes(".."), false);
  assert.equal(spaced.slice(DISPATCH_ID.length + 1).includes("/"), false);
});

test("mapDispatchQueue trả [] cho payload rỗng / null", () => {
  assert.deepEqual(mapDispatchQueue(null), []);
  assert.deepEqual(mapDispatchQueue(undefined), []);
  assert.deepEqual(mapDispatchQueue([]), []);
});

test("mapDispatchQueue chuẩn hóa số và dòng thiếu dữ liệu", () => {
  const rows = mapDispatchQueue([
    {
      id: DISPATCH_ID,
      dispatch_number: "XK-20261101-001",
      status: "dispatched",
      dispatch_date: "2026-11-01",
      delivered_date: null,
      customer_id: null,
      customer_name: "Đại lý A",
      amount_status: "temporary_po_amount",
      confirmation_id: null,
      evidence_count: "2",
      can_edit: true,
      items: [
        {
          id: ITEM_A,
          product_name: "Bánh mì que",
          unit: "cái",
          quantity: "10",
          delivered_qty: null,
        },
        { id: ITEM_B },
      ],
    },
    { id: "row-without-items" },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].evidence_count, 2);
  assert.equal(rows[0].can_edit, true);
  assert.equal(rows[0].customer_name, "Đại lý A");
  assert.equal(rows[0].items.length, 2);
  assert.equal(rows[0].items[0].quantity, 10);
  assert.equal(rows[0].items[0].delivered_qty, 0);
  assert.equal(rows[0].items[1].product_name, "");
  assert.equal(rows[0].items[1].quantity, 0);
  assert.equal(rows[1].items.length, 0);
  assert.equal(rows[1].amount_status, null);
});

test("mapDispatchQueue từ chối payload không phải mảng", () => {
  assert.throws(() => mapDispatchQueue({ items: [] }), /must be an array/);
});
