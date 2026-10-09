// Pure state builder for the Jev duplicate scan.
//
// Jev only ever receives the named fields below: supplier name plus, for each
// phiếu of the pair, its request number, created date in Vietnam time, total,
// title, a 300-character description, PO / goods receipt / invoice references
// and up to 20 line items. Bank account numbers, images, the creator and any
// email are deliberately never placed in the state. The state hash is the
// SHA-256 of a canonical (recursively key-sorted) JSON string, so a pair is only
// re-checked when the underlying data actually changed.

export const STATE_DESCRIPTION_LIMIT = 300;
export const STATE_ITEM_LIMIT = 20;

export interface StateItem {
  product_name: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
}

export interface RequestStateInput {
  id: string;
  request_number: string;
  created_at: string;
  total_amount: number | null;
  title: string | null;
  description: string | null;
  po_number: string | null;
  goods_receipt_number: string | null;
  receipt_date: string | null;
  invoice_number: string | null;
  items: StateItem[];
}

export interface PairStateInput {
  supplier_name: string | null;
  older: RequestStateInput;
  newer: RequestStateInput;
}

export interface JevRequestState {
  request_number: string;
  created_date: string;
  total_amount: number | null;
  title: string | null;
  description: string | null;
  po_number: string | null;
  goods_receipt_number: string | null;
  receipt_date: string | null;
  invoice_number: string | null;
  items: {
    product_name: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    line_total: number | null;
  }[];
}

export interface JevPairState {
  supplier_name: string | null;
  older: JevRequestState;
  newer: JevRequestState;
}

const VN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant in Vietnam time (UTC+7). */
export function vietnamDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = VN_DATE.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function requestState(input: RequestStateInput): JevRequestState {
  return {
    request_number: input.request_number,
    created_date: vietnamDate(input.created_at),
    total_amount: input.total_amount,
    title: input.title,
    description: input.description === null ? null : input.description.slice(0, STATE_DESCRIPTION_LIMIT),
    po_number: input.po_number,
    goods_receipt_number: input.goods_receipt_number,
    receipt_date: input.receipt_date,
    invoice_number: input.invoice_number,
    items: input.items.slice(0, STATE_ITEM_LIMIT).map((item) => ({
      product_name: item.product_name,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
    })),
  };
}

export function buildPairState(input: PairStateInput): JevPairState {
  return {
    supplier_name: input.supplier_name,
    older: requestState(input.older),
    newer: requestState(input.newer),
  };
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical JSON of the state. */
export async function stateHash(state: JevPairState): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(state));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}
