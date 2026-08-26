import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildRetailQuickOrderSuggestion } from "./dealer-quick-order.ts";

Deno.test("retail quick reorder copies ordered quantities but resets exchange and makeup", () => {
  const result = buildRetailQuickOrderSuggestion({
    targetDeliveryDate: "2026-08-27",
    existingOrder: null,
    candidateOrders: [{
      id: "order-1",
      orderNumber: "DOP-1",
      requestedDeliveryDate: "2026-08-26",
      submittedAt: "2026-08-25T12:00:00Z",
      items: [{
        skuId: "sku-1",
        skuCode: "BMQ-001",
        productName: "Bánh mì que Pate",
        unit: "que",
        orderedQuantity: 120,
        exchangeQuantity: 7,
        makeupQuantity: 3,
        routeCustomerId: null,
      }],
    }],
  });

  assertEquals(result, {
    target_delivery_date: "2026-08-27",
    already_ordered: null,
    suggestion: {
      source_order_id: "order-1",
      source_order_number: "DOP-1",
      source_delivery_date: "2026-08-26",
      items: [{
        sku_id: "sku-1",
        sku_code: "BMQ-001",
        product_name: "Bánh mì que Pate",
        unit: "que",
        ordered_quantity: 120,
        exchange_quantity: 0,
        makeup_quantity: 0,
        physical_quantity: 120,
      }],
    },
  });
});

Deno.test("retail quick reorder suppresses suggestion when target day already has an order", () => {
  const result = buildRetailQuickOrderSuggestion({
    targetDeliveryDate: "2026-08-27",
    existingOrder: { orderNumber: "DOP-TODAY" },
    candidateOrders: [],
  });

  assertEquals(result, {
    target_delivery_date: "2026-08-27",
    already_ordered: { order_number: "DOP-TODAY" },
    suggestion: null,
  });
});

Deno.test("retail quick reorder ignores routed NPP orders and empty ordered quantities", () => {
  const result = buildRetailQuickOrderSuggestion({
    targetDeliveryDate: "2026-08-27",
    existingOrder: null,
    candidateOrders: [
      {
        id: "npp-order",
        orderNumber: "DOP-NPP",
        requestedDeliveryDate: "2026-08-26",
        submittedAt: "2026-08-25T12:00:00Z",
        items: [{ skuId: "sku-1", skuCode: "BMQ-001", productName: "Bánh mì que", unit: "que", orderedQuantity: 100, exchangeQuantity: 0, makeupQuantity: 0, routeCustomerId: "route-1" }],
      },
      {
        id: "empty-order",
        orderNumber: "DOP-EMPTY",
        requestedDeliveryDate: "2026-08-25",
        submittedAt: "2026-08-24T12:00:00Z",
        items: [{ skuId: "sku-1", skuCode: "BMQ-001", productName: "Bánh mì que", unit: "que", orderedQuantity: 0, exchangeQuantity: 5, makeupQuantity: 0, routeCustomerId: null }],
      },
    ],
  });

  assertEquals(result.suggestion, null);
});