export type RetailQuickOrderCandidateItem = {
  skuId: string;
  skuCode: string;
  productName: string;
  unit: string | null;
  orderedQuantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  routeCustomerId: string | null;
};

export type RetailQuickOrderCandidate = {
  id: string;
  orderNumber: string;
  requestedDeliveryDate: string;
  submittedAt: string;
  items: RetailQuickOrderCandidateItem[];
};

export type RetailQuickOrderResult = {
  target_delivery_date: string;
  already_ordered: { order_number: string } | null;
  suggestion: {
    source_order_id: string;
    source_order_number: string;
    source_delivery_date: string;
    items: Array<{
      sku_id: string;
      sku_code: string;
      product_name: string;
      unit: string;
      ordered_quantity: number;
      exchange_quantity: 0;
      makeup_quantity: 0;
      physical_quantity: number;
    }>;
  } | null;
};

export function buildRetailQuickOrderSuggestion(input: {
  targetDeliveryDate: string;
  existingOrder: { orderNumber: string } | null;
  candidateOrders: RetailQuickOrderCandidate[];
}): RetailQuickOrderResult {
  if (input.existingOrder) {
    return {
      target_delivery_date: input.targetDeliveryDate,
      already_ordered: { order_number: input.existingOrder.orderNumber },
      suggestion: null,
    };
  }

  for (const order of input.candidateOrders) {
    if (order.items.some((item) => Boolean(item.routeCustomerId))) continue;
    const breadItems = order.items.filter((item) =>
      item.skuCode.trim().toUpperCase() === "BMQ-001" && Number.isFinite(item.orderedQuantity) && item.orderedQuantity > 0
    );
    if (breadItems.length === 0) continue;

    return {
      target_delivery_date: input.targetDeliveryDate,
      already_ordered: null,
      suggestion: {
        source_order_id: order.id,
        source_order_number: order.orderNumber,
        source_delivery_date: order.requestedDeliveryDate,
        items: breadItems.map((item) => ({
          sku_id: item.skuId,
          sku_code: item.skuCode,
          product_name: item.productName,
          unit: item.unit || "que",
          ordered_quantity: item.orderedQuantity,
          exchange_quantity: 0,
          makeup_quantity: 0,
          physical_quantity: item.orderedQuantity,
        })),
      },
    };
  }

  return {
    target_delivery_date: input.targetDeliveryDate,
    already_ordered: null,
    suggestion: null,
  };
}
