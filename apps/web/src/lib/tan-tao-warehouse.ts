export type TanTaoWarehouseCommand =
  | { type: "opening"; quantity: number; skuCode: "BMQ-001" }
  | { type: "supplier_order"; quantity: number; skuCode: "BMQ-001" }
  | { type: "receipt"; quantity: number; skuCode: "BMQ-001" }
  | {
      type: "outbound_order";
      orderedQuantity: number;
      exchangeQuantity: number;
      makeupQuantity: number;
      physicalQuantity: number;
      skuCode: "BMQ-001";
      referenceLabel: string;
    }
  | { type: "stock_count"; quantity: number; skuCode: "BMQ-001" }
  | { type: "dispatch"; sourceDocumentNumber: string; skuCode: "BMQ-001" }
  | { type: "cancel_outbound"; sourceDocumentNumber: string; skuCode: "BMQ-001" };

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .replace(/Đ/g, "D")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

const quantity = (value?: string): number => {
  if (!value) return 0;
  const parsed = Number(value.replace(/[.,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function parseTanTaoWarehouseCommand(input: string): TanTaoWarehouseCommand | null {
  const original = input.trim();
  const text = normalize(original);
  if (!text) return null;

  const opening = text.match(/^ton dau(?:\s+bmq-001)?\s+([\d.,]+)(?:\s+que)?$/);
  if (opening) {
    const parsed = quantity(opening[1]);
    return parsed > 0 ? { type: "opening", quantity: parsed, skuCode: "BMQ-001" } : null;
  }

  const supplierOrder = text.match(/^dat\s+tuyet\s+anh\s+([\d.,]+)(?:\s+que)?$/);
  if (supplierOrder) {
    const parsed = quantity(supplierOrder[1]);
    return parsed > 0 ? { type: "supplier_order", quantity: parsed, skuCode: "BMQ-001" } : null;
  }

  const receipt = text.match(/^da\s+nhan\s+(?:du\s+)?([\d.,]+)(?:\s+que)?$/);
  if (receipt) {
    const parsed = quantity(receipt[1]);
    return parsed > 0 ? { type: "receipt", quantity: parsed, skuCode: "BMQ-001" } : null;
  }

  const stockCount = text.match(/^kiem\s+ke(?:\s+thuc\s+te)?\s+con\s+([\d.,]+)(?:\s+que)?$/);
  if (stockCount) {
    const parsed = quantity(stockCount[1]);
    return { type: "stock_count", quantity: parsed, skuCode: "BMQ-001" };
  }

  const dispatch = text.match(/^da\s+giao\s+(tt-[a-z0-9-]+)$/);
  if (dispatch) {
    return { type: "dispatch", sourceDocumentNumber: dispatch[1].toUpperCase(), skuCode: "BMQ-001" };
  }

  const cancellation = text.match(/^huy\s+giu\s+(tt-[a-z0-9-]+)$/);
  if (cancellation) {
    return { type: "cancel_outbound", sourceDocumentNumber: cancellation[1].toUpperCase(), skuCode: "BMQ-001" };
  }

  const outbound = text.match(/^(.+?)\s+dat\s+([\d.,]+)(?:\s+doi\s+([\d.,]+))?(?:\s+bu\s+([\d.,]+))?(?:\s+que)?$/);
  if (outbound) {
    const orderedQuantity = quantity(outbound[2]);
    const exchangeQuantity = quantity(outbound[3]);
    const makeupQuantity = quantity(outbound[4]);
    const physicalQuantity = orderedQuantity + exchangeQuantity + makeupQuantity;
    const originalLabel = original.split(/\s+đặt\s+/i)[0]?.trim() || outbound[1].trim();
    if (physicalQuantity <= 0 || !originalLabel) return null;
    return {
      type: "outbound_order",
      orderedQuantity,
      exchangeQuantity,
      makeupQuantity,
      physicalQuantity,
      skuCode: "BMQ-001",
      referenceLabel: originalLabel,
    };
  }

  return null;
}
