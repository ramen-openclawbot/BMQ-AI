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

// OCR delivery note matching utilities — client-side deterministic heuristics

export interface OcrLineCandidate {
  product_name: string;
  quantity: number;
  unit: string;
}

export interface OcrMatchResult {
  itemId: string;
  suggestedQuantity: number;
  confidence: "high" | "medium" | "low";
  matchedOcrName: string;
}

export function removeDiacriticsForMatch(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

export function stringSimilarity(s1: string, s2: string): number {
  const tokens1 = removeDiacriticsForMatch(s1).split(/\s+/).filter(Boolean);
  const tokens2 = removeDiacriticsForMatch(s2).split(/\s+/).filter(Boolean);
  if (tokens1.length === 0 && tokens2.length === 0) return 1;
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = tokens1.filter(t => set2.has(t));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

export function matchOcrLinesToPoLines(
  ocrLines: OcrLineCandidate[],
  poLines: Array<{ id: string; product_name: string; quantity: number }>,
): OcrMatchResult[] {
  const usedOcrIndices = new Set<number>();
  const results: OcrMatchResult[] = [];

  for (const poLine of poLines) {
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < ocrLines.length; i++) {
      if (usedOcrIndices.has(i)) continue;
      const score = stringSimilarity(poLine.product_name, ocrLines[i].product_name);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= 0.4) {
      usedOcrIndices.add(bestIdx);
      const matched = ocrLines[bestIdx];
      results.push({
        itemId: poLine.id,
        suggestedQuantity: matched.quantity,
        confidence: bestScore >= 0.8 ? "high" : bestScore >= 0.55 ? "medium" : "low",
        matchedOcrName: matched.product_name,
      });
    }
  }

  return results;
}
