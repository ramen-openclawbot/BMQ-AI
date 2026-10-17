/**
 * Pure client helpers for the dealer cart assistant. The server has already
 * validated products, quantities and prices; this module only applies the
 * returned proposal to the portal's `Record<product_id, quantity>` state.
 * No UI is wired here.
 */

export const DEALER_CART_STEP = 10;

export type DealerCartMode = "merge" | "replace";

export type DealerCartProposalLine = {
  product_id: string;
  sku_code?: string | null;
  product_name?: string | null;
  unit?: string | null;
  unit_price?: number | string | null;
  quantity: number | string;
};

export type DealerCartProposal = {
  mode: DealerCartMode;
  kind?: "products";
  lines: DealerCartProposalLine[];
};

export type DealerRouteProposalLine = {
  route_id: string;
  route_name?: string | null;
  product_id: string;
  sku_code?: string | null;
  product_name?: string | null;
  unit?: string | null;
  unit_price?: number | string | null;
  quantity: number | string;
  exchange_quantity: number | string;
  makeup_quantity: number | string;
  note?: string | null;
};

export type DealerRouteProposal = {
  mode: DealerCartMode;
  kind: "routes";
  lines: DealerRouteProposalLine[];
};

export type DealerCartSummary = {
  total_amount_vnd: number;
  line_count: number;
};

export type DealerRouteSummary = {
  total_amount_vnd: number;
  physical_quantity: number;
  line_count: number;
};

const roundUpToStep = (quantity: number, step = DEALER_CART_STEP): number =>
  Math.ceil(quantity / step) * step;

/**
 * Apply a server proposal to the current quantities.
 * - merge: add to the existing quantity, then round the sum up to a step of 10.
 * - replace: drop every product not present in the proposal.
 */
export function applyCartProposal(
  current: Record<string, number>,
  proposal: DealerCartProposal | null | undefined,
  mode: DealerCartMode = proposal?.mode || "merge",
): Record<string, number> {
  const next: Record<string, number> = mode === "merge" ? { ...current } : {};

  (proposal?.lines || []).forEach((line) => {
    const productId = String(line?.product_id || "").trim();
    const quantity = Number(line?.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) return;

    const rounded = roundUpToStep(quantity);
    if (mode === "merge") {
      const existing = Number(next[productId]) || 0;
      next[productId] = roundUpToStep(existing + rounded);
    } else {
      next[productId] = rounded;
    }
  });

  return next;
}

/** Total value and line count of a proposal, using the server-provided prices. */
export function summarizeProposal(
  proposal: DealerCartProposal | null | undefined,
): DealerCartSummary {
  const lines = proposal?.lines || [];
  return {
    total_amount_vnd: lines.reduce((total, line) => {
      const price = Number(line?.unit_price) || 0;
      const quantity = Number(line?.quantity) || 0;
      return total + price * quantity;
    }, 0),
    line_count: lines.length,
  };
}

const routeQuantity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const routePhysicalQuantity = (line: DealerRouteProposalLine): number =>
  routeQuantity(line?.quantity) + routeQuantity(line?.exchange_quantity) + routeQuantity(line?.makeup_quantity);

/**
 * Apply a server route proposal to the current per-route lines.
 * - merge: sum quantity per route + product, then round up to 10; extras and
 *   notes are merged too.
 * - replace: keep only the proposal lines.
 * Lines with no quantity, exchange or makeup are dropped.
 */
export function applyRouteProposal(
  current: DealerRouteProposalLine[],
  proposal: DealerRouteProposal | null | undefined,
  mode: DealerCartMode = proposal?.mode || "merge",
): DealerRouteProposalLine[] {
  const next = new Map<string, DealerRouteProposalLine>();

  if (mode === "merge") {
    (current || []).forEach((line) => {
      const routeId = String(line?.route_id || "").trim();
      const productId = String(line?.product_id || "").trim();
      if (!routeId || !productId) return;
      next.set(`${routeId}::${productId}`, {
        ...line,
        route_id: routeId,
        product_id: productId,
        quantity: routeQuantity(line.quantity),
        exchange_quantity: Math.round(routeQuantity(line.exchange_quantity)),
        makeup_quantity: Math.round(routeQuantity(line.makeup_quantity)),
      });
    });
  }

  (proposal?.lines || []).forEach((line) => {
    const routeId = String(line?.route_id || "").trim();
    const productId = String(line?.product_id || "").trim();
    if (!routeId || !productId) return;

    const key = `${routeId}::${productId}`;
    const proposedQuantity = roundUpToStep(routeQuantity(line.quantity));
    const proposedExchange = Math.round(routeQuantity(line.exchange_quantity));
    const proposedMakeup = Math.round(routeQuantity(line.makeup_quantity));
    const proposedNote = typeof line.note === "string" ? line.note.trim() : "";
    const existing = next.get(key);

    if (mode === "merge" && existing) {
      next.set(key, {
        ...existing,
        quantity: roundUpToStep(routeQuantity(existing.quantity) + proposedQuantity),
        exchange_quantity: Math.round(routeQuantity(existing.exchange_quantity)) + proposedExchange,
        makeup_quantity: Math.round(routeQuantity(existing.makeup_quantity)) + proposedMakeup,
        note: proposedNote || existing.note,
      });
      return;
    }

    next.set(key, {
      ...line,
      route_id: routeId,
      product_id: productId,
      quantity: proposedQuantity,
      exchange_quantity: proposedExchange,
      makeup_quantity: proposedMakeup,
      note: proposedNote || line.note || "",
    });
  });

  return Array.from(next.values()).filter((line) => routePhysicalQuantity(line) > 0);
}

/** Total value, physical quantity and line count of route proposal lines. */
export function summarizeRouteProposal(lines: DealerRouteProposalLine[]): DealerRouteSummary {
  const safeLines = Array.isArray(lines) ? lines : [];
  return {
    total_amount_vnd: safeLines.reduce((total, line) => {
      const price = Number(line?.unit_price) || 0;
      const quantity = routeQuantity(line?.quantity);
      return total + price * quantity;
    }, 0),
    physical_quantity: safeLines.reduce((total, line) => total + routePhysicalQuantity(line), 0),
    line_count: safeLines.length,
  };
}
