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
  invalid_delivery: "Địa chỉ giao chưa đúng. Kiểm tra lại địa chỉ, người nhận, số điện thoại.",
  delivery_unavailable: "Chưa cài địa chỉ Kho Tân Tạo. Chọn kho khác hoặc nhập địa chỉ.",
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

export type SupplierOrderSupplierListEntry = {
  id: string;
  name: string;
  email: string | null;
  hasEmail: boolean;
  itemCount: number;
  activeItemCount: number;
  needOrderCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  lastActivityAt: string | null;
  locations: string[];
  urgencyRank: number;
  lastOrder: { poNumber: string | null; sentAt: string | null } | null;
  unpaidCount: number;
};

export type SupplierOrderSupplierFilter =
  | "need_order"
  | "low_stock"
  | "no_email"
  | "all";

export type SupplierOrderCatalogStock = {
  onHand: number | null;
  dailyUsage: number;
  daysLeft: number | null;
  reorderDate: string | null;
  lastCountDate: string | null;
};

export type SupplierOrderCatalogOpenOrder = {
  poNumber: string | null;
  quantity: number | null;
  unit: string | null;
  sentAt: string | null;
};

export type SupplierOrderCatalogItem = {
  catalogId: string;
  item: { id: string; name: string; code: string; unit: string };
  productName: string;
  poUnit: string;
  poUnitFactor: number;
  packSizePo: number | null;
  vatRate: number;
  location: string;
  estimated: boolean;
  stock: SupplierOrderCatalogStock;
  proposalQty: number;
  listPrice: number | null;
  listPriceIncludesVat: boolean;
  listPriceSource: string | null;
  listPriceUpdatedAt: string | null;
  historyPrice: number | null;
  unitPrice: number | null;
  unitPriceGross: number | null;
  openOrder: SupplierOrderCatalogOpenOrder | null;
  learnedSupplierMismatch: boolean;
  learnedSupplier: { id: string; name: string } | null;
  priceOutlier: boolean;
  referencePrice: {
    supplierId: string;
    supplierName: string;
    unitPrice: number;
  } | null;
};

export type SupplierOrderOfficialInvoice = {
  invoiceNumber: string;
  invoiceSeries: string;
  invoiceDate: string | null;
};

export type SupplierOrderPrepay = {
  id: string;
  requestNumber: string;
  createdAt: string | null;
  totalAmount: number | null;
  remaining: number | null;
  poNumber: string | null;
  recentSubmission: {
    submissionNumber: string;
    createdAt: string | null;
  } | null;
  officialInvoice: SupplierOrderOfficialInvoice | null;
};

export type SupplierOrderCatalog = {
  supplier: SupplierOrderSupplier | null;
  delivery: SupplierOrderDelivery;
  mailboxConnected: boolean;
  blockers: string[];
  items: SupplierOrderCatalogItem[];
  prepay: SupplierOrderPrepay | null;
};

export type SupplierOrderCatalogCandidate = {
  itemId: string;
  name: string;
  unit: string;
  latestProductName: string | null;
  lastOrderDate: string | null;
  lineCount: number;
};

export type SupplierOrderPreviewLine = {
  position: number;
  itemId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  vatRate: number;
  grossAmount: number | null;
};

export type SupplierOrderPreview = {
  subject: string;
  html: string;
  text: string;
  toEmail: string | null;
  lines: SupplierOrderPreviewLine[];
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  prepay: SupplierOrderPrepay | null;
  prepayReason: string | null;
};

export type SupplierOrderDeliveryChoice =
  | { target: "auto" }
  | { target: "q7" }
  | { target: "tan_tao" }
  | {
    target: "custom";
    address: string;
    contactName: string;
    contactPhone: string;
  };

export type SendSupplierOrderLinesInput = {
  supplierId: string;
  lines: { itemId: string; quantity: number }[];
  note?: string;
  requestId?: string;
  prepay?: boolean;
  delivery?: SupplierOrderDeliveryChoice;
};

export function serializeDeliveryChoice(
  choice?: SupplierOrderDeliveryChoice,
): Record<string, string> | undefined {
  if (!choice || choice.target === "auto") return undefined;
  if (choice.target === "custom") {
    return {
      target: "custom",
      address: choice.address,
      contact_name: choice.contactName,
      contact_phone: choice.contactPhone,
    };
  }
  return { target: choice.target };
}

export type SendSupplierOrderLinesResult = {
  status: "sent";
  poNumber: string | null;
  toEmail: string | null;
  sentAt: string | null;
  prepay: {
    status: string;
    requestNumber: string | null;
    submissionNumber: string | null;
  } | null;
  replayed?: boolean;
};

export type SupplierOrderCancelResult = {
  status: "cancelled";
  poNumber: string | null;
  email: "sent" | "already_sent" | "failed";
  zaloQueued: boolean;
  code: string | null;
};

export type SupplierOrderRequestLine = {
  position: number;
  itemId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  vatRate: number | null;
  grossAmount: number | null;
};

export type SupplierOrderHistoryReceipt = {
  id: string | null;
  receiptNumber: string | null;
  status: string;
  finalizedAt: string | null;
};

export type SupplierOrderHistoryPayment = {
  requestNumber: string | null;
  status: string;
  paymentStatus: string;
  totalAmount: number | null;
};

export type SupplierOrderHistoryBySupplierEntry = {
  id: string | null;
  requestId: string | null;
  poNumber: string | null;
  poStatus: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  status: string;
  sentAt: string | null;
  toEmail: string | null;
  createdAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelEmailSentAt: string | null;
  lines: SupplierOrderRequestLine[];
  uploads: SupplierOrderUpload[];
  receipt: SupplierOrderHistoryReceipt | null;
  payment: SupplierOrderHistoryPayment | null;
  prepay: {
    status: string;
    requestNumber: string | null;
    submissionNumber: string | null;
  } | null;
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

export type SupplierOrderAmountInput = {
  quantity: number;
  unitPrice: number | null;
  vatRate: number;
  listPrice: number | null;
  listPriceIncludesVat: boolean;
};

export type SupplierOrderAmountLine = {
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  vatRate: number;
  vatAmount: number;
  grossAmount: number;
  listPrice: number | null;
  listPriceIncludesVat: boolean;
};

export type SupplierOrderAmounts = {
  lines: SupplierOrderAmountLine[];
  subtotal: number;
  vatAmount: number;
  total: number;
};

function roundAmount(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Client mirror of public.supplier_order_quote.
 *
 * r = vatRate / 100. A list price that includes VAT is reduced to a net line;
 * every other line is net and its VAT is accumulated raw before the final
 * whole-đồng rounding. Items without a list price use the supplied history
 * unit price exactly as before.
 */
export function computeOrderAmounts(
  lines: SupplierOrderAmountInput[],
): SupplierOrderAmounts {
  const output: SupplierOrderAmountLine[] = [];
  let subtotal = 0;
  let grossVat = 0;
  let netVatRaw = 0;

  for (const input of lines) {
    const quantity = Number.isFinite(input.quantity) ? input.quantity : 0;
    const vatRate = Number.isFinite(input.vatRate) ? input.vatRate : 0;
    const rate = vatRate / 100;
    const listPrice = typeof input.listPrice === "number"
        && Number.isFinite(input.listPrice) && input.listPrice > 0
      ? input.listPrice
      : null;
    const listPriceIncludesVat = listPrice !== null
      && input.listPriceIncludesVat === true;

    let unitPrice: number;
    let lineTotal: number;
    let vatAmount: number;
    let grossAmount: number;
    let vatRaw = 0;

    if (listPrice !== null && listPriceIncludesVat) {
      grossAmount = roundAmount(quantity * listPrice, 0);
      lineTotal = roundAmount(grossAmount / (1 + rate), 0);
      vatAmount = grossAmount - lineTotal;
      unitPrice = roundAmount(listPrice / (1 + rate), 2);
    } else if (listPrice !== null) {
      unitPrice = listPrice;
      lineTotal = roundAmount(quantity * unitPrice, 2);
      vatRaw = lineTotal * rate;
      vatAmount = roundAmount(vatRaw, 2);
      grossAmount = roundAmount(lineTotal + vatRaw, 2);
    } else {
      unitPrice = roundAmount(
        typeof input.unitPrice === "number" && Number.isFinite(input.unitPrice)
          ? input.unitPrice
          : 0,
        2,
      );
      lineTotal = roundAmount(quantity * unitPrice, 2);
      vatRaw = lineTotal * rate;
      vatAmount = roundAmount(vatRaw, 2);
      grossAmount = roundAmount(lineTotal + vatRaw, 2);
    }

    subtotal += lineTotal;
    if (listPrice !== null && listPriceIncludesVat) {
      grossVat += vatAmount;
    } else {
      netVatRaw += vatRaw;
    }

    output.push({
      quantity,
      unitPrice,
      lineTotal,
      vatRate,
      vatAmount,
      grossAmount,
      listPrice,
      listPriceIncludesVat,
    });
  }

  const roundedSubtotal = roundAmount(subtotal, 2);
  const vatAmount = roundAmount(grossVat + Math.round(netVatRaw), 0);
  return {
    lines: output,
    subtotal: roundedSubtotal,
    vatAmount,
    total: roundAmount(roundedSubtotal + vatAmount, 2),
  };
}

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

function parseLearnedSupplier(value: unknown): { id: string; name: string } | null {
  const row = asRecord(value);
  const id = asNullableText(row.id);
  if (id === null) return null;
  return { id, name: asText(row.name) };
}

function parseReferencePrice(value: unknown): {
  supplierId: string;
  supplierName: string;
  unitPrice: number;
} | null {
  const row = asRecord(value);
  const supplierId = asNullableText(row.supplier_id);
  const unitPrice = asNumber(row.unit_price);
  if (supplierId === null || unitPrice === null) return null;
  return {
    supplierId,
    supplierName: asText(row.supplier_name),
    unitPrice,
  };
}

function parseCatalogItem(value: unknown): SupplierOrderCatalogItem | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;
  const item = asRecord(row.item);
  const stock = asRecord(row.stock);
  const openValue = row.open_order;
  const open = openValue === null || openValue === undefined ? null : asRecord(openValue);
  return {
    catalogId: asText(row.catalog_id),
    item: {
      id: asText(item.id),
      name: asText(item.name),
      code: asText(item.code),
      unit: asText(item.unit),
    },
    productName: asText(row.product_name, asText(item.name)),
    poUnit: asText(row.po_unit),
    poUnitFactor: asNumber(row.po_unit_factor) ?? 0,
    packSizePo: asNumber(row.pack_size_po),
    vatRate: asNumber(row.vat_rate) ?? 0,
    location: asNullableText(row.location) ?? "q7",
    estimated: row.estimated === true,
    stock: {
      onHand: asNumber(stock.on_hand),
      dailyUsage: asNumber(stock.daily_usage) ?? 0,
      daysLeft: asNumber(stock.days_left),
      reorderDate: asNullableText(stock.reorder_date),
      lastCountDate: asNullableText(stock.last_count_date),
    },
    proposalQty: asNumber(row.proposal_qty) ?? 0,
    listPrice: asNumber(row.list_price),
    listPriceIncludesVat: row.list_price_includes_vat === true,
    listPriceSource: asNullableText(row.list_price_source),
    listPriceUpdatedAt: asNullableText(row.list_price_updated_at),
    historyPrice: asNumber(row.history_price),
    unitPrice: asNumber(row.unit_price),
    unitPriceGross: asNumber(row.unit_price_gross),
    openOrder: open === null || Object.keys(open).length === 0
      ? null
      : {
          poNumber: asNullableText(open.po_number),
          quantity: asNumber(open.quantity),
          unit: asNullableText(open.unit),
          sentAt: asNullableText(open.sent_at),
        },
    learnedSupplierMismatch: row.learned_supplier_mismatch === true,
    learnedSupplier: parseLearnedSupplier(row.learned_supplier),
    priceOutlier: row.price_outlier === true,
    referencePrice: parseReferencePrice(row.reference_price),
  };
}

function parsePrepay(value: unknown): SupplierOrderPrepay | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;
  const recent = asRecord(row.recent_submission);
  const official = asRecord(row.official_invoice);
  return {
    id: asText(row.id),
    requestNumber: asText(row.request_number),
    createdAt: asNullableText(row.created_at),
    totalAmount: asNumber(row.total_amount),
    remaining: asNumber(row.remaining),
    poNumber: asNullableText(row.po_number),
    recentSubmission: Object.keys(recent).length === 0
      ? null
      : {
          submissionNumber: asText(recent.submission_number),
          createdAt: asNullableText(recent.created_at),
        },
    officialInvoice: Object.keys(official).length === 0
      ? null
      : {
          invoiceNumber: asText(official.invoice_number),
          invoiceSeries: asText(official.invoice_series),
          invoiceDate: asNullableText(official.invoice_date),
        },
  };
}

export function parseSupplierOrderSuppliers(value: unknown): SupplierOrderSupplierListEntry[] {
  const root = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root.suppliers) ? root.suppliers : [];
  const output: SupplierOrderSupplierListEntry[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (Object.keys(row).length === 0) continue;
    const lastValue = row.last_order;
    const last = lastValue === null || lastValue === undefined ? null : asRecord(lastValue);
    const email = asNullableText(row.email);
    output.push({
      id: asText(row.id),
      name: asText(row.name),
      email,
      hasEmail: typeof row.has_email === "boolean" ? row.has_email : email !== null,
      itemCount: asNumber(row.item_count) ?? 0,
      activeItemCount: asNumber(row.active_item_count) ?? asNumber(row.item_count) ?? 0,
      needOrderCount: asNumber(row.need_order_count) ?? 0,
      lowStockCount: asNumber(row.low_stock_count) ?? 0,
      outOfStockCount: asNumber(row.out_of_stock_count) ?? 0,
      lastActivityAt: asNullableText(row.last_activity_at),
      locations: asStringArray(row.locations),
      urgencyRank: asNumber(row.urgency_rank) ?? 4,
      lastOrder: last === null || Object.keys(last).length === 0
        ? null
        : {
            poNumber: asNullableText(last.po_number),
            sentAt: asNullableText(last.sent_at),
          },
      unpaidCount: asNumber(row.unpaid_count) ?? 0,
    });
  }
  return output;
}

/** Fold Vietnamese diacritics so "phuc thinh" matches "Phúc Thịnh". */
export function normalizeSupplierOrderSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

export function filterSupplierOrderSuppliers(
  list: SupplierOrderSupplierListEntry[],
  options: {
    query?: string;
    filter?: SupplierOrderSupplierFilter;
  } = {},
): SupplierOrderSupplierListEntry[] {
  const filter = options.filter ?? "all";
  const query = normalizeSupplierOrderSearch(options.query ?? "");
  return list.filter((entry) => {
    const matchesFilter = filter === "need_order"
      ? entry.needOrderCount > 0
      : filter === "low_stock"
      ? entry.lowStockCount > 0
      : filter === "no_email"
      ? !entry.hasEmail
      : true;
    if (!matchesFilter) return false;
    if (!query) return true;
    const haystack = normalizeSupplierOrderSearch(
      `${entry.name} ${entry.email ?? ""}`,
    );
    return haystack.includes(query);
  });
}

export function sortSupplierOrderSuppliersByUrgency(
  list: SupplierOrderSupplierListEntry[],
): SupplierOrderSupplierListEntry[] {
  return [...list].sort((left, right) => {
    if (left.urgencyRank !== right.urgencyRank) {
      return left.urgencyRank - right.urgencyRank;
    }
    const byName = left.name.localeCompare(right.name, "vi");
    if (byName !== 0) return byName;
    return left.id.localeCompare(right.id);
  });
}

export function parseSupplierOrderCatalog(value: unknown): SupplierOrderCatalog | null {
  const root = asRecord(value);
  if (Object.keys(root).length === 0) return null;
  const supplierValue = root.supplier;
  const supplier = supplierValue === null || supplierValue === undefined
    ? null
    : asRecord(supplierValue);
  const delivery = asRecord(root.delivery);
  return {
    supplier: supplier === null || Object.keys(supplier).length === 0
      ? null
      : {
          id: asText(supplier.id),
          name: asText(supplier.name),
          email: asNullableText(supplier.email),
        },
    delivery: {
      address: asText(delivery.address),
      contactName: asText(delivery.contact_name),
      contactPhone: asText(delivery.contact_phone),
      note: asText(delivery.note),
    },
    mailboxConnected: root.mailbox_connected === true,
    blockers: asStringArray(root.blockers),
    items: (Array.isArray(root.items) ? root.items : [])
      .map(parseCatalogItem)
      .filter((item): item is SupplierOrderCatalogItem => item !== null),
    prepay: parsePrepay(root.prepay),
  };
}

export function parseSupplierOrderCatalogCandidates(
  value: unknown,
): SupplierOrderCatalogCandidate[] {
  const root = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root.items) ? root.items : [];
  const output: SupplierOrderCatalogCandidate[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (Object.keys(row).length === 0) continue;
    output.push({
      itemId: asText(row.item_id),
      name: asText(row.name),
      unit: asText(row.unit),
      latestProductName: asNullableText(row.latest_product_name),
      lastOrderDate: asNullableText(row.last_order_date),
      lineCount: asNumber(row.line_count) ?? 0,
    });
  }
  return output;
}

function parsePreviewLine(value: unknown): SupplierOrderPreviewLine | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;
  return {
    position: asNumber(row.position) ?? 0,
    itemId: asText(row.item_id),
    productName: asText(row.product_name),
    quantity: asNumber(row.quantity) ?? 0,
    unit: asText(row.unit),
    unitPrice: asNumber(row.unit_price),
    lineTotal: asNumber(row.line_total),
    vatRate: asNumber(row.vat_rate) ?? 0,
    grossAmount: asNumber(row.gross_amount),
  };
}

export function parseSupplierOrderPreview(value: unknown): SupplierOrderPreview | null {
  const root = asRecord(value);
  if (Object.keys(root).length === 0) return null;
  return {
    subject: asText(root.subject),
    html: asText(root.html),
    text: asText(root.text),
    toEmail: asNullableText(root.to_email),
    lines: (Array.isArray(root.lines) ? root.lines : [])
      .map(parsePreviewLine)
      .filter((line): line is SupplierOrderPreviewLine => line !== null),
    subtotal: asNumber(root.subtotal),
    vatAmount: asNumber(root.vat_amount),
    total: asNumber(root.total),
    prepay: parsePrepay(root.prepay),
    prepayReason: asNullableText(root.prepay_reason),
  };
}

export function parseSendSupplierOrderLinesResult(
  value: unknown,
): SendSupplierOrderLinesResult | null {
  const root = asRecord(value);
  if (Object.keys(root).length === 0) return null;
  const prepay = asRecord(root.prepay);
  return {
    status: "sent",
    poNumber: asNullableText(root.po_number),
    toEmail: asNullableText(root.to_email),
    sentAt: asNullableText(root.sent_at),
    prepay: Object.keys(prepay).length === 0
      ? null
      : {
          status: asText(prepay.status),
          requestNumber: asNullableText(prepay.request_number),
          submissionNumber: asNullableText(prepay.submission_number),
        },
    replayed: root.replayed === true,
  };
}

export function parseSupplierOrderCancelResult(
  value: unknown,
): SupplierOrderCancelResult | null {
  const root = asRecord(value);
  if (asText(root.status) !== "cancelled") return null;
  const email = asText(root.email);
  return {
    status: "cancelled",
    poNumber: asNullableText(root.po_number),
    email: email === "sent" || email === "already_sent" ? email : "failed",
    zaloQueued: root.zalo_queued === true,
    code: asNullableText(root.code),
  };
}

export function parseSupplierOrderHistoryBySupplier(
  value: unknown,
): SupplierOrderHistoryBySupplierEntry[] {
  const root = asRecord(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root.items) ? root.items : [];
  const output: SupplierOrderHistoryBySupplierEntry[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (Object.keys(row).length === 0) continue;
    const prepay = asRecord(row.prepay);
    const receipt = asRecord(row.receipt);
    const payment = asRecord(row.payment);
    output.push({
      id: asNullableText(row.id),
      requestId: asNullableText(row.request_id),
      poNumber: asNullableText(row.po_number),
      poStatus: asNullableText(row.po_status),
      subtotal: asNumber(row.subtotal),
      vatAmount: asNumber(row.vat_amount),
      total: asNumber(row.total),
      status: asText(row.status),
      sentAt: asNullableText(row.sent_at),
      toEmail: asNullableText(row.to_email),
      createdAt: asNullableText(row.created_at),
      cancelledAt: asNullableText(row.cancelled_at),
      cancelReason: asNullableText(row.cancel_reason),
      cancelEmailSentAt: asNullableText(row.cancel_email_sent_at),
      lines: (Array.isArray(row.lines) ? row.lines : []).map((rawLine) => {
        const line = asRecord(rawLine);
        return {
          position: asNumber(line.position) ?? 0,
          itemId: asText(line.item_id),
          productName: asText(line.product_name),
          quantity: asNumber(line.quantity) ?? 0,
          unit: asText(line.unit),
          unitPrice: asNumber(line.unit_price),
          lineTotal: asNumber(line.line_total),
          vatRate: asNumber(line.vat_rate),
          grossAmount: asNumber(line.gross_amount),
        };
      }),
      uploads: (Array.isArray(row.uploads) ? row.uploads : [])
        .map(parseHistoryUpload)
        .filter((upload): upload is SupplierOrderUpload => upload !== null),
      receipt: Object.keys(receipt).length === 0
        ? null
        : {
            id: asNullableText(receipt.id),
            receiptNumber: asNullableText(receipt.receipt_number),
            status: asText(receipt.status),
            finalizedAt: asNullableText(receipt.finalized_at),
          },
      payment: Object.keys(payment).length === 0
        ? null
        : {
            requestNumber: asNullableText(payment.request_number),
            status: asText(payment.status),
            paymentStatus: asText(payment.payment_status),
            totalAmount: asNumber(payment.total_amount),
          },
      prepay: Object.keys(prepay).length === 0
        ? null
        : {
            status: asText(prepay.status),
            requestNumber: asNullableText(prepay.request_number),
            submissionNumber: asNullableText(prepay.submission_number),
          },
    });
  }
  return output;
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

export async function readFunctionError(error: unknown): Promise<{ code: string; message: string; status: number }> {
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

export async function previewSupplierOrder(
  input: SendSupplierOrderLinesInput,
): Promise<SupplierOrderPreview> {
  const requestId = input.requestId ?? createSupplierOrderRequestId();
  const { supabase } = await import("../integrations/supabase/client");
  const { data, error } = await supabase.functions.invoke("supplier-order-send", {
    body: {
      supplier_id: input.supplierId,
      lines: input.lines.map((line) => ({
        item_id: line.itemId,
        quantity: line.quantity,
      })),
      note: input.note ?? "",
      request_id: requestId,
      mode: "preview",
      prepay: input.prepay === true,
      delivery: serializeDeliveryChoice(input.delivery),
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
      asText(payload.error, "Không xem trước được đơn đặt hàng"),
    );
  }
  const parsed = parseSupplierOrderPreview(payload);
  if (!parsed) {
    throw new SupplierOrderClientError("preview_failed", "Không xem trước được đơn đặt hàng");
  }
  return parsed;
}

export async function sendSupplierOrderLines(
  input: SendSupplierOrderLinesInput,
): Promise<SendSupplierOrderLinesResult> {
  const requestId = input.requestId ?? createSupplierOrderRequestId();
  const { supabase } = await import("../integrations/supabase/client");
  const { data, error } = await supabase.functions.invoke("supplier-order-send", {
    body: {
      supplier_id: input.supplierId,
      lines: input.lines.map((line) => ({
        item_id: line.itemId,
        quantity: line.quantity,
      })),
      note: input.note ?? "",
      request_id: requestId,
      mode: "send",
      prepay: input.prepay === true,
      delivery: serializeDeliveryChoice(input.delivery),
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

  const parsed = parseSendSupplierOrderLinesResult(payload);
  if (!parsed) {
    throw new SupplierOrderClientError("send_failed", "Không gửi được email đặt hàng");
  }
  return parsed;
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
