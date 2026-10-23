/**
 * Pure data layer for kho lot information, shelf life and the ATTP vault.
 *
 * Server contracts:
 *   kho_set_receipt_line_lot(uuid, date, date, text, text, uuid)
 *   kho_manufacturer_suggest(uuid)
 *   kho_expiry_overview(int)
 *   sku_set_shelf_life(uuid, int, uuid)
 *   food_cert_list(text, uuid, int), food_cert_upsert(...), food_cert_archive(...)
 *   food_manufacturer_list(text)
 *
 * Nothing here posts stock or touches the ledger.  The helpers are pure so the
 * UI can render expiry badges and certificate labels without a database read.
 */

export type KhoLocation = "tan_tao" | "q7";

/** The four lot fields copied from a receipt line to its inventory batches. */
export interface ReceiptLineLot {
  receipt_item_id: string;
  manufacture_date: string | null;
  expiry_date: string | null;
  manufacturer_lot: string | null;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  batches_updated: number;
  item_default_set: boolean;
  replayed: boolean;
}

export interface ManufacturerSuggestion {
  manufacturer_id: string | null;
  name: string | null;
}

export interface ExpiryOverviewRow {
  batch_id: string;
  item_id: string | null;
  sku_id: string | null;
  name: string;
  kho: KhoLocation;
  receipt_number: string | null;
  received_date: string | null;
  quantity: number | null;
  unit: string | null;
  manufacture_date: string | null;
  expiry_date: string;
  days_left: number;
  manufacturer_lot: string | null;
  manufacturer_name: string | null;
}

export type ScanLotLabelOcrEngine = "indra" | "deepseek";

/** Only values printed on the label; every missing field is null. */
export interface ScanLotLabelFields {
  manufacture_date: string | null;
  expiry_date: string | null;
  lot: string | null;
  manufacturer: string | null;
  product_name: string | null;
  evidence_text: string | null;
}

export interface ScanLotLabelResult extends ScanLotLabelFields {
  ok: true;
  ocr_engine: ScanLotLabelOcrEngine;
  ocr_fallback_reason: string | null;
}

export type FoodCertOwnerKind = "manufacturer" | "item" | "supplier" | "company";

export type FoodCertType =
  | "attp_facility"
  | "coa"
  | "product_declaration"
  | "other";

export const FOOD_CERT_TYPE_LABELS: Record<FoodCertType, string> = {
  attp_facility: "Giấy chứng nhận cơ sở đủ điều kiện ATTP",
  coa: "Phiếu kiểm nghiệm (COA)",
  product_declaration: "Bản công bố sản phẩm",
  other: "Giấy tờ khác",
};

export const FOOD_CERT_OWNER_KIND_LABELS: Record<FoodCertOwnerKind, string> = {
  manufacturer: "Nhà sản xuất",
  item: "Hàng kho",
  supplier: "Nhà cung cấp",
  company: "Công ty",
};

export interface FoodCert {
  id: string;
  owner_kind: FoodCertOwnerKind;
  owner_id: string | null;
  owner_name: string | null;
  cert_type: FoodCertType;
  cert_no: string | null;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  days_left: number | null;
  file_path: string;
  file_name: string | null;
  mime_type: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
  archived_by: string | null;
  replayed?: boolean;
}

export interface FoodCertListParams {
  ownerKind?: FoodCertOwnerKind | null;
  ownerId?: string | null;
  expiringDays?: number | null;
}

export interface FoodManufacturer {
  id: string;
  name: string;
  address: string | null;
  tax_code: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FoodCertUploadResult {
  file_path: string;
  file_name: string;
  mime_type: string | null;
}

export type ExpiryTone = "expired" | "soon" | "ok";

export const EXPIRY_SOON_DAYS = 30;

function isoDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDay(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let year: number;
  let month: number;
  let day: number;
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (ymd) {
    year = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  } else {
    const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(raw);
    if (!dmy) return null;
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  }

  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/**
 * Calendar days from `today` to `expiryDate`.  Negative means already expired,
 * 0 means it expires today, and null means there is no valid expiry date.
 */
export function daysLeft(
  expiryDate: string | Date | null | undefined,
  today: Date | string = new Date(),
): number | null {
  const expiry = parseDay(expiryDate);
  if (expiry === null) return null;
  const base = parseDay(today);
  if (base === null) return null;
  return Math.round((expiry - base) / 86_400_000);
}

/**
 * 30-day threshold: < 0 expired, 0..30 soon, > 30 ok.
 * Accepts either the pre-computed day count or an expiry date string/Date.
 */
export function expiryTone(
  value: number | string | Date | null | undefined,
  today: Date | string = new Date(),
): ExpiryTone | null {
  if (value === null || value === undefined) return null;
  const days = typeof value === "number" ? value : daysLeft(value, today);
  if (days === null || !Number.isFinite(days)) return null;
  if (days < 0) return "expired";
  if (days <= EXPIRY_SOON_DAYS) return "soon";
  return "ok";
}

/** Convenience for a date string and an optional reference day. */
export function expiryToneForDate(
  expiryDate: string | Date | null | undefined,
  today: Date | string = new Date(),
): ExpiryTone | null {
  return expiryTone(expiryDate, today);
}

export function foodCertTypeLabel(value: string | null | undefined): string {
  const key = String(value ?? "") as FoodCertType;
  return FOOD_CERT_TYPE_LABELS[key] ?? FOOD_CERT_TYPE_LABELS.other;
}

export function todayIso(now: Date = new Date()): string {
  return isoDay(now);
}
