export type ReceiptLineStatus = "du" | "thieu" | "du_thua";

export interface PlannedLine {
  id?: string;
  product_name: string;
  quantity: number;
  unit?: string | null;
  unit_price?: number | null;
  sku_id?: string | null;
}

export interface ActualLine extends PlannedLine {
  actual_quantity: number;
  variance_reason?: string | null;
}

export function classifyReceiptLine(plannedQty: number, actualQty: number): ReceiptLineStatus {
  const planned = Number(plannedQty || 0);
  const actual = Number(actualQty || 0);

  if (actual < planned) return "thieu";
  if (actual > planned) return "du_thua";
  return "du";
}

export function payableLineTotal(actualQty: number, unitPrice?: number | null): number {
  return Math.max(0, Number(actualQty || 0)) * Math.max(0, Number(unitPrice || 0));
}

export function buildReceiptVarianceSummary(lines: ActualLine[]) {
  return lines.reduce(
    (summary, line) => {
      const status = classifyReceiptLine(line.quantity, line.actual_quantity);
      summary[status] += 1;
      summary.total_actual_quantity += Math.max(0, Number(line.actual_quantity || 0));
      summary.total_payable_amount += payableLineTotal(line.actual_quantity, line.unit_price);
      return summary;
    },
    {
      du: 0,
      thieu: 0,
      du_thua: 0,
      total_actual_quantity: 0,
      total_payable_amount: 0,
    }
  );
}
