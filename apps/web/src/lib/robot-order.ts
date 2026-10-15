/**
 * Robot đặt hàng NVL — pure client rules (no React, no Supabase).
 *
 * The types mirror the three RPC outputs: get_item_purchase_facts (B),
 * get_supplier_debt_candidates (C) and create_robot_order_package (D). The
 * helpers group order lines per supplier, order the debt rows for the operator,
 * summarise a created package and translate the server error codes.
 */

// ---------------------------------------------------------------------------
// B — get_item_purchase_facts
// ---------------------------------------------------------------------------

export interface ItemPurchaseFact {
  item_id: string;
  item_name: string;
  unit: string | null;
  last_supplier_id: string | null;
  last_supplier_name: string | null;
  last_unit_price: number | null;
  last_unit: string | null;
  last_date: string | null;
  suggested_qty: number | null;
}

const WEIGHT_VOLUME: Readonly<Record<string, { base: string; toBase: number }>> = {
  g: { base: "g", toBase: 1 }, gr: { base: "g", toBase: 1 }, gram: { base: "g", toBase: 1 },
  kg: { base: "g", toBase: 1000 },
  ml: { base: "ml", toBase: 1 },
  l: { base: "ml", toBase: 1000 }, "lít": { base: "ml", toBase: 1000 }, lit: { base: "ml", toBase: 1000 },
};

/**
 * The last price restated per the basket line's unit: the last receipt may be priced per kg
 * while the kho item counts g (Peerless Úc 25kg: 90.000đ/kg on a g line made 91 g cost 8,2 triệu).
 * Null when the two units cannot be converted, so the operator types the price.
 */
export function priceInUnit(price: number | null, fromUnit: string | null, toUnit: string | null): number | null {
  if (price === null || !Number.isFinite(price)) return null;
  const from = (fromUnit ?? "").trim().toLowerCase();
  const to = (toUnit ?? "").trim().toLowerCase();
  if (from === "" || to === "" || from === to) return price;
  const a = WEIGHT_VOLUME[from];
  const b = WEIGHT_VOLUME[to];
  if (!a || !b || a.base !== b.base) return null;
  return (price * b.toBase) / a.toBase;
}

/** One robot order line; the RPC only needs supplier / name / qty / unit / price. */
export interface RobotOrderLineInput {
  supplier_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  item_id?: string | null;
}

export interface SupplierLineGroup {
  supplier_id: string;
  lines: RobotOrderLineInput[];
}

// ---------------------------------------------------------------------------
// C — get_supplier_debt_candidates
// ---------------------------------------------------------------------------

export type DebtKind = "pr" | "po";
export type DebtMark = "settled_outside" | "real_debt" | "unsure";
export type DebtMarkSource = "learned" | "jev" | "manual";

export interface SupplierDebtRow {
  kind: DebtKind;
  id: string;
  number: string | null;
  title?: string | null;
  doc_date: string;
  amount: number | null;
  remaining: number | null;
  purchase_order_id?: string | null;
  po_number?: string | null;
  goods_receipt_id?: string | null;
  last_submission_number?: string | null;
  age_days?: number | null;
  has_receipt?: boolean;
  mark?: DebtMark | string | null;
  mark_source?: DebtMarkSource | string | null;
  probability?: number | null;
  before_cutover?: boolean;
  /** Set by rankDebtRows: the row is folded to the end of the list. */
  collapsed?: boolean;
}

export interface SupplierDebtCutover {
  kind: DebtKind;
  id: string;
  number: string | null;
  start_date: string;
}

export interface SupplierDebtStats {
  paid_90d?: number | null;
  median_lag_days?: number | null;
  last_paid_date?: string | null;
}

export interface SupplierDebtCandidates {
  supplier_id: string;
  cutover: SupplierDebtCutover | null;
  stats: SupplierDebtStats;
  rows: SupplierDebtRow[];
}

// ---------------------------------------------------------------------------
// D — create_robot_order_package
// ---------------------------------------------------------------------------

export interface RobotOrderDebtRef {
  kind: DebtKind;
  id: string;
}

export interface RobotOrderPackageDebt {
  kind: DebtKind;
  id: string;
  number: string | null;
  submission_id: string | null;
  submission_number: string | null;
}

export interface RobotOrderPackageResult {
  package_id: string;
  purchase_order_ids: string[];
  po_numbers: string[];
  debt: RobotOrderPackageDebt | null;
  cutover_start_date: string | null;
  marked_settled_outside_count: number;
  idempotent: boolean;
}

export interface CreateRobotOrderPackageInput {
  lines: RobotOrderLineInput[];
  debt: RobotOrderDebtRef | null;
  note: string | null;
  idempotency_key: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group order lines by supplier, preserving the first-seen supplier order and
 * the line order inside each group.
 */
export function groupLinesBySupplier(lines: readonly RobotOrderLineInput[]): SupplierLineGroup[] {
  const groups: SupplierLineGroup[] = [];
  const index = new Map<string, number>();
  for (const line of lines ?? []) {
    const key = String(line?.supplier_id ?? "").trim();
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, groups.length);
      groups.push({ supplier_id: key, lines: [line] });
    } else {
      groups[at].lines.push(line);
    }
  }
  return groups;
}

function settledRank(row: SupplierDebtRow): number {
  return row.mark === "settled_outside" ? 1 : 0;
}

/**
 * Keep the server's farthest-first order inside each bucket, but:
 *  - move every before_cutover row to the end and set collapsed = true;
 *  - inside one bucket, put settled_outside (any source) after real_debt and the
 *    unmarked rows.
 */
export function rankDebtRows(rows: readonly SupplierDebtRow[]): SupplierDebtRow[] {
  const normal: SupplierDebtRow[] = [];
  const collapsed: SupplierDebtRow[] = [];
  for (const row of rows ?? []) {
    if (row?.before_cutover) collapsed.push({ ...row, collapsed: true });
    else normal.push({ ...row, collapsed: false });
  }
  const orderBucket = (bucket: SupplierDebtRow[]): SupplierDebtRow[] =>
    bucket
      .map((row, index) => ({ row, index }))
      .sort((left, right) =>
        settledRank(left.row) - settledRank(right.row) || left.index - right.index)
      .map((entry) => entry.row);
  return [...orderBucket(normal), ...orderBucket(collapsed)];
}

/** Short Vietnamese summary of a created package, for a toast. */
export function packageSummary(
  result: Pick<RobotOrderPackageResult, "purchase_order_ids" | "po_numbers" | "debt"> & {
    marked_settled_outside_count?: number;
  },
): string {
  const count = result.purchase_order_ids?.length ?? 0;
  const numbers = (result.po_numbers ?? []).filter((number) => Boolean(number)).join(", ");
  const parts = [`Đã tạo ${count} đơn nháp${numbers ? ` (${numbers})` : ""}`];
  if (result.debt) {
    const number = result.debt.number ? ` ${result.debt.number}` : "";
    const submission = result.debt.submission_number ? ` · phiếu ${result.debt.submission_number}` : "";
    parts.push(`trả đơn cũ${number}${submission}`);
  }
  const marked = result.marked_settled_outside_count ?? 0;
  if (marked > 0) parts.push(`đánh dấu ${marked} khoản cũ đã trả ngoài`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ROBOT_ORDER_ERROR_CODES = [
  "forbidden",
  "debt_not_payable",
  "one_supplier_per_package",
  "idempotency_key_required",
  "insufficient_privilege",
] as const;

export type RobotOrderErrorCode = (typeof ROBOT_ORDER_ERROR_CODES)[number] | "unknown";

function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const candidate = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    return [candidate.message, candidate.code, candidate.details, candidate.hint]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }
  return String(error);
}

/** Map a failed RPC / edge error to one of the known robot-order codes. */
export function robotOrderErrorCode(error: unknown): RobotOrderErrorCode {
  const text = errorText(error).toLowerCase();
  for (const code of ROBOT_ORDER_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  return "unknown";
}

const ROBOT_ORDER_ERROR_TEXT: Record<RobotOrderErrorCode, string> = {
  forbidden: "Anh không có quyền tạo gói đặt hàng này.",
  debt_not_payable: "Công nợ này không còn phù hợp để trả (đã trả hoặc đã bị từ chối).",
  one_supplier_per_package: "Mỗi gói chỉ được đặt hàng cho một nhà cung cấp.",
  idempotency_key_required: "Thiếu khoá chống trùng, anh thử lại giúp.",
  insufficient_privilege: "Tài khoản chưa được cấp quyền thực hiện việc này.",
  unknown: "Không tạo được gói đặt hàng. Anh thử lại nhé.",
};

/** Short Vietnamese message for a robot-order error code. */
export function robotOrderErrorText(code: string): string {
  return ROBOT_ORDER_ERROR_TEXT[code as RobotOrderErrorCode] ?? ROBOT_ORDER_ERROR_TEXT.unknown;
}
