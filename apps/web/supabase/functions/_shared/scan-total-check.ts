/**
 * Deterministic total check for scanned purchase orders.
 *
 * The vision model extracts line items plus the printed totals, but it can
 * misread a quantity/price or glue the numbers of the next product onto the
 * previous line. This pure helper re-computes every line and the document
 * subtotal so the UI can warn the operator instead of trusting the OCR blindly.
 *
 * It never throws on partial data: missing line totals fall back to
 * quantity * unit_price, and the document check is skipped when the scan
 * carries no subtotal/total at all.
 */

export type ScanWarningKind = "line_mismatch" | "subtotal_mismatch";

export interface ScanWarning {
  kind: ScanWarningKind;
  message: string;
  line_index?: number;
  expected?: number;
  actual?: number;
  difference?: number;
}

export interface ScanTotalCheckResult {
  subtotal_amount: number | null;
  warnings: ScanWarning[];
}

/** A line is allowed to be off by 1.000 VND or 0,5% of its printed total. */
const LINE_TOLERANCE_FLOOR = 1_000;
const LINE_TOLERANCE_RATE = 0.005;

/** The document subtotal is only allowed to be off by rounding noise. */
const DOCUMENT_TOLERANCE = 1_000;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 7355000 -> "7.355.000" (Vietnamese thousands separator). */
const formatVnd = (value: number): string =>
  Math.round(Math.abs(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Check the extracted PO totals and return the resolved pre-VAT subtotal plus
 * any warnings. The input is not mutated.
 *
 * - Each line: quantity * unit_price vs the printed line_total, tolerance
 *   max(1.000 VND, 0,5% of line_total). When line_total is missing the computed
 *   value is used for the document sum and the line is not flagged.
 * - Document: sum of line totals vs the printed subtotal, or vs
 *   total_amount - vat_amount when subtotal_amount is missing, tolerance
 *   1.000 VND.
 */
export const checkScanTotals = (data: unknown): ScanTotalCheckResult => {
  const record = asRecord(data) ?? {};
  const items = Array.isArray(record.items) ? record.items : [];

  const warnings: ScanWarning[] = [];
  let lineTotalSum = 0;

  items.forEach((item, index) => {
    const line = asRecord(item);
    if (line === null) return;

    const quantity = asNumber(line.quantity);
    const unitPrice = asNumber(line.unit_price);
    const printedLineTotal = asNumber(line.line_total);

    let effectiveLineTotal: number | null = printedLineTotal;
    let computedLineTotal: number | null = null;

    if (quantity !== null && unitPrice !== null) {
      computedLineTotal = quantity * unitPrice;
      if (printedLineTotal === null) effectiveLineTotal = computedLineTotal;
    }

    if (effectiveLineTotal !== null) lineTotalSum += effectiveLineTotal;

    if (printedLineTotal === null || computedLineTotal === null) return;

    const difference = Math.abs(computedLineTotal - printedLineTotal);
    const tolerance = Math.max(
      LINE_TOLERANCE_FLOOR,
      Math.abs(printedLineTotal) * LINE_TOLERANCE_RATE,
    );
    if (difference <= tolerance) return;

    const productName =
      typeof line.product_name === "string" ? line.product_name.trim() : "";
    const label = productName ? ` (${productName})` : "";

    warnings.push({
      kind: "line_mismatch",
      message:
        `Dòng ${index + 1}${label}: ${formatVnd(quantity!)} × ${formatVnd(unitPrice!)} = ` +
        `${formatVnd(computedLineTotal)} ≠ Thành tiền ${formatVnd(printedLineTotal)} ` +
        `(lệch ${formatVnd(difference)}) — kiểm tra lại số lượng/đơn giá`,
      line_index: index,
      expected: computedLineTotal,
      actual: printedLineTotal,
      difference,
    });
  });

  const printedSubtotal = asNumber(record.subtotal_amount);
  const totalAmount = asNumber(record.total_amount);
  const vatAmount = asNumber(record.vat_amount) ?? 0;

  const subtotalAmount =
    printedSubtotal ?? (totalAmount !== null ? totalAmount - vatAmount : null);

  if (subtotalAmount !== null) {
    const difference = Math.abs(lineTotalSum - subtotalAmount);
    if (difference > DOCUMENT_TOLERANCE) {
      warnings.push({
        kind: "subtotal_mismatch",
        message:
          `Tổng các dòng ${formatVnd(lineTotalSum)} ≠ Tổng tiền hàng ` +
          `${formatVnd(subtotalAmount)} trên chứng từ (lệch ${formatVnd(difference)}) — ` +
          `kiểm tra dòng thừa/thiếu hoặc tờ khác lẫn trong ảnh`,
        expected: lineTotalSum,
        actual: subtotalAmount,
        difference,
      });
    }
  }

  return { subtotal_amount: subtotalAmount, warnings };
};
