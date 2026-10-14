/**
 * Pure invoice-line matching for suggest-stock-item-name.
 *
 * The vision model transcribes every printed line of a goods-receipt image; this
 * module decides which transcribed line is the one behind a receipt line. No I/O,
 * so the rule is unit-tested with real Mega Market invoice data (match.test.ts).
 *
 * Score (max 7):
 *   + 3  unit price matches: |line - target| <= 1% of the target unit price
 *   + 2  quantity matches:   |line - target| <= 0.01
 *   + 0..2  share of the short target name's words present in the line name
 *
 * A candidate is only eligible when every word of the short target name (words
 * longer than one character) appears in the line name, OR when both unit price
 * and quantity match. The final score must reach MIN_LINE_SCORE. If two or more
 * eligible lines tie at the top score the answer is null: the machine must not
 * guess between equally plausible lines.
 */

export interface InvoiceLine {
  product_name: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
}

export interface InvoiceTargetLine {
  name: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
}

export interface ScoredInvoiceLine {
  line: InvoiceLine;
  score: number;
}

export interface SuggestionName {
  full_name: string;
  unit: string | null;
}

export const MIN_LINE_SCORE = 3;
export const MAX_LINE_SCORE = 7;

const PRICE_TOLERANCE = 0.01;
const QUANTITY_TOLERANCE = 0.01;
const EPSILON = 1e-9;

function removeDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** Words of a name after diacritic removal; one-character words are ignored. */
function nameWords(value: string): string[] {
  return removeDiacritics(value)
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function priceMatches(target: InvoiceTargetLine, line: InvoiceLine): boolean {
  if (!isFiniteNumber(target.unit_price) || !isFiniteNumber(line.unit_price)) return false;
  const tolerance = Math.abs(target.unit_price) * PRICE_TOLERANCE;
  return Math.abs(line.unit_price - target.unit_price) <= tolerance + EPSILON;
}

function quantityMatches(target: InvoiceTargetLine, line: InvoiceLine): boolean {
  if (!isFiniteNumber(target.quantity) || !isFiniteNumber(line.quantity)) return false;
  return Math.abs(line.quantity - target.quantity) <= QUANTITY_TOLERANCE + EPSILON;
}

/** Score one candidate, or null when it is not eligible. */
function scoreLine(target: InvoiceTargetLine, line: InvoiceLine): number | null {
  const words = nameWords(target.name);
  const lineName = removeDiacritics(line.product_name);
  const present = words.filter((word) => lineName.includes(word));
  const allWordsPresent = words.length === 0 || present.length === words.length;
  const nameRatio = words.length === 0 ? 0 : present.length / words.length;

  const price = priceMatches(target, line);
  const quantity = quantityMatches(target, line);
  if (!allWordsPresent && !(price && quantity)) return null;

  const score = (price ? 3 : 0) + (quantity ? 2 : 0) + nameRatio * 2;
  return score >= MIN_LINE_SCORE ? score : null;
}

/**
 * Pick the best matching invoice line for the receipt line, or null when nothing
 * is eligible enough or the top score is tied.
 */
export function pickInvoiceLine(
  target: InvoiceTargetLine,
  lines: ReadonlyArray<InvoiceLine>,
): ScoredInvoiceLine | null {
  const scored: ScoredInvoiceLine[] = [];
  for (const line of lines) {
    if (!line || typeof line.product_name !== "string" || line.product_name.trim() === "") continue;
    const score = scoreLine(target, line);
    if (score !== null) scored.push({ line, score });
  }
  if (scored.length === 0) return null;

  let best = scored[0];
  for (const candidate of scored) {
    if (candidate.score > best.score) best = candidate;
  }
  const top = scored.filter((candidate) => Math.abs(candidate.score - best.score) <= EPSILON);
  return top.length === 1 ? best : null;
}

/** Trim and collapse whitespace in the chosen line's printed name; keep its unit. */
export function buildSuggestion(line: Pick<InvoiceLine, "product_name" | "unit">): SuggestionName {
  const fullName = String(line.product_name ?? "").trim().replace(/\s+/g, " ");
  const unit = String(line.unit ?? "").trim();
  return { full_name: fullName, unit: unit === "" ? null : unit };
}
