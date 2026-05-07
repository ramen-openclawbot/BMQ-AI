import type { KitchenMovementType } from "./normalize";

export interface KitchenMovementLike {
  movement_type: KitchenMovementType;
  quantity: number | null;
  amount: number | null;
}

export interface KitchenOtherCostLike {
  amount: number | null;
}

export function money(value: number | null | undefined) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateMovementAmount(quantity: number | string, unitCost: number | string) {
  return numberValue(quantity) * numberValue(unitCost);
}

export function summarizeKitchenMovements(
  movements: KitchenMovementLike[],
  otherCosts: KitchenOtherCostLike[] = []
) {
  const usageAmount = movements
    .filter((movement) => movement.movement_type === "usage")
    .reduce((sum, movement) => sum + numberValue(movement.amount), 0);
  const purchaseAmount = movements
    .filter((movement) => movement.movement_type === "purchase")
    .reduce((sum, movement) => sum + numberValue(movement.amount), 0);
  const otherAmount = otherCosts.reduce((sum, cost) => sum + numberValue(cost.amount), 0);

  return {
    usageAmount,
    purchaseAmount,
    otherAmount,
    totalKitchenCost: usageAmount + otherAmount,
  };
}

export function deriveSystemEndingQty(params: {
  openingQty: number;
  purchaseQty: number;
  usageQty: number;
  adjustmentQty: number;
}) {
  return params.openingQty + params.purchaseQty - params.usageQty + params.adjustmentQty;
}
