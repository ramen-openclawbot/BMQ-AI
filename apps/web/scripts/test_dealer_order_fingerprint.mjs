#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  canonicalPhysicalQuantity,
  computeOrderFingerprint,
} from "../supabase/functions/_shared/dealer-order-fingerprint.ts";

const baseLine = {
  sku_id: "11111111-1111-4111-8111-111111111111",
  quantity: 60,
  exchange_quantity: 4,
  makeup_quantity: 3,
  physical_quantity: 9999,
  route_customer_id: null,
  route_customer_name: "Đại lý do trình duyệt gửi",
};

assert.equal(
  canonicalPhysicalQuantity(baseLine.quantity, baseLine.exchange_quantity, baseLine.makeup_quantity),
  67,
  "physical quantity must be derived from ordered + exchange + makeup",
);

const first = await computeOrderFingerprint({
  requestedDeliveryDate: "2026-08-07",
  lines: [baseLine],
});
const sameOrderWithTamperedClientFields = await computeOrderFingerprint({
  requestedDeliveryDate: "2026-08-07",
  lines: [{
    ...baseLine,
    physical_quantity: 1,
    route_customer_name: "Tên hiển thị khác",
  }],
});
assert.equal(
  sameOrderWithTamperedClientFields,
  first,
  "direct-order fingerprint must ignore browser physical quantity and display route text",
);

const routedOrder = await computeOrderFingerprint({
  requestedDeliveryDate: "2026-08-07",
  lines: [{
    ...baseLine,
    route_customer_id: "22222222-2222-4222-8222-222222222222",
    route_customer_name: "Tên tuyến A",
  }],
});
const sameRoutedOrderWithDifferentDisplay = await computeOrderFingerprint({
  requestedDeliveryDate: "2026-08-07",
  lines: [{
    ...baseLine,
    physical_quantity: 123,
    route_customer_id: "22222222-2222-4222-8222-222222222222",
    route_customer_name: "Tên tuyến B",
  }],
});
assert.equal(
  sameRoutedOrderWithDifferentDisplay,
  routedOrder,
  "routed-order fingerprint must use validated route id, not browser display text",
);
assert.notEqual(routedOrder, first, "direct and routed orders must remain distinct");

const legacyCompatiblePayload = {
  requested_delivery_date: "2026-08-07",
  lines: [{
    sku_id: baseLine.sku_id,
    route: "22222222-2222-4222-8222-222222222222",
    quantity: 60,
    exchange_quantity: 4,
    makeup_quantity: 3,
    physical_quantity: 67,
  }],
};
const legacyBytes = new TextEncoder().encode(JSON.stringify(legacyCompatiblePayload));
const legacyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", legacyBytes));
const legacyFingerprint = Array.from(legacyDigest)
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
assert.equal(
  routedOrder,
  legacyFingerprint,
  "server-derived physical quantity must preserve compatibility with valid routed fingerprints",
);

console.log("dealer order fingerprint runtime tests passed");
