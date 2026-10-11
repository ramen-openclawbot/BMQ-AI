import { C } from "./theme";
import { STOCK_UNITS } from "@/lib/stock-units";

export type GameClass = "raw_material" | "packaging_supply" | "finished_goods" | "non_stock" | "unclassified";

export const CLASS_ORDER: GameClass[] = ["raw_material", "packaging_supply", "finished_goods", "non_stock", "unclassified"];

export const CLASS_META: Record<GameClass, { label: string; icon: string; tint: string }> = {
  raw_material: { label: "Nguyên liệu", icon: "🌾", tint: C.mustard },
  packaging_supply: { label: "Bao bì / vật tư", icon: "📦", tint: C.plum },
  finished_goods: { label: "Thành phẩm", icon: "🥖", tint: C.coral },
  non_stock: { label: "Không tồn kho", icon: "🧹", tint: "#a7a39a" },
  unclassified: { label: "Chưa có nhóm", icon: "❔", tint: C.kraft },
};

export function asClass(value: string | null | undefined): GameClass {
  return (CLASS_ORDER as string[]).includes(value ?? "") ? (value as GameClass) : "unclassified";
}

/** Units an item may be stored in (owner rule: g / ml, never kg / l). */
export const ITEM_UNITS: string[] = STOCK_UNITS.filter((unit) => unit.code === unit.baseCode).map((unit) => unit.code);

export function normalizeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

export function fmtQty(value: number): string {
  return value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

export const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(".", "");
