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
  lines: DealerCartProposalLine[];
};

export type DealerCartSummary = {
  total_amount_vnd: number;
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
