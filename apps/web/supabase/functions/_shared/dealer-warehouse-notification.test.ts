import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultDeliveryDateTPlusOne,
  formatWarehouseDealerDailyDigest,
  formatWarehouseOrderMessage,
  formatWarehousePointDailyDigest,
  refreshZaloOaAccessToken,
  sendZaloGmfText,
} from "./dealer-warehouse-notification.ts";

const ORDER = {
  orderNumber: "DOP-20260803-ABCD1234",
  customerName: "NPP Anh Thanh",
  submittedAt: "2026-08-03T15:56:36.591751Z",
  requestedDeliveryDate: "2026-08-04",
  deliveryNote: "Giao trước 08:00",
  customerNote: null,
  lines: [
    {
      productName: "Bánh Mì Que Pate",
      unit: "que",
      orderedQuantity: 100,
      exchangeQuantity: 2,
      makeupQuantity: 3,
      physicalQuantity: 105,
      routeCustomerName: "Điểm bán Quận 1",
      routeNote: "Cửa sau",
    },
    {
      productName: "Bánh Mì Que Cay",
      unit: "que",
      orderedQuantity: 40,
      exchangeQuantity: 0,
      makeupQuantity: 5,
      physicalQuantity: 45,
      routeCustomerName: "Điểm bán Quận 3",
      routeNote: null,
    },
  ],
};

test("formats warehouse quantities by delivery route without prices", () => {
  const message = formatWarehouseOrderMessage(ORDER);

  assert.match(message, /📦 TỔNG KẾT ĐƠN BÁNH ĐẠI LÝ/);
  assert.match(message, /Mã đơn: DOP-20260803-ABCD1234/);
  assert.match(message, /Đơn vị đặt: NPP Anh Thanh/);
  assert.match(message, /2 điểm bán • Đặt lúc 22:56 03\/08/);
  assert.match(message, /Ngày giao: 04\/08\/2026/);
  assert.match(message, /01\. Điểm bán Quận 1/);
  assert.match(message, /Bánh Mì Que Pate: Đặt 100 \+ Đổi 2 \+ Bù 3/);
  assert.match(message, /→ GIAO 105 que/);
  assert.match(message, /📝 Ghi chú: Cửa sau/);
  assert.match(message, /02\. Điểm bán Quận 3/);
  assert.match(message, /📊 TỔNG KHO/);
  assert.match(message, /Đặt mới: 140 que/);
  assert.match(message, /Đổi: 2 que/);
  assert.match(message, /Bù: 8 que/);
  assert.match(message, /✅ KHO CẦN GIAO: 150 QUE/);
  assert.match(message, /Ghi chú giao hàng: Giao trước 08:00/);
  assert.match(message, /Nguồn: dathang\.banhmique\.vn/);
  assert.doesNotMatch(message, /đơn giá|thành tiền|unit_price|50000/i);
});

test("uses a direct-delivery section when no NPP route exists", () => {
  const message = formatWarehouseOrderMessage({
    ...ORDER,
    requestedDeliveryDate: null,
    deliveryNote: null,
    lines: [{ ...ORDER.lines[0], routeCustomerName: null, routeNote: null }],
  });

  assert.match(message, /01\. NPP Anh Thanh/);
  assert.match(message, /Ngày giao: 04\/08\/2026/);
});

test("formats separate daily summaries from real dealer and point fields", () => {
  const orders = [
    ORDER,
    {
      ...ORDER,
      orderNumber: "DOP-20260803-EFGH5678",
      customerName: "Đại lý Mi Kho",
      lines: [
        {
          productName: "Bánh Mì Que Pate",
          unit: "que",
          orderedQuantity: 80,
          exchangeQuantity: 0,
          makeupQuantity: 3,
          physicalQuantity: 83,
          routeCustomerName: null,
          routeNote: "Nhận bao ly",
        },
      ],
    },
  ];
  const input = {
    digestDate: "2026-08-03",
    generatedAt: "2026-08-03T16:59:00Z",
    orders,
  };

  const dealerMessage = formatWarehouseDealerDailyDigest(input);
  assert.match(dealerMessage, /📦 TỔNG KẾT THEO ĐẠI LÝ — CUỐI NGÀY/);
  assert.match(dealerMessage, /2 đơn • 2 đại lý/);
  assert.match(dealerMessage, /01\. NPP Anh Thanh/);
  assert.match(dealerMessage, /02\. Đại lý Mi Kho/);
  assert.doesNotMatch(dealerMessage, /Điểm bán Quận 1/);

  const pointMessage = formatWarehousePointDailyDigest(input);
  assert.match(pointMessage, /📍 TỔNG KẾT THEO ĐIỂM BÁN — CUỐI NGÀY/);
  assert.match(pointMessage, /2 đơn • 3 điểm bán/);
  assert.match(pointMessage, /01\. Điểm bán Quận 1/);
  assert.match(pointMessage, /03\. Đại lý Mi Kho/);
  assert.match(pointMessage, /Đặt 80 \+ Bù 3/);
  assert.match(pointMessage, /→ GIAO 83 que/);
  assert.match(pointMessage, /📝 Ghi chú: Nhận bao ly/);

  for (const message of [dealerMessage, pointMessage]) {
    assert.match(message, /Ngày: 03\/08\/2026/);
    assert.match(message, /Đặt mới: 220 que/);
    assert.match(message, /Đổi: 2 que/);
    assert.match(message, /Bù: 11 que/);
    assert.match(message, /✅ KHO CẦN GIAO: 233 QUE/);
    assert.match(message, /Chốt lúc: 23:59/);
    assert.doesNotMatch(message, /đơn giá|thành tiền|unit_price|50000/i);
  }
});

test("caps a large daily digest while preserving full totals", () => {
  const orders = Array.from({ length: 200 }, (_, index) => ({
    ...ORDER,
    orderNumber: `DOP-${index}`,
    customerName: `Điểm bán rất dài số ${index + 1}`,
    lines: [{
      ...ORDER.lines[0],
      orderedQuantity: 10,
      exchangeQuantity: 0,
      makeupQuantity: 0,
      physicalQuantity: 10,
      routeCustomerName: null,
      routeNote: `Ghi chú giao hàng chi tiết số ${index + 1}`,
    }],
  }));
  for (const [formatter, omittedLabel] of [
    [formatWarehouseDealerDailyDigest, "đại lý"],
    [formatWarehousePointDailyDigest, "điểm bán"],
  ] as const) {
    const message = formatter({
      digestDate: "2026-08-03",
      generatedAt: "2026-08-03T16:59:00Z",
      orders,
    });

    assert.ok(message.length <= 9_500);
    assert.match(message, new RegExp(`Còn \\d+ ${omittedLabel}`));
    assert.match(message, /Đặt mới: 2\.000 que/);
    assert.match(message, /✅ KHO CẦN GIAO: 2\.000 QUE/);
  }
});

test("defaults delivery to the next Vietnam calendar day", () => {
  assert.equal(defaultDeliveryDateTPlusOne("2026-08-03T13:21:15.405225Z"), "2026-08-04");
  assert.equal(defaultDeliveryDateTPlusOne("2026-08-03T18:30:00Z"), "2026-08-05");
  assert.equal(defaultDeliveryDateTPlusOne("invalid"), null);
});

test("falls back to T+1 when an explicit delivery date is invalid", () => {
  for (const requestedDeliveryDate of ["2026-99-99", "2026-02-30", "not-a-date"]) {
    const message = formatWarehouseOrderMessage({
      ...ORDER,
      requestedDeliveryDate,
    });

    assert.match(message, /Ngày giao: 04\/08\/2026/);
  }
});

test("sends the official Zalo GMF text payload and returns message id", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({
      data: { message_id: "msg-123", group_id: "group-456" },
      error: 0,
      message: "Success",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await sendZaloGmfText({
    accessToken: "secret-token",
    groupId: "group-456",
    text: "hello",
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedUrl, "https://openapi.zalo.me/v3.0/oa/group/message");
  assert.equal(new Headers(capturedInit?.headers).get("access_token"), "secret-token");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    recipient: { group_id: "group-456" },
    message: { text: "hello" },
  });
  assert.equal(result.messageId, "msg-123");
  assert.equal(result.groupId, "group-456");
});

test("rejects a Zalo API error even when HTTP status is 200", async () => {
  const fakeFetch = async () => new Response(
    JSON.stringify({ error: -201, message: "Invalid group" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    sendZaloGmfText({
      accessToken: "secret-token",
      groupId: "bad-group",
      text: "hello",
      fetchImpl: fakeFetch,
    }),
    /Invalid group/,
  );
});

test("refreshes an OA token with Zalo v4 form encoding", async () => {
  let capturedUrl = "";
  let capturedHeaders: Headers | undefined;
  let capturedBody = "";
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = String(init?.body || "");
    return new Response(JSON.stringify({
      access_token: "access-next",
      refresh_token: "refresh-next",
      expires_in: 90000,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await refreshZaloOaAccessToken({
    appId: "123456",
    appSecret: "app-secret",
    refreshToken: "refresh-old",
    fetchImpl,
  });

  assert.equal(capturedUrl, "https://oauth.zaloapp.com/v4/oa/access_token");
  assert.equal(capturedHeaders?.get("secret_key"), "app-secret");
  assert.equal(capturedHeaders?.get("content-type"), "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(capturedBody)), {
    refresh_token: "refresh-old",
    app_id: "123456",
    grant_type: "refresh_token",
  });
  assert.deepEqual(result, {
    accessToken: "access-next",
    refreshToken: "refresh-next",
    expiresInSeconds: 90000,
  });
});
