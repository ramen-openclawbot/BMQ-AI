/**
 * Typed data layer for the supplier profile (Hồ sơ nhà cung cấp) page.
 *
 * No visual components. The parser accepts defensive JSON (numbers may arrive
 * as strings from PostgREST) and never throws on missing fields.
 */

export const SUPPLIER_PROFILE_MISSING_LABELS = {
  email: "Thiếu email",
  phone: "Thiếu SĐT",
  contact_name: "Thiếu người liên hệ",
  receiving_location: "Chưa chọn kho nhận",
} as const;

export type SupplierProfileMissingCode = keyof typeof SUPPLIER_PROFILE_MISSING_LABELS;

const SUPPLIER_PROFILE_MISSING_CODES: SupplierProfileMissingCode[] = [
  "email",
  "phone",
  "contact_name",
  "receiving_location",
];

export type SupplierProfileOverview = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  address: string | null;
  receivingLocation: string | null;
  paymentTermsDays: number | null;
  paymentMethod: string | null;
  orderItemCount: number;
  lastPurchaseAt: string | null;
  active60d: boolean;
  unpaidCount: number;
  unpaidAmount: number;
  missing: SupplierProfileMissingCode[];
};

export type SupplierProfileFilter =
  | "all"
  | "active_60d"
  | "missing_email"
  | "incomplete"
  | "unpaid";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number" ? value : Number(String(value).trim().replace(/\s/g, ""));
  if (Number.isFinite(raw)) return raw;
  const text = String(value).trim().replace(/\s/g, "");
  const normalized = text.includes(",") && !text.includes(".")
    ? text.replace(",", ".")
    : text.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingCode(value: string): value is SupplierProfileMissingCode {
  return Object.prototype.hasOwnProperty.call(SUPPLIER_PROFILE_MISSING_LABELS, value);
}

function parseMissing(
  value: unknown,
  fields: {
    email: string | null;
    phone: string | null;
    contactName: string | null;
    receivingLocation: string | null;
  },
): SupplierProfileMissingCode[] {
  if (Array.isArray(value)) {
    const seen = new Set<SupplierProfileMissingCode>();
    const output: SupplierProfileMissingCode[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const code = entry.trim();
      if (!isMissingCode(code) || seen.has(code)) continue;
      seen.add(code);
      output.push(code);
    }
    return output;
  }

  // A payload without a missing array still reports the usual empty fields.
  return SUPPLIER_PROFILE_MISSING_CODES.filter((code) => {
    if (code === "email") return fields.email === null;
    if (code === "phone") return fields.phone === null;
    if (code === "contact_name") return fields.contactName === null;
    return fields.receivingLocation === null;
  });
}

function parseRow(value: unknown): SupplierProfileOverview | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;

  const email = asNullableText(row.email);
  const phone = asNullableText(row.phone);
  const contactName = asNullableText(row.contact_name);
  const receivingLocation = asNullableText(row.default_receiving_location);

  return {
    id: asText(row.id),
    name: asText(row.name).trim(),
    email,
    phone,
    contactName,
    address: asNullableText(row.address),
    receivingLocation,
    paymentTermsDays: asNumber(row.payment_terms_days),
    paymentMethod: asNullableText(row.default_payment_method),
    orderItemCount: asNumber(row.order_item_count) ?? 0,
    lastPurchaseAt: asNullableText(row.last_purchase_at),
    active60d: row.active_60d === true || row.active_60d === "true",
    unpaidCount: asNumber(row.unpaid_count) ?? 0,
    unpaidAmount: Math.max(0, asNumber(row.unpaid_amount) ?? 0),
    missing: parseMissing(row.missing, {
      email,
      phone,
      contactName,
      receivingLocation,
    }),
  };
}

export function parseSupplierProfileOverview(value: unknown): SupplierProfileOverview[] {
  const root = asRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(root.suppliers)
    ? root.suppliers
    : [];
  const output: SupplierProfileOverview[] = [];
  for (const raw of rows) {
    const row = parseRow(raw);
    if (row !== null) output.push(row);
  }
  return output;
}

/** Fold Vietnamese diacritics so "phuc thinh" matches "Phúc Thịnh". */
export function normalizeSupplierProfileSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

export function filterSupplierProfiles(
  list: SupplierProfileOverview[],
  options: {
    query?: string;
    filter?: SupplierProfileFilter;
  } = {},
): SupplierProfileOverview[] {
  const filter = options.filter ?? "all";
  const query = normalizeSupplierProfileSearch(options.query ?? "");
  return list.filter((entry) => {
    const matchesFilter = filter === "active_60d"
      ? entry.active60d
      : filter === "missing_email"
      ? entry.missing.includes("email")
      : filter === "incomplete"
      ? entry.missing.length > 0
      : filter === "unpaid"
      ? entry.unpaidCount > 0 || entry.unpaidAmount > 0
      : true;
    if (!matchesFilter) return false;
    if (!query) return true;
    const haystack = normalizeSupplierProfileSearch(
      `${entry.name} ${entry.email ?? ""} ${entry.phone ?? ""} ${entry.contactName ?? ""}`,
    );
    return haystack.includes(query);
  });
}

export function supplierProfileFilterCounts(
  list: SupplierProfileOverview[],
): Record<SupplierProfileFilter, number> {
  const counts: Record<SupplierProfileFilter, number> = {
    all: list.length,
    active_60d: 0,
    missing_email: 0,
    incomplete: 0,
    unpaid: 0,
  };
  for (const entry of list) {
    if (entry.active60d) counts.active_60d += 1;
    if (entry.missing.includes("email")) counts.missing_email += 1;
    if (entry.missing.length > 0) counts.incomplete += 1;
    if (entry.unpaidCount > 0 || entry.unpaidAmount > 0) counts.unpaid += 1;
  }
  return counts;
}
