/**
 * Kho văn phòng — pure client rules (no React, no Supabase).
 *
 * The types mirror the two RPC outputs:
 *   * get_office_order_snapshot(text) — one warehouse's items with their
 *     material group and the last 120 days of purchase facts.
 *   * get_payment_doc_detail(text, uuid) — one PR or one PO in full.
 *
 * The helpers group an item into one of the ten office shelves, predict which
 * item is about to run out from its purchase cycle, search / order the shelves
 * and total a document. They are pure so node:test can cover them offline.
 */

// ---------------------------------------------------------------------------
// Snapshot — get_office_order_snapshot
// ---------------------------------------------------------------------------

export interface OfficeOrderSnapshotItem {
  id: string;
  item_code: string;
  name: string;
  unit: string | null;
  item_class: string | null;
  pastry_q7: boolean;
  category: string | null;
  /** Distinct receipt days in the last 120 days. */
  receipts: number;
  first_date: string | null;
  last_date: string | null;
  /** Average stock qty per receipt day. */
  avg_qty: number | null;
  total_qty: number | null;
  median_gap_days: number | null;
  supplier_id: string | null;
  supplier_name: string | null;
  last_unit: string | null;
  last_unit_price: number | null;
  /** Sum of the raw receipt qty on the last receipt day, in last_unit. */
  last_raw_qty: number | null;
  forecast_suggested_qty?: number | null;
  forecast_daily_usage?: number | null;
}

export interface OfficeOrderCategory {
  code: string;
  label_vi: string;
  sort_order: number;
}

export interface OfficeOrderSnapshot {
  as_of: string;
  location: string;
  categories: OfficeOrderCategory[];
  items: OfficeOrderSnapshotItem[];
}

// ---------------------------------------------------------------------------
// Doc detail — get_payment_doc_detail
// ---------------------------------------------------------------------------

export interface DocLine {
  name: string;
  qty: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  change: number | null;
}

export interface DocSupplier {
  id: string | null;
  name: string | null;
}

export interface DocGr {
  id: string;
  number: string | null;
  date: string | null;
  status: string | null;
  has_image: boolean;
  /** Storage path of the delivery-note photo (migration 20261101360000). */
  image_path?: string | null;
  /** Extra product photos taken at receiving. */
  photos?: string[] | null;
}

export interface DocAttachment {
  path: string;
  name: string | null;
  mime: string | null;
}

export interface DocPoRef {
  id: string;
  number: string | null;
  date: string | null;
  status: string | null;
  amount: number | null;
}

export interface DocPrRef {
  id: string;
  number: string | null;
  status: string | null;
  payment_status: string | null;
  amount: number | null;
}

export interface PaymentDocPrDetail {
  kind: "pr";
  id?: string;
  number: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: string | null;
  payment_status: string | null;
  delivery_status: string | null;
  payment_type: string | null;
  payment_method: string | null;
  amount: number | null;
  vat: number | null;
  created_at: string | null;
  invoice_created: boolean | null;
  has_image: boolean;
  image_path?: string | null;
  attachments?: DocAttachment[] | null;
  supplier: DocSupplier | null;
  po: DocPoRef | null;
  gr: DocGr | null;
  lines: DocLine[];
}

export interface PaymentDocPoDetail {
  kind: "po";
  id?: string;
  number: string;
  date: string | null;
  expected: string | null;
  status: string | null;
  amount: number | null;
  vat: number | null;
  notes: string | null;
  has_image: boolean;
  image_path?: string | null;
  supplier: DocSupplier | null;
  gr: DocGr | null;
  prs: DocPrRef[];
  lines: DocLine[];
}

export type PaymentDocDetail = PaymentDocPrDetail | PaymentDocPoDetail;

// ---------------------------------------------------------------------------
// Document photos
// ---------------------------------------------------------------------------

/** One viewable photo of a PR / PO, with the storage bucket it belongs to. */
export interface DocPhotoRef {
  key: string;
  label: string;
  path: string;
  bucket: "invoices" | "purchase-orders";
  name?: string | null;
  mime?: string | null;
}

/** The goods-receipt photos of a doc: the delivery note then the product photos. */
function grPhotos(gr: DocGr | null): DocPhotoRef[] {
  if (!gr) return [];
  const out: DocPhotoRef[] = [];
  if (gr.image_path) {
    out.push({
      key: `gr-${gr.image_path}`,
      label: `Phiếu nhập ${gr.number ?? ""}`.trim(),
      path: gr.image_path,
      bucket: "invoices",
    });
  }
  (gr.photos ?? []).forEach((path, i) => {
    out.push({ key: `grp-${path}`, label: `Ảnh hàng ${i + 1}`, path, bucket: "invoices" });
  });
  return out;
}

/**
 * Every photo of a PR / PO, in the order the detail shows them: the header photo,
 * the PR attachments, then the linked goods receipt (delivery note, product
 * photos). Same buckets as the finance pages — 'invoices' for PR / GR and
 * 'purchase-orders' for PO.
 */
export function docPhotos(doc: PaymentDocDetail): DocPhotoRef[] {
  if (doc.kind === "pr") {
    return [
      ...(doc.image_path
        ? [{ key: `pr-${doc.image_path}`, label: "Ảnh đề nghị chi", path: doc.image_path, bucket: "invoices" as const }]
        : []),
      ...(doc.attachments ?? []).map((attachment, i) => ({
        key: `att-${attachment.path}`,
        label: attachment.name ?? `Tệp đính kèm ${i + 1}`,
        path: attachment.path,
        bucket: "invoices" as const,
        name: attachment.name,
        mime: attachment.mime,
      })),
      ...grPhotos(doc.gr),
    ];
  }
  return [
    ...(doc.image_path
      ? [{ key: `po-${doc.image_path}`, label: "Ảnh đơn mua", path: doc.image_path, bucket: "purchase-orders" as const }]
      : []),
    ...grPhotos(doc.gr),
  ];
}

/** How many photos the document detail shows. */
export function photoCount(doc: PaymentDocDetail): number {
  return docPhotos(doc).length;
}

// ---------------------------------------------------------------------------
// Groups / shelves
// ---------------------------------------------------------------------------

/** The ten office shelves, in display order (stock_material_categories order). */
export const GROUP_CODES = [
  "flour",
  "dairy_fat",
  "eggs",
  "sugar_additives",
  "meat_filling",
  "cheese",
  "vegetables",
  "packaging",
  "supplies",
  "other",
] as const;

export type GroupCode = (typeof GROUP_CODES)[number];

const MASTER_CODES = new Set<string>(GROUP_CODES as readonly string[]);

export interface ShelfMeta {
  label: string;
  color: string;
  icon: string;
}

/**
 * The ten shelves with their Vietnamese label, colour token and icon, matching
 * the approved demo. Every other stock_material_categories code (for example
 * 'service') never gets a shelf of its own.
 */
export const SHELF_META: Record<GroupCode, ShelfMeta> = {
  flour: { label: "Bột và ngũ cốc", color: "amber", icon: "🌾" },
  dairy_fat: { label: "Sữa, bơ, chất béo", color: "sky", icon: "🥛" },
  eggs: { label: "Trứng", color: "yellow", icon: "🥚" },
  sugar_additives: { label: "Đường và phụ gia", color: "pink", icon: "🧂" },
  meat_filling: { label: "Nhân thịt, chả, pate", color: "rose", icon: "🥩" },
  cheese: { label: "Phô mai", color: "orange", icon: "🧀" },
  vegetables: { label: "Rau củ, gia vị", color: "green", icon: "🥕" },
  packaging: { label: "Bao bì", color: "stone", icon: "📦" },
  supplies: { label: "Vật tư, dụng cụ", color: "slate", icon: "🧤" },
  other: { label: "Khác", color: "zinc", icon: "🗂️" },
};

/**
 * Fold a name for search / rules: lowercase, strip Vietnamese diacritics and
 * turn đ into d. Everything the regex rules match is written on this form.
 */
export function fold(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

/** Guess rules, first match wins, applied on fold(name). */
const GUESS_RULES: ReadonlyArray<{ code: GroupCode; re: RegExp }> = [
  {
    code: "supplies",
    re: /bao tay|gang tay|khau trang|non sau|nuoc rua|nuoc lau|tay rua|xit thom|\bcon 70|giay ve sinh|khan giay|tui rac|do rua chen|mut rua|muc in/,
  },
  { code: "other", re: /nuoc da|da bao|nuoc uong|vinh hao|vihawa/ },
  { code: "cheese", re: /pho mai|cheese/ },
  {
    code: "packaging",
    re: /\bbao\b|\btui\b|\bhop\b|\bnhan\b|\btem\b|\bboc\b|mang boc|decal|giay nen|giay tham|giay lot|\bkhay\b|\bnap\b|bang keo|\bbich\b|nhom la/,
  },
  { code: "meat_filling", re: /cha lua|cha bong|\bpate\b|\bgan\b|nac dui|thit|mo cat|xuc xich/ },
  { code: "eggs", re: /trung/ },
  { code: "dairy_fat", re: /sua|\bbo\b|kem|whipping|cream|\bdau\b|\bmo\b/ },
  { code: "flour", re: /\bbot\b(?! ngot)|peerless|ngu coc/ },
  {
    code: "sugar_additives",
    re: /duong|phu gia|\bmen\b|muoi|bot ngot|giam|bico|mauri|re an khe|socola/,
  },
  {
    code: "vegetables",
    re: /ca rot|cu cai|dua leo|hanh|ngo ri|\bot\b|toi|tieu|tuong ot|mui tay|rau/,
  },
];

export interface GroupMatch {
  code: GroupCode;
  source: "master" | "guess";
}

/**
 * The shelf of one item: the Material Master category wins when it is one of the
 * ten shelves, otherwise the name rules decide and the item class is the last
 * fallback (packaging_supply -> packaging, everything else -> other).
 */
export function groupForItem(
  name: string | null | undefined,
  itemClass: string | null | undefined,
  masterCategory: string | null | undefined,
): GroupMatch {
  const master = (masterCategory ?? "").trim();
  if (MASTER_CODES.has(master)) {
    return { code: master as GroupCode, source: "master" };
  }

  const folded = fold(name);
  for (const rule of GUESS_RULES) {
    if (rule.re.test(folded)) return { code: rule.code, source: "guess" };
  }

  return {
    code: itemClass === "packaging_supply" ? "packaging" : "other",
    source: "guess",
  };
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export type DayInput = string | Date | null | undefined;

function dayValue(value: DayInput): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (match) {
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

function daysBetween(from: DayInput, to: DayInput): number | null {
  const start = dayValue(from);
  const end = dayValue(to);
  if (start == null || end == null) return null;
  return (end - start) / 86400000;
}

export interface PredictableItem {
  receipts: number;
  first_date: string | null;
  last_date: string | null;
  total_qty: number | null;
  median_gap_days: number | null;
  avg_qty: number | null;
}

export type PredictionBasis = "cycle" | "cover" | null;

export interface OfficeOrderPrediction {
  daysLeft: number | null;
  basis: PredictionBasis;
  usagePerDay: number | null;
  low: boolean;
}

/**
 * Days left before an item runs out, from the purchase cycle when there are at
 * least three receipt days, otherwise from the average cover. An item is "low"
 * when receipts >= 2 and daysLeft is between -15 and 2 inclusive.
 */
export function predictItem(item: PredictableItem, asOf: DayInput): OfficeOrderPrediction {
  const receipts = Number(item?.receipts ?? 0);
  const since = daysBetween(item?.last_date, asOf);

  let usagePerDay: number | null = null;
  if (receipts >= 2) {
    const span = Math.max(30, daysBetween(item?.first_date, asOf) ?? 30);
    usagePerDay = Number(item?.total_qty ?? 0) / span;
  }

  let daysLeft: number | null = null;
  let basis: PredictionBasis = null;
  if (receipts >= 3 && item?.median_gap_days != null && since != null) {
    daysLeft = Number(item.median_gap_days) - since;
    basis = "cycle";
  } else if (
    receipts >= 2 &&
    usagePerDay != null &&
    usagePerDay !== 0 &&
    item?.avg_qty != null &&
    since != null
  ) {
    daysLeft = Number(item.avg_qty) / usagePerDay - since;
    basis = "cover";
  }

  const low = receipts >= 2 && daysLeft != null && daysLeft >= -15 && daysLeft <= 2;
  return { daysLeft, basis, usagePerDay, low };
}

/** Short Vietnamese label for a days-left value. */
export function daysLabel(daysLeft: number | null | undefined): string {
  if (daysLeft == null || !Number.isFinite(daysLeft)) return "";
  const rounded = Math.round(daysLeft);
  if (rounded < 0) return `Trễ ${Math.abs(rounded)} ngày`;
  if (rounded === 0) return "Hết hôm nay";
  return `Còn ~${rounded} ngày`;
}

/** The quantity / unit of the last purchase, or null when nothing was bought. */
export function suggestFromLast(
  item: Pick<OfficeOrderSnapshotItem, "last_raw_qty" | "last_unit">,
): { qty: number; unit: string | null } | null {
  const qty = item?.last_raw_qty;
  if (qty == null || !Number.isFinite(qty) || qty <= 0) return null;
  return { qty, unit: item?.last_unit ?? null };
}

/** The default order quantity: the last raw qty, else 1000 for g/ml, else 1. */
export function startQty(
  item: Pick<OfficeOrderSnapshotItem, "last_raw_qty" | "unit">,
): number {
  const qty = item?.last_raw_qty;
  if (qty != null && Number.isFinite(qty) && qty > 0) return qty;
  const unit = (item?.unit ?? "").trim().toLowerCase();
  return unit === "g" || unit === "gr" || unit === "ml" ? 1000 : 1;
}

// ---------------------------------------------------------------------------
// Search / shelves
// ---------------------------------------------------------------------------

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function itemGroup(item: OfficeOrderSnapshotItem): GroupCode {
  return groupForItem(item?.name, item?.item_class, item?.category).code;
}

function explicitLow(item: OfficeOrderSnapshotItem): boolean | null {
  const value = (item as { low?: unknown }).low;
  return typeof value === "boolean" ? value : null;
}

/**
 * Every folded query word must appear in name + item code + supplier + shelf
 * label. Score ascending: a name that starts with the first word first, then
 * low items, then never-bought items, with a small shorter-name bonus. Max 30.
 */
export function searchItems(
  items: readonly OfficeOrderSnapshotItem[],
  query: string,
  asOf: DayInput = todayIso(),
): OfficeOrderSnapshotItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const first = words[0];

  const scored: Array<{ item: OfficeOrderSnapshotItem; score: number; index: number }> = [];
  for (const item of items ?? []) {
    const code = itemGroup(item);
    const haystack = fold(
      [item?.name, item?.item_code, item?.supplier_name, SHELF_META[code].label]
        .filter(Boolean)
        .join(" "),
    );
    if (words.length > 0 && !words.every((word) => haystack.includes(word))) continue;

    const low = explicitLow(item) ?? predictItem(item, asOf).low;
    const foldedName = fold(item?.name);
    const startsWithFirst = first ? foldedName.startsWith(first) : true;
    const neverBought = !((item?.receipts ?? 0) > 0);
    const score =
      (startsWithFirst ? 0 : 1) -
      (low ? 0.5 : 0) +
      (neverBought ? 0.6 : 0) +
      (item?.name?.length ?? 0) / 200;
    scored.push({ item, score, index: scored.length });
  }

  scored.sort((left, right) => left.score - right.score || left.index - right.index);
  return scored.slice(0, 30).map((entry) => entry.item);
}

export interface PredictedOfficeOrderItem extends OfficeOrderSnapshotItem {
  group: GroupCode;
  daysLeft: number | null;
  basis: PredictionBasis;
  usagePerDay: number | null;
  low: boolean;
}

export interface OfficeOrderShelf {
  code: GroupCode;
  label: string;
  color: string;
  icon: string;
  items: PredictedOfficeOrderItem[];
}

function compareShelfItems(
  left: PredictedOfficeOrderItem,
  right: PredictedOfficeOrderItem,
): number {
  if (left.low !== right.low) return left.low ? -1 : 1;
  const leftDays = left.daysLeft ?? Number.POSITIVE_INFINITY;
  const rightDays = right.daysLeft ?? Number.POSITIVE_INFINITY;
  if (leftDays !== rightDays) return leftDays - rightDays;
  const leftDate = left.last_date ?? "";
  const rightDate = right.last_date ?? "";
  if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
  return left.name.localeCompare(right.name, "vi");
}

/**
 * Group the items into the ten shelves (empty shelves dropped) and order each
 * shelf: low items first by daysLeft ascending, then by last purchase date
 * descending, then by name in Vietnamese.
 */
export function buildShelves(
  items: readonly OfficeOrderSnapshotItem[],
  asOf: DayInput,
): OfficeOrderShelf[] {
  const buckets = new Map<GroupCode, PredictedOfficeOrderItem[]>();
  for (const code of GROUP_CODES) buckets.set(code, []);

  for (const item of items ?? []) {
    const code = itemGroup(item);
    const prediction = predictItem(item, asOf);
    buckets.get(code)?.push({
      ...item,
      group: code,
      daysLeft: prediction.daysLeft,
      basis: prediction.basis,
      usagePerDay: prediction.usagePerDay,
      low: prediction.low,
    });
  }

  const shelves: OfficeOrderShelf[] = [];
  for (const code of GROUP_CODES) {
    const list = buckets.get(code) ?? [];
    if (list.length === 0) continue;
    list.sort(compareShelfItems);
    shelves.push({
      code,
      label: SHELF_META[code].label,
      color: SHELF_META[code].color,
      icon: SHELF_META[code].icon,
      items: list,
    });
  }
  return shelves;
}

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

export const PR_STATUS: Record<string, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
};

export const PAY_STATUS: Record<string, string> = {
  unpaid: "Chưa chi",
  paid: "Đã chi",
};

export const DELIVERY: Record<string, string> = {
  pending: "Chưa giao đủ",
  delivered: "Đã giao",
};

export const PAY_TYPE: Record<string, string> = {
  new_order: "Đơn mới",
  old_order: "Công nợ cũ",
};

export const PAY_METHOD: Record<string, string> = {
  bank_transfer: "Chuyển khoản",
  cash: "Tiền mặt",
};

export const PO_STATUS: Record<string, string> = {
  draft: "Nháp",
  sent: "Đã gửi NCC",
  completed: "Hoàn tất",
  cancelled: "Đã huỷ",
};

export const GR_STATUS: Record<string, string> = {
  confirmed: "Đã nhập",
  received: "Đã nhận",
};

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface DocTotals {
  linesSum: number;
  vat: number | null;
  amount: number | null;
  showLinesSum: boolean;
}

function lineTotal(line: DocLine): number {
  if (line?.total != null && Number.isFinite(Number(line.total))) {
    return Number(line.total);
  }
  const qty = Number(line?.qty ?? 0);
  const price = Number(line?.price ?? 0);
  const computed = qty * price;
  return Number.isFinite(computed) ? computed : 0;
}

/** Sum the doc lines and tell whether the line sum differs from the doc amount. */
export function docTotals(
  lines: readonly DocLine[],
  vat: number | null,
  amount: number | null,
): DocTotals {
  const linesSum = (lines ?? []).reduce((sum, line) => sum + lineTotal(line), 0);
  const amountRounded = amount == null ? 0 : Math.round(Number(amount));
  return {
    linesSum,
    vat: vat ?? null,
    amount: amount ?? null,
    showLinesSum: Math.round(linesSum) !== amountRounded,
  };
}
