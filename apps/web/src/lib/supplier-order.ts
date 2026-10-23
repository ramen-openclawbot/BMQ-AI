/**
 * Typed data layer for supplier ordering by email.
 *
 * No visual components. The parsers accept defensive JSON (numbers may arrive
 * as strings from PostgREST) and never throw on missing fields.
 */

export const SUPPLIER_ORDER_BLOCKER_LABELS = {
  no_supplier: "Chưa chọn nhà cung cấp",
  no_supplier_email: "Nhà cung cấp chưa có email đặt hàng",
  no_price: "Chưa có giá mua gần nhất",
  no_po_unit: "Chưa cài đơn vị đặt hàng",
  mailbox_not_connected: "Chưa kết nối hộp thư order@bmq.vn",
} as const;

export type SupplierOrderBlocker = keyof typeof SUPPLIER_ORDER_BLOCKER_LABELS;

export type SupplierOrderItem = {
  id: string;
  name: string;
  unit: string;
};

export type SupplierOrderSupplier = {
  id: string;
  name: string;
  email: string | null;
};

export type SupplierOrderStock = {
  onHand: number | null;
  dailyUsage: number;
  daysLeft: number | null;
  lastCountDate: string | null;
  reorderDate: string | null;
};

export type SupplierOrderProposal = {
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  productName: string;
  packSizePoUnits: number | null;
  suggestedBookQty: number;
};

export type SupplierOrderOpenOrder = {
  poNumber: string;
  quantity: number;
  unit: string;
  status: string;
  createdAt: string | null;
};

export type SupplierOrderDelivery = {
  address: string;
  contactName: string;
  contactPhone: string;
  note: string;
};

export type PreparedSupplierOrder = {
  item: SupplierOrderItem;
  supplier: SupplierOrderSupplier | null;
  stock: SupplierOrderStock;
  proposal: SupplierOrderProposal;
  openOrder: SupplierOrderOpenOrder | null;
  delivery: SupplierOrderDelivery;
  blockers: string[];
};

export type SupplierOrderUpload = {
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: string | null;
  storagePath: string;
};

export type SupplierOrderHistoryEntry = {
  id: string | null;
  requestId: string | null;
  poNumber: string | null;
  quantity: number;
  unit: string;
  total: number | null;
  status: string;
  sentAt: string | null;
  toEmail: string | null;
  uploads: SupplierOrderUpload[];
};

export type SendSupplierOrderInput = {
  itemId: string;
  quantity: number;
  note?: string;
  requestId?: string;
};

export type SendSupplierOrderResult = {
  status: "sent";
  poNumber: string | null;
  toEmail: string | null;
  sentAt: string | null;
  replayed?: boolean;
};

export type SupplierOrderUploadSummary = {
  poNumber: string | null;
  supplierName: string | null;
  productName: string | null;
  quantity: number | null;
  unit: string | null;
  sentAt: string | null;
  uploadCount: number;
};

export type UploadDeliveryResult = {
  uploaded: boolean;
  count: number;
};

export class SupplierOrderClientError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "SupplierOrderClientError";
    this.code = code;
    this.status = status;
  }
}

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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : asText(entry)))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function blockerLabel(code: string): string {
  return SUPPLIER_ORDER_BLOCKER_LABELS[code as SupplierOrderBlocker] ?? code;
}

export function parsePreparedSupplierOrder(value: unknown): PreparedSupplierOrder | null {
  const root = asRecord(value);
  if (Object.keys(root).length === 0) return null;

  const item = asRecord(root.item);
  const supplierValue = root.supplier;
  const supplier = supplierValue === null || supplierValue === undefined
    ? null
    : asRecord(supplierValue);
  const stock = asRecord(root.stock);
  const proposal = asRecord(root.proposal);
  const delivery = asRecord(root.delivery);
  const openValue = root.open_order;
  const open = openValue === null || openValue === undefined ? null : asRecord(openValue);

  return {
    item: {
      id: asText(item.id),
      name: asText(item.name),
      unit: asText(item.unit),
    },
    supplier: supplier === null
      ? null
      : {
          id: asText(supplier.id),
          name: asText(supplier.name),
          email: asNullableText(supplier.email),
        },
    stock: {
      onHand: asNumber(stock.on_hand),
      dailyUsage: asNumber(stock.daily_usage) ?? 0,
      daysLeft: asNumber(stock.days_left),
      lastCountDate: asNullableText(stock.last_count_date),
      reorderDate: asNullableText(stock.reorder_date),
    },
    proposal: {
      quantity: asNumber(proposal.quantity) ?? 0,
      unit: asText(proposal.unit),
      unitPrice: asNumber(proposal.unit_price),
      lineTotal: asNumber(proposal.line_total),
      productName: asText(proposal.product_name, asText(item.name)),
      packSizePoUnits: asNumber(proposal.pack_size_po_units),
      suggestedBookQty: asNumber(proposal.suggested_book_qty) ?? 0,
    },
    openOrder: open === null || Object.keys(open).length === 0
      ? null
      : {
          poNumber: asText(open.po_number),
          quantity: asNumber(open.quantity) ?? 0,
          unit: asText(open.unit),
          status: asText(open.status),
          createdAt: asNullableText(open.created_at),
        },
    delivery: {
      address: asText(delivery.address),
      contactName: asText(delivery.contact_name),
      contactPhone: asText(delivery.contact_phone),
      note: asText(delivery.note),
    },
    blockers: asStringArray(root.blockers),
  };
}

function parseHistoryUpload(value: unknown): SupplierOrderUpload | null {
  const upload = asRecord(value);
  if (Object.keys(upload).length === 0) return null;
  return {
    fileName: asNullableText(upload.file_name),
    mimeType: asText(upload.mime_type),
    sizeBytes: asNumber(upload.size_bytes) ?? 0,
    createdAt: asNullableText(upload.created_at),
    storagePath: asText(upload.storage_path),
  };
}

export function parseSupplierOrderHistory(value: unknown): SupplierOrderHistoryEntry[] {
  const root = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root.items) ? root.items : [];
  const output: SupplierOrderHistoryEntry[] = [];

  for (const row of rows) {
    const entry = asRecord(row);
    if (Object.keys(entry).length === 0) continue;
    output.push({
      id: asNullableText(entry.id),
      requestId: asNullableText(entry.request_id),
      poNumber: asNullableText(entry.po_number),
      quantity: asNumber(entry.quantity) ?? 0,
      unit: asText(entry.unit),
      total: asNumber(entry.total ?? entry.line_total),
      status: asText(entry.status),
      sentAt: asNullableText(entry.sent_at),
      toEmail: asNullableText(entry.to_email),
      uploads: (Array.isArray(entry.uploads) ? entry.uploads : [])
        .map(parseHistoryUpload)
        .filter((upload): upload is SupplierOrderUpload => upload !== null),
    });
  }
  return output;
}

export function parseSupplierOrderUploadSummary(value: unknown): SupplierOrderUploadSummary {
  const root = asRecord(value);
  return {
    poNumber: asNullableText(root.po_number),
    supplierName: asNullableText(root.supplier_name),
    productName: asNullableText(root.product_name),
    quantity: asNumber(root.quantity),
    unit: asNullableText(root.unit),
    sentAt: asNullableText(root.sent_at),
    uploadCount: asNumber(root.upload_count) ?? 0,
  };
}

export function formatQuantity(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rounded = Math.round(number * 1000) / 1000;
  const sign = rounded < 0 ? "-" : "";
  const [whole, decimal = ""] = String(Math.abs(rounded)).split(".");
  const trimmed = decimal.replace(/0+$/, "");
  return `${sign}${groupThousands(Number(whole))}${trimmed ? `,${trimmed}` : ""}`;
}

export function formatVnd(value: number | null | undefined): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${groupThousands(number)} đ`;
}

function groupThousands(value: number): string {
  const rounded = Math.round(Math.abs(value));
  const digits = String(rounded);
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

/** Generate the request_id once per confirmation sheet. */
export function createSupplierOrderRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function envValue(key: "VITE_SUPABASE_URL" | "VITE_SUPABASE_PUBLISHABLE_KEY"): string {
  // Static property reads so Vite inlines the values in the build (a dynamic
  // env[key] lookup is not guaranteed to be replaced); undefined under node tests.
  if (typeof import.meta.env !== "object" || !import.meta.env) return "";
  const value = key === "VITE_SUPABASE_URL"
    ? import.meta.env.VITE_SUPABASE_URL
    : import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return typeof value === "string" ? value : "";
}

function functionUrl(name: string): string {
  const base = envValue("VITE_SUPABASE_URL");
  if (!base) throw new SupplierOrderClientError("missing_supabase_url", "Thiếu cấu hình Supabase");
  return `${base.replace(/\/$/, "")}/functions/v1/${name}`;
}

async function readFunctionError(error: unknown): Promise<{ code: string; message: string; status: number }> {
  const fallback = {
    code: "function_failed",
    message: "Không gọi được máy chủ",
    status: 0,
  };
  const context = (error as { context?: Response } | null)?.context;
  if (!context) {
    const message = (error as { message?: string } | null)?.message;
    return { ...fallback, message: message || fallback.message };
  }
  let payload: UnknownRecord = {};
  try {
    payload = asRecord(await context.json());
  } catch {
    payload = {};
  }
  return {
    code: asText(payload.code, fallback.code),
    message: asText(payload.error ?? payload.message, fallback.message),
    status: context.status,
  };
}

export async function sendSupplierOrder(
  input: SendSupplierOrderInput,
): Promise<SendSupplierOrderResult> {
  const requestId = input.requestId ?? createSupplierOrderRequestId();
  const { supabase } = await import("../integrations/supabase/client");
  const { data, error } = await supabase.functions.invoke("supplier-order-send", {
    body: {
      item_id: input.itemId,
      quantity: input.quantity,
      note: input.note ?? "",
      request_id: requestId,
    },
  });

  if (error) {
    const parsed = await readFunctionError(error);
    throw new SupplierOrderClientError(parsed.code, parsed.message, parsed.status);
  }

  const payload = asRecord(data);
  if (asText(payload.code)) {
    throw new SupplierOrderClientError(
      asText(payload.code),
      asText(payload.error, "Không gửi được email đặt hàng"),
    );
  }
  if (asText(payload.status) !== "sent") {
    throw new SupplierOrderClientError("send_failed", "Không gửi được email đặt hàng");
  }

  return {
    status: "sent",
    poNumber: asNullableText(payload.po_number),
    toEmail: asNullableText(payload.to_email),
    sentAt: asNullableText(payload.sent_at),
    replayed: payload.replayed === true,
  };
}

function publicHeaders(): Record<string, string> {
  return {
    apikey: envValue("VITE_SUPABASE_PUBLISHABLE_KEY"),
  };
}

export async function fetchUploadOrder(token: string): Promise<SupplierOrderUploadSummary> {
  const response = await fetch(
    `${functionUrl("supplier-order-upload")}?t=${encodeURIComponent(token)}`,
    { method: "GET", headers: publicHeaders() },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = asRecord(payload);
    throw new SupplierOrderClientError(
      asText(body.code, "link_invalid"),
      "Liên kết tải hóa đơn không hợp lệ hoặc đã hết hạn",
      response.status,
    );
  }
  return parseSupplierOrderUploadSummary(payload);
}

function sanitizeFileName(name: string): string {
  const base = String(name || "delivery-document")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return base || "delivery-document";
}

export async function uploadDeliveryDoc(
  token: string,
  file: File,
): Promise<UploadDeliveryResult> {
  const response = await fetch(
    `${functionUrl("supplier-order-upload")}?t=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: {
        ...publicHeaders(),
        "Content-Type": file.type,
        "X-File-Name": encodeURIComponent(sanitizeFileName(file.name)),
      },
      body: file,
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const body = asRecord(payload);
    throw new SupplierOrderClientError(
      asText(body.code, "upload_failed"),
      "Không tải lên được hóa đơn / phiếu giao hàng",
      response.status,
    );
  }
  const body = asRecord(payload);
  return {
    uploaded: body.uploaded === true,
    count: asNumber(body.count) ?? 0,
  };
}
