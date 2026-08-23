import assert from "node:assert/strict";
import test from "node:test";
import { parseTanTaoWarehouseCommand } from "./tan-tao-warehouse.ts";

test("owner opening declaration becomes a trusted opening command", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Tồn đầu BMQ-001 350 que"), {
    type: "opening",
    quantity: 350,
    skuCode: "BMQ-001",
  });
});

test("supplier order creates expected inbound instead of receipt", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Đặt Tuyết Anh 2480"), {
    type: "supplier_order",
    quantity: 2480,
    skuCode: "BMQ-001",
  });
});

test("receipt confirmation is distinct from supplier order", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Đã nhận đủ 2.480 que"), {
    type: "receipt",
    quantity: 2480,
    skuCode: "BMQ-001",
  });
});

test("dealer physical reservation is server-derived from ordered exchange and makeup", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Anh Thanh đặt 780 đổi 16 bù 101"), {
    type: "outbound_order",
    orderedQuantity: 780,
    exchangeQuantity: 16,
    makeupQuantity: 101,
    physicalQuantity: 897,
    skuCode: "BMQ-001",
    referenceLabel: "Anh Thanh",
  });
});

test("physical count becomes a stock-count command", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Kiểm kê thực tế còn 172 que"), {
    type: "stock_count",
    quantity: 172,
    skuCode: "BMQ-001",
  });
});

test("dispatch confirmation references the reserved outbound document", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Đã giao TT-OUT-20260823-ABC123"), {
    type: "dispatch",
    sourceDocumentNumber: "TT-OUT-20260823-ABC123",
    skuCode: "BMQ-001",
  });
});

test("reservation cancellation releases ATP without deleting history", () => {
  assert.deepEqual(parseTanTaoWarehouseCommand("Huỷ giữ TT-OUT-20260823-ABC123"), {
    type: "cancel_outbound",
    sourceDocumentNumber: "TT-OUT-20260823-ABC123",
    skuCode: "BMQ-001",
  });
});

test("unknown prose never creates a warehouse command", () => {
  assert.equal(parseTanTaoWarehouseCommand("Hôm nay kho ổn không em?"), null);
});
