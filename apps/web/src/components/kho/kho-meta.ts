import { STOCK_UNITS } from "@/lib/stock-units";
import { hasTanTaoPlace, type KhoItem, type KhoLocation } from "@/lib/kho-items";
import type { WarehouseGamePendingRow } from "@/lib/warehouse-game";

/** Shared words and helpers of the Kho pages (Danh mục kho, Kiểm kê, Phiếu kho). */

export const KHO_LABEL: Record<KhoLocation, string> = { tan_tao: "Tân Tạo", q7: "Q7" };
export const KHO_LOCATIONS: KhoLocation[] = ["tan_tao", "q7"];

export type ItemClass = "raw_material" | "packaging_supply" | "finished_goods" | "non_stock" | "unclassified";
const CLASS_ORDER: ItemClass[] = ["raw_material", "packaging_supply", "finished_goods", "non_stock", "unclassified"];

export const CLASS_LABEL: Record<ItemClass, string> = {
  raw_material: "Nguyên liệu",
  packaging_supply: "Bao bì / vật tư",
  finished_goods: "Thành phẩm",
  non_stock: "Không tồn kho",
  unclassified: "Chưa có nhóm",
};

export function asClass(value: string | null | undefined): ItemClass {
  return (CLASS_ORDER as string[]).includes(value ?? "") ? (value as ItemClass) : "unclassified";
}

/** Danh mục groups (owner 21/10): Nguyên liệu · Bao bì & vật tư · Thành phẩm. */
export type Group = "nl" | "bb" | "tp";
export const GROUPS: { id: Group; label: string }[] = [
  { id: "nl", label: "Nguyên liệu" },
  { id: "bb", label: "Bao bì & vật tư" },
  { id: "tp", label: "Thành phẩm" },
];
/** non_stock goods (cleaning goods, ice) are supplies; unclassified reads as Nguyên liệu. */
export function groupOf(item: KhoItem): Group {
  if (item.item_class === "packaging_supply" || item.item_class === "non_stock") return "bb";
  if (item.item_class === "finished_goods") return "tp";
  return "nl";
}
export const CLASS_OF: Record<Exclude<Group, "tp">, "raw_material" | "packaging_supply"> = { nl: "raw_material", bb: "packaging_supply" };

/** An item can have a place at both kho (owner 22/10): in_q7 / in_tan_tao. */
export const atKho = (item: KhoItem, kho: KhoLocation) =>
  kho === "q7" ? item.in_q7 : hasTanTaoPlace(item);

/** Which items belong on a warehouse's count list. */
export function inCountList(item: KhoItem, loc: KhoLocation): boolean {
  if (!item.active) return false;
  if (loc === "q7") return item.in_q7;
  return hasTanTaoPlace(item) || (item.qty.tan_tao ?? 0) !== 0;
}

/** Units an item may be stored in (owner rule: g / ml, never kg / l). */
export const ITEM_UNITS: string[] = STOCK_UNITS.filter((unit) => unit.code === unit.baseCode).map((unit) => unit.code);

export function normalizeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

const num = (value: number, digits = 2) => value.toLocaleString("vi-VN", { maximumFractionDigits: digits });

export function fmtQty(value: number): string {
  return num(value);
}

/** 166415 g reads as 166,42 kg; ml as lít. Other units stay as they are; a missing figure is a dash. */
export function fmtAmount(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const u = unit.trim().toLowerCase();
  if (u === "g" && Math.abs(value) >= 1000) return `${num(value / 1000)} kg`;
  if (u === "ml" && Math.abs(value) >= 1000) return `${num(value / 1000)} lít`;
  return `${num(value)} ${unit}`;
}

/** Units a person may type a count in: g items also take kg, ml items also take lít. */
export function countUnits(unit: string): { label: string; factor: number }[] {
  const u = unit.trim().toLowerCase();
  if (u === "g") return [{ label: "kg", factor: 1000 }, { label: "g", factor: 1 }];
  if (u === "ml") return [{ label: "lít", factor: 1000 }, { label: "ml", factor: 1 }];
  return [{ label: unit, factor: 1 }];
}

/** "1,5" and "1.5" are both 1.5; with a comma present dots are thousands ("1.250,5"). */
export const parseNum = (text: string) => {
  const t = text.trim().replace(/\s+/g, "");
  return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
};

export const todayVN = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
export const dmy = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : null);

export const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(".", "");

/** Stable key of one pending receipt name: supplier + normalized name. */
export const crateKey = (row: WarehouseGamePendingRow) => `${row.supplier_id ?? "-"}|${row.normalized_name}`;

/** Receipt name → a clean catalog name: no [tags], no "/ English", no "ngày 10" or trailing day number. */
export function cleanCrateName(raw: string): string {
  let name = raw.replace(/^\s*(\[[^\]]*\]\s*)+/, "").split("/")[0];
  name = name.replace(/\bng[aà]y\s*\d{1,2}\b/giu, " ").replace(/\s+\d{1,2}\s*$/u, "").replace(/\s+/g, " ").trim();
  if (!name) return raw.trim();
  if (name === name.toUpperCase() && /\p{L}/u.test(name)) name = name.toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A name-match candidate worth showing. One shared word ("bánh", "nhãn") gives a 0.63 token score that ties
 * across many items (owner 12/10: "Nhãn Bánh Pháp" → "Chất làm mềm bánh"), so token-only matches need ≥ 0.75.
 */
export function strongCandidate(crate: WarehouseGamePendingRow) {
  const c = crate.top_candidate;
  if (!c?.name) return null;
  const tokenOnly = (c.reason ?? "").includes("token");
  return tokenOnly && Number(c.score ?? 0) < 0.75 ? null : c;
}
