/**
 * Typed data layer for the KFM daily-delivery report.
 *
 * No visual components. Parsers accept PostgREST JSON defensively: numeric
 * fields may arrive as strings and optional fields may be absent.
 */

export type KfmDeliveryRow = {
  poNumber: string;
  customerPoInboxId: string | null;
  deliveryDate: string | null;
  poQty: number;
  deliveredQty: number;
  shortfall: number;
  ratio: number | null;
  isDefault: boolean;
  source: string | null;
  note: string | null;
  updatedAt: string | null;
};

export type KfmDeliveryTotals = {
  poCount: number;
  poQty: number;
  deliveredQty: number;
  shortfall: number;
  ratio: number | null;
  confirmedCount: number;
  under95Count: number;
};

export type KfmDeliveryDay = {
  date: string | null;
  poCount: number;
  poQty: number;
  deliveredQty: number;
  shortfall: number;
  ratio: number | null;
  provisionalCount: number;
  rows: KfmDeliveryRow[];
};

export type KfmDeliveryRatioFilter = "all" | "under95" | "95to98" | "98plus";

export type KfmDispatchJevQuantity = {
  poNumber: string;
  qty: number;
};

export type KfmDispatchPhoto = {
  id: string;
  storagePath: string;
  createdAt: string | null;
  savedAt: string | null;
  jevStatus: string | null;
  jevKind: string | null;
  jevPoNumbers: string[];
  jevQuantities: KfmDispatchJevQuantity[];
  jevSummary: string | null;
  jevMismatch: boolean | null;
};

export type KfmDailyDeliveryReport = {
  date: string | null;
  pos: KfmDeliveryRow[];
  photos: KfmDispatchPhoto[];
};

export type KfmDeliveryVsPo = {
  rows: KfmDeliveryRow[];
  totals: KfmDeliveryTotals;
};

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
  const raw = typeof value === "number"
    ? value
    : Number(String(value).trim().replace(/\s/g, ""));
  if (Number.isFinite(raw)) return raw;
  const text = String(value).trim().replace(/\s/g, "");
  const normalized = text.includes(",") && !text.includes(".")
    ? text.replace(",", ".")
    : text.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function asTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function asQuantities(value: unknown): KfmDispatchJevQuantity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: KfmDispatchJevQuantity[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const poNumber = asText(row.po_number ?? row.poNumber).trim();
    const qty = asNumber(row.qty);
    if (poNumber === "" || qty === null || seen.has(poNumber)) continue;
    seen.add(poNumber);
    result.push({ poNumber, qty });
  }
  return result;
}

/** Vietnamese labels for the four document kinds the server stores. */
export function jevKindLabel(kind: string | null | undefined): string {
  if (kind === "phieu_xuat_kho") return "Phiếu xuất kho";
  if (kind === "bien_ban_giao_hang") return "Biên bản giao hàng";
  if (kind === "hoa_don") return "Hoá đơn";
  if (kind === "khac") return "Khác";
  return "";
}

function parseDeliveryRow(value: unknown): KfmDeliveryRow | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;

  const poQty = asNumber(row.po_qty ?? row.poQty) ?? 0;
  const deliveredQty = asNumber(row.delivered_qty ?? row.deliveredQty) ?? poQty;
  const ratio = asNumber(row.ratio)
    ?? (poQty === 0 ? null : deliveredQty / poQty);

  return {
    poNumber: asText(row.po_number ?? row.poNumber).trim(),
    customerPoInboxId: asNullableText(
      row.customer_po_inbox_id ?? row.customerPoInboxId,
    ),
    deliveryDate: asNullableText(row.delivery_date ?? row.deliveryDate),
    poQty,
    deliveredQty,
    shortfall: asNumber(row.shortfall) ?? deliveredQty - poQty,
    ratio,
    isDefault: asBoolean(row.is_default ?? row.isDefault),
    source: asNullableText(row.source),
    note: asNullableText(row.note),
    updatedAt: asNullableText(row.updated_at ?? row.updatedAt),
  };
}

function parsePhoto(value: unknown): KfmDispatchPhoto | null {
  const row = asRecord(value);
  if (Object.keys(row).length === 0) return null;
  return {
    id: asText(row.id),
    storagePath: asText(row.storage_path ?? row.storagePath),
    createdAt: asNullableText(row.created_at ?? row.createdAt),
    savedAt: asNullableText(row.saved_at ?? row.savedAt),
    jevStatus: asNullableText(row.jev_status ?? row.jevStatus),
    jevKind: asNullableText(row.jev_kind ?? row.jevKind),
    jevPoNumbers: asTextArray(row.jev_po_numbers ?? row.jevPoNumbers),
    jevQuantities: asQuantities(row.jev_quantities ?? row.jevQuantities),
    jevSummary: asNullableText(row.jev_summary ?? row.jevSummary),
    jevMismatch: asNullableBoolean(row.jev_mismatch ?? row.jevMismatch),
  };
}

export function parseKfmDispatchPhoto(
  value: unknown,
): KfmDispatchPhoto | null {
  return parsePhoto(value);
}

function parseRows(value: unknown): KfmDeliveryRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseDeliveryRow)
    .filter((row): row is KfmDeliveryRow => row !== null);
}

function rowTotals(rows: KfmDeliveryRow[]): KfmDeliveryTotals {
  const poQty = rows.reduce((sum, row) => sum + row.poQty, 0);
  const deliveredQty = rows.reduce((sum, row) => sum + row.deliveredQty, 0);
  return {
    poCount: rows.length,
    poQty,
    deliveredQty,
    shortfall: deliveredQty - poQty,
    ratio: poQty === 0 ? null : deliveredQty / poQty,
    confirmedCount: rows.filter((row) => !row.isDefault).length,
    under95Count: rows.filter(
      (row) => row.poQty > 0 && row.deliveredQty < row.poQty * 0.95,
    ).length,
  };
}

export function parseKfmDeliveryVsPo(value: unknown): KfmDeliveryVsPo {
  const root = asRecord(value);
  const rawRows = Array.isArray(value)
    ? value
    : Array.isArray(root.rows)
    ? root.rows
    : [];
  const rows = parseRows(rawRows);
  const fallback = rowTotals(rows);
  const rawTotals = asRecord(root.totals);
  const poQty = asNumber(rawTotals.po_qty ?? rawTotals.poQty) ?? fallback.poQty;
  const deliveredQty = asNumber(
    rawTotals.delivered_qty ?? rawTotals.deliveredQty,
  ) ?? fallback.deliveredQty;

  return {
    rows,
    totals: {
      poCount: asNumber(rawTotals.po_count ?? rawTotals.poCount)
        ?? fallback.poCount,
      poQty,
      deliveredQty,
      shortfall: asNumber(rawTotals.shortfall)
        ?? deliveredQty - poQty,
      ratio: asNumber(rawTotals.ratio)
        ?? (poQty === 0 ? null : deliveredQty / poQty),
      confirmedCount: asNumber(
        rawTotals.confirmed_count ?? rawTotals.confirmedCount,
      ) ?? fallback.confirmedCount,
      under95Count: asNumber(
        rawTotals.under_95_count ?? rawTotals.under95Count,
      ) ?? fallback.under95Count,
    },
  };
}

export function parseKfmDailyDeliveryReport(
  value: unknown,
): KfmDailyDeliveryReport {
  const root = asRecord(value);
  const rawPos = Array.isArray(value)
    ? value
    : Array.isArray(root.pos)
    ? root.pos
    : [];
  const rawPhotos = Array.isArray(root.photos) ? root.photos : [];

  return {
    date: asNullableText(root.date),
    pos: parseRows(rawPos),
    photos: rawPhotos
      .map(parsePhoto)
      .filter((photo): photo is KfmDispatchPhoto => photo !== null),
  };
}

export function deliveryRatioBand(
  ratio: number | null | undefined,
): "ok" | "warn" | "bad" | "none" {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return "none";
  }
  if (ratio >= 0.95) return "ok";
  if (ratio >= 0.85) return "warn";
  return "bad";
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** ISO dates sort lexicographically; the undated bucket always goes last. */
function compareDeliveryDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareText(a, b);
}

function dayFromRows(
  date: string | null,
  rows: KfmDeliveryRow[],
): KfmDeliveryDay {
  const sortedRows = [...rows].sort((a, b) => compareText(a.poNumber, b.poNumber));
  const poQty = sortedRows.reduce((sum, row) => sum + row.poQty, 0);
  const deliveredQty = sortedRows.reduce((sum, row) => sum + row.deliveredQty, 0);
  return {
    date,
    poCount: sortedRows.length,
    poQty,
    deliveredQty,
    shortfall: deliveredQty - poQty,
    ratio: poQty === 0 ? null : deliveredQty / poQty,
    provisionalCount: sortedRows.filter((row) => row.isDefault === true).length,
    rows: sortedRows,
  };
}

export function groupDeliveryByDay(rows: KfmDeliveryRow[]): KfmDeliveryDay[] {
  const groups = new Map<string, KfmDeliveryRow[]>();
  const undated: KfmDeliveryRow[] = [];
  for (const row of rows) {
    const date = row.deliveryDate ? row.deliveryDate.slice(0, 10) : null;
    if (date === null) {
      undated.push(row);
      continue;
    }
    const bucket = groups.get(date);
    if (bucket) bucket.push(row);
    else groups.set(date, [row]);
  }

  const days = Array.from(groups, ([date, dayRows]) => dayFromRows(date, dayRows));
  if (undated.length > 0) days.push(dayFromRows(null, undated));
  return days.sort((a, b) => compareDeliveryDate(a.date, b.date));
}

export function filterDeliveryDays(
  days: KfmDeliveryDay[],
  { shortOnly, band }: { shortOnly: boolean; band: KfmDeliveryRatioFilter },
): KfmDeliveryDay[] {
  return days.filter((day) => {
    if (shortOnly && day.shortfall >= 0) return false;
    if (band === "all") return true;
    if (day.ratio === null) return false;
    if (band === "under95") return day.ratio < 0.95;
    if (band === "95to98") return day.ratio >= 0.95 && day.ratio < 0.98;
    return day.ratio >= 0.98;
  });
}

export function sortDeliveryDays(
  days: KfmDeliveryDay[],
  by: "date" | "ratio",
): KfmDeliveryDay[] {
  const sorted = [...days];
  if (by === "date") {
    return sorted.sort((a, b) => compareDeliveryDate(a.date, b.date));
  }
  return sorted.sort((a, b) => {
    if (a.ratio !== b.ratio) {
      if (a.ratio === null) return 1;
      if (b.ratio === null) return -1;
      return a.ratio < b.ratio ? -1 : 1;
    }
    return compareDeliveryDate(a.date, b.date);
  });
}

export function sumDeliveryDays(days: KfmDeliveryDay[]): {
  poCount: number;
  poQty: number;
  deliveredQty: number;
  shortfall: number;
  ratio: number | null;
} {
  const poCount = days.reduce((sum, day) => sum + day.poCount, 0);
  const poQty = days.reduce((sum, day) => sum + day.poQty, 0);
  const deliveredQty = days.reduce((sum, day) => sum + day.deliveredQty, 0);
  return {
    poCount,
    poQty,
    deliveredQty,
    shortfall: deliveredQty - poQty,
    ratio: poQty === 0 ? null : deliveredQty / poQty,
  };
}

export function monthRange(dateIso: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})-\d{2}/.exec(dateIso);
  if (!match) {
    throw new Error("invalid_date");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error("invalid_date");
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthText = String(month).padStart(2, "0");
  return {
    from: `${match[1]}-${monthText}-01`,
    to: `${match[1]}-${monthText}-${String(lastDay).padStart(2, "0")}`,
  };
}
