// Pure helpers for the "Trình chi gấp" flow (phần máy chủ). No Supabase / React
// imports so the pagination math, the Vietnam-day cutoff and the Zalo message
// preview stay unit-testable and mirror the SQL RPC / shared edge formatter.

export const DEFAULT_PAYMENT_SUBMISSION_PAGE_SIZE = 10;
export const MAX_PAYMENT_SUBMISSION_PAGE_SIZE = 50;
export const PAYMENT_SUBMISSION_MAX_LINES = 5;

export interface PaymentSubmissionPageRange {
  page: number;
  pageSize: number;
  from: number;
  to: number;
}

/** Keep a server-side page size within sane bounds (default 10, max 50). */
export function clampPaymentSubmissionPageSize(pageSize: number): number {
  const parsed = Number(pageSize);
  if (!Number.isFinite(parsed)) return DEFAULT_PAYMENT_SUBMISSION_PAGE_SIZE;
  return Math.min(
    MAX_PAYMENT_SUBMISSION_PAGE_SIZE,
    Math.max(1, Math.trunc(parsed)),
  );
}

/** Convert a 1-based page/limit pair into the Supabase `.range(from, to)` pair. */
export function paymentSubmissionPageToRange(
  page: number,
  pageSize: number = DEFAULT_PAYMENT_SUBMISSION_PAGE_SIZE,
): PaymentSubmissionPageRange {
  const safePageSize = clampPaymentSubmissionPageSize(pageSize);
  const parsedPage = Number(page);
  const safePage = Number.isFinite(parsedPage) ? Math.max(1, Math.trunc(parsedPage)) : 1;
  const from = (safePage - 1) * safePageSize;
  return { page: safePage, pageSize: safePageSize, from, to: from + safePageSize - 1 };
}

/** Total pages for an exact count (always at least one page). */
export function paymentSubmissionTotalPages(
  totalCount: number,
  pageSize: number = DEFAULT_PAYMENT_SUBMISSION_PAGE_SIZE,
): number {
  const safePageSize = clampPaymentSubmissionPageSize(pageSize);
  const total = Number(totalCount);
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / safePageSize));
}

/**
 * Start of the Vietnam calendar day `days` days before `now`, as an ISO string
 * with the fixed +07:00 offset. Vietnam has no DST, so shifting the UTC epoch by
 * seven hours makes the calendar date exact regardless of the host timezone.
 */
export function vietnamDateCutoff(days: number, now: Date = new Date()): string {
  const parsedDays = Number(days);
  const safeDays = Number.isFinite(parsedDays) ? Math.max(0, Math.trunc(parsedDays)) : 0;
  const vietnamShifted = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  vietnamShifted.setUTCDate(vietnamShifted.getUTCDate() - safeDays);
  const datePart = vietnamShifted.toISOString().slice(0, 10);
  return `${datePart}T00:00:00+07:00`;
}

const formatVnd = (amount: number | null | undefined): string => {
  if (amount === null || amount === undefined) return "Chưa xác định";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "Chưa xác định";
  return `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
};

const safeText = (value: string | null | undefined, fallback: string): string =>
  value && value.trim() ? value.trim() : fallback;

export interface PaymentSubmissionPreviewItem {
  supplierName?: string | null;
  requestNumber: string;
  remainingAmount?: number | null;
}

export interface PaymentSubmissionPreviewInput {
  submissionNumber?: string | null;
  note?: string | null;
  totalAmount?: number | null;
  items: PaymentSubmissionPreviewItem[];
}

/**
 * Preview of the finance Zalo "Trình chi gấp" message built from the selected
 * requests. Mirrors public.create_payment_submission and the shared
 * formatPaymentSubmissionMessage (header, total, up to five request lines, an
 * overflow line and the optional note).
 */
export function formatPaymentSubmissionPreview(input: PaymentSubmissionPreviewInput): string {
  const items = Array.isArray(input.items) ? input.items : [];
  const count = items.length;
  const lines = [
    `📋 TRÌNH CHI GẤP ${safeText(input.submissionNumber, "Chưa có mã")}`,
    `${count} phiếu · Tổng ${formatVnd(input.totalAmount)}`,
  ];
  for (const item of items.slice(0, PAYMENT_SUBMISSION_MAX_LINES)) {
    lines.push(
      `• ${safeText(item.supplierName, "Chưa xác định")} – ${safeText(item.requestNumber, "Chưa có mã")}: ${formatVnd(item.remainingAmount)}`,
    );
  }
  if (count > PAYMENT_SUBMISSION_MAX_LINES) {
    lines.push(`… và ${count - PAYMENT_SUBMISSION_MAX_LINES} phiếu khác`);
  }
  if (input.note?.trim()) lines.push(input.note.trim());
  return lines.join("\n");
}
