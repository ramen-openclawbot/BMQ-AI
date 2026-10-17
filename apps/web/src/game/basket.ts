import type { WarehouseGameItem } from "@/lib/warehouse-game";
import { newRequestId } from "./meta";

/** One line in the robot's basket. Quantities and prices stay text until sent. */
export interface BasketLine {
  key: string;
  item_id: string | null;
  name: string;
  unit: string;
  qty: string;
  supplier_id: string | null;
  price: string;
}

const BASKET_KEY = "bmq-robot-basket-v1";
export function loadBasket(): BasketLine[] {
  try { return JSON.parse(sessionStorage.getItem(BASKET_KEY) ?? "[]") as BasketLine[]; } catch { return []; }
}
export function saveBasket(lines: BasketLine[]) {
  try { sessionStorage.setItem(BASKET_KEY, JSON.stringify(lines)); } catch { /* private mode */ }
}
export const basketLineFor = (item: Pick<WarehouseGameItem, "id" | "name" | "unit">): BasketLine =>
  ({ key: newRequestId(), item_id: item.id, name: item.name, unit: item.unit, qty: "", supplier_id: null, price: "" });
