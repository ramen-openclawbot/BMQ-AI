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

/** One picked old document: a payment request or a PO without a live PR. */
export type DebtPick = {
  kind: DebtKind;
  id: string;
};

/** Backwards-compatible alias for the legacy single pick. */
export type RobotOrderDebtRef = DebtPick;

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
  /** Every picked old document, in pick order (absent on packages sent before 15/10). */
  debt_picks?: { kind: DebtKind; id: string; number: string | null; doc_date: string | null; remaining: number | null; rank: number | null }[];
}

/** The picked document numbers of a package, falling back to the legacy single debt. */
export function packageDebtNumbers(result: Pick<RobotOrderPackageResult, "debt" | "debt_picks"> | null | undefined): string[] {
  const picks = result?.debt_picks ?? [];
  if (picks.length) return picks.map((pick) => pick.number ?? pick.id.slice(0, 8));
  return result?.debt?.number ? [result.debt.number] : [];
}

export interface CreateRobotOrderPackageInput {
  lines: RobotOrderLineInput[];
  /** The picked old documents; an empty array is sent to the RPC as null. */
  debt: DebtPick[] | null;
  note: string | null;
  idempotency_key: string;
}

/** The RPC output for get_supplier_debt_pick_pattern (phase-2 suggestions). */
export interface SupplierDebtPickPattern {
  supplier_id: string;
  packages: number;
  last_picked_count: number | null;
  median_picked_count: number | null;
  avg_picked_total: number | null;
  oldest_first_share: number | null;
  last_picked_at: string | null;
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

/** Maximum number of old documents one robot package may submit. */
export const MAX_DEBT_PICKS = 20;

/**
 * Toggle one debt row in the pick list by id: remove it when already picked,
 * otherwise append it (never past MAX_DEBT_PICKS). Return a new array.
 */
export function toggleDebtPick(picks: readonly DebtPick[], row: DebtPick): DebtPick[] {
  const list = picks ?? [];
  if (list.some((pick) => pick.id === row.id)) {
    return list.filter((pick) => pick.id !== row.id);
  }
  if (list.length >= MAX_DEBT_PICKS) return [...list];
  return [...list, { kind: row.kind, id: row.id }];
}

/** Sum the remaining amount of the rows whose id is picked. */
export function sumDebtPicks(
  rows: readonly SupplierDebtRow[],
  picks: readonly DebtPick[],
): number {
  const chosen = new Set((picks ?? []).map((pick) => pick.id));
  return (rows ?? []).reduce(
    (total, row) => (chosen.has(row.id) ? total + (row.remaining ?? 0) : total),
    0,
  );
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
