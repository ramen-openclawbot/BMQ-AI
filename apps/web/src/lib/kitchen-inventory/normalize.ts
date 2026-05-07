export type KitchenItemType = "ingredient" | "tool_supply";
export type ApprovalDecision = "APPROVE" | "REVIEW" | "REJECT";
export type KitchenMovementType = "opening" | "purchase" | "usage" | "stock_count" | "adjustment";

const VIETNAMESE_MARKS = /[\u0300-\u036f]/g;

export function normalizeKitchenText(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(VIETNAMESE_MARKS, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeKitchenUnit(value: string | null | undefined) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function normalizeKitchenItemType(value: string | null | undefined): KitchenItemType {
  const normalized = normalizeKitchenText(value);
  if (normalized.includes("ccdc") || normalized.includes("cong cu") || normalized.includes("vat tu")) {
    return "tool_supply";
  }
  return "ingredient";
}

export function buildKitchenItemKey(params: {
  itemType: KitchenItemType | string | null | undefined;
  name: string | null | undefined;
  unit: string | null | undefined;
}) {
  const itemType = normalizeKitchenItemType(params.itemType);
  const name = normalizeKitchenText(params.name);
  const unit = normalizeKitchenText(params.unit);
  return `${itemType}:${name}:${unit}`;
}

export function normalizeApprovalDecision(value: string | null | undefined): ApprovalDecision {
  const normalized = normalizeKitchenText(value).toUpperCase();
  if (normalized.includes("REJECT") || normalized.includes("TU CHOI") || normalized.includes("KHONG DUYET")) {
    return "REJECT";
  }
  if (normalized.includes("REVIEW") || normalized.includes("CAN") || normalized.includes("XEM LAI")) {
    return "REVIEW";
  }
  if (["APPROVE", "APPROVED", "DUYET", "DA DUYET", "OK", "YES", "Y"].includes(normalized)) {
    return "APPROVE";
  }
  return "REVIEW";
}

export function periodMonthFromDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-01`;
}
