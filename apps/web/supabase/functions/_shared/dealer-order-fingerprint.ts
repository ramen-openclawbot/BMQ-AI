export type DealerOrderFingerprintLine = {
  sku_id: string;
  quantity: number;
  exchange_quantity: number;
  makeup_quantity: number;
  physical_quantity?: number;
  route_customer_id: string | null;
  route_customer_name?: string | null;
};

const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

export function canonicalPhysicalQuantity(
  orderedQuantity: number,
  exchangeQuantity: number,
  makeupQuantity: number,
) {
  return roundQuantity(orderedQuantity + exchangeQuantity + makeupQuantity);
}

export async function computeOrderFingerprint(input: {
  requestedDeliveryDate: string;
  lines: DealerOrderFingerprintLine[];
}) {
  const canonicalLines = input.lines
    .map((line) => ({
      sku_id: line.sku_id,
      route: typeof line.route_customer_id === "string" && line.route_customer_id.trim()
        ? line.route_customer_id.trim()
        : "direct",
      quantity: roundQuantity(line.quantity),
      exchange_quantity: roundQuantity(line.exchange_quantity),
      makeup_quantity: roundQuantity(line.makeup_quantity),
      physical_quantity: canonicalPhysicalQuantity(
        line.quantity,
        line.exchange_quantity,
        line.makeup_quantity,
      ),
    }))
    .sort((left, right) => `${left.sku_id}:${left.route}`.localeCompare(`${right.sku_id}:${right.route}`));
  const bytes = new TextEncoder().encode(JSON.stringify({
    requested_delivery_date: input.requestedDeliveryDate,
    lines: canonicalLines,
  }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
