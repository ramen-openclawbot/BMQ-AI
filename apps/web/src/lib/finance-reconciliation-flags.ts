// Pure helpers for the finance reconciliation flag view
// (public.finance_reconciliation_flags). No I/O, no Supabase, no React: the view
// computes the labels, this module only types them, names them in Vietnamese and
// orders/groups them for display.

/** Stable label set emitted by public.finance_reconciliation_flags. */
export type FinanceReconciliationLabel =
  | "po_overpaid"
  | "po_over_requested"
  | "pr_twin_created"
  | "paid_without_bank_evidence"
  | "paid_without_receipt"
  | "receipt_confirmed_delivery_pending"
  | "invoice_zero_amount"
  | "jev_possible_duplicate";

export type FinanceReconciliationPriority = "critical" | "high" | "medium" | "low";

export type FinanceReconciliationEntityType = "purchase_order" | "payment_request";

export type FinanceReconciliationReviewStatus = "checked" | "false_alarm" | "needs_action";

/**
 * One row of public.finance_reconciliation_flags. `review_status` / `review_note`
 * come from the left join with public.finance_reconciliation_reviews and stay
 * null until the CEO checks the flag.
 */
export interface FinanceReconciliationFlag {
  flag_key: string;
  label: string;
  priority: string;
  category: string;
  entity_type: string;
  entity_id: string;
  entity_ref: string;
  supplier_id: string | null;
  supplier_name: string | null;
  group_key: string;
  amount: number | null;
  evidence: Record<string, unknown> | null;
  detected_at: string;
  review_status: string | null;
  review_note: string | null;
}

/** Short Vietnamese name for each fixed label. */
export const FINANCE_RECONCILIATION_LABELS: Record<string, string> = {
  po_overpaid: "Chi vượt PO",
  po_over_requested: "Đề nghị vượt PO",
  pr_twin_created: "Phiếu tạo trùng",
  paid_without_bank_evidence: "Chi không có UNC",
  // Đổi tên 2026-10-12: trước đây là "Chi chưa nhập kho" (nhãn gốc giữ lại trong
  // ghi chú để contract cũ vẫn đọc được chuỗi cũ).
  paid_without_receipt: "Chi khi chưa nhập kho",
  receipt_confirmed_delivery_pending: "Đã nhập kho, phiếu ghi chưa giao",
  invoice_zero_amount: "Hóa đơn 0 đ",
  jev_possible_duplicate: "Jev nghi chi trùng",
};

/** Lower rank sorts first. Unknown priorities sort last. */
export const FINANCE_RECONCILIATION_PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Vietnamese operator message for the new blocking error codes. */
export const FINANCE_RECONCILIATION_ERROR_MESSAGES: Record<string, string> = {
  po_overpaid:
    "Khoản chi vượt giá trị PO đã duyệt. Cần CEO duyệt thêm ngoại lệ trước khi chi.",
  po_over_requested:
    "Tổng các phiếu đề nghị chi đã vượt giá trị PO đã duyệt. Cần CEO duyệt thêm ngoại lệ.",
  goods_receipt_already_requested:
    "Phiếu nhập này đã có một phiếu đề nghị chi chưa bị từ chối.",
  po_cancel_has_receipt:
    "Không hủy được PO: phiếu nhập đã có hàng nhập kho. Xử lý phiếu nhập trước khi hủy PO.",
  not_owner:
    "Chỉ chủ doanh nghiệp được duyệt cặp phiếu nghi trùng.",
  invalid_decision:
    "Quyết định duyệt cặp phiếu nghi trùng không hợp lệ.",
  check_not_found:
    "Không tìm thấy kết quả quét cặp phiếu nghi trùng này.",
  // Trigger public.guard_payment_request_delivery_image raises
  // "pr_requires_delivery_image: <receipt_number>" (errcode P0001) when a phiếu
  // chi is approved against a PO receipt without a delivery image.
  pr_requires_delivery_image:
    "Phiếu nhập {receipt_number} chưa có ảnh phiếu giao hàng. Mở phiếu nhập, tải ảnh giao hàng rồi duyệt lại.",
};

/** Blocking code raised by public.guard_payment_request_delivery_image. */
export const PR_REQUIRES_DELIVERY_IMAGE_CODE = "pr_requires_delivery_image";

/**
 * Read the receipt number out of a raw `pr_requires_delivery_image: <number>`
 * server error. PostgREST may wrap the database message in a bigger string, so
 * the code is searched anywhere; returns null when it is absent.
 */
export function deliveryImageReceiptNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/pr_requires_delivery_image:\s*"?([^\s;,"')]+)/);
  return match ? match[1] : null;
}

/** First known blocking code contained in a raw server error, or null. */
export function financeReconciliationErrorCode(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const code of Object.keys(FINANCE_RECONCILIATION_ERROR_MESSAGES)) {
    if (text === code || text.includes(code)) return code;
  }
  return null;
}

/**
 * Vietnamese message for a raw server error when it carries one of the known
 * blocking codes, including the `code: detail` form such as the delivery-image
 * trigger error. Returns null when no known code matches.
 */
export function financeReconciliationErrorFromRaw(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = financeReconciliationErrorCode(raw);
  if (!code) return null;
  return financeReconciliationErrorMessage(code, raw);
}

export function financeReconciliationLabel(label: string): string {
  return FINANCE_RECONCILIATION_LABELS[label] ?? label;
}

export function financeReconciliationPriority(priority: string): number {
  return FINANCE_RECONCILIATION_PRIORITY_ORDER[priority] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Critical first, then high/medium/low, then the largest amount. Ties fall back
 * to flag_key so the order is deterministic. Never mutates its input.
 */
export function sortFlags(
  flags: readonly FinanceReconciliationFlag[],
): FinanceReconciliationFlag[] {
  return [...flags].sort((left, right) => {
    const leftPriority = financeReconciliationPriority(left.priority);
    const rightPriority = financeReconciliationPriority(right.priority);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftAmount = left.amount ?? 0;
    const rightAmount = right.amount ?? 0;
    if (leftAmount !== rightAmount) return rightAmount - leftAmount;

    return left.flag_key.localeCompare(right.flag_key);
  });
}

/** Group flags by group_key ('po:<id>' or 'supplier:<id>'). */
export function groupFlags(
  flags: readonly FinanceReconciliationFlag[],
): Record<string, FinanceReconciliationFlag[]> {
  const groups: Record<string, FinanceReconciliationFlag[]> = {};
  for (const flag of flags) {
    const key = flag.group_key || `entity:${flag.entity_id}`;
    const bucket = groups[key] ?? (groups[key] = []);
    bucket.push(flag);
  }
  return groups;
}

/** Vietnamese message for a new blocking error code, or null if unknown. */
export function financeReconciliationErrorMessage(code: string, raw?: string | null): string | null {
  const template = FINANCE_RECONCILIATION_ERROR_MESSAGES[code];
  if (!template) return null;
  if (code === PR_REQUIRES_DELIVERY_IMAGE_CODE) {
    return template.replace("{receipt_number}", deliveryImageReceiptNumber(raw) ?? "?");
  }
  return template;
}
