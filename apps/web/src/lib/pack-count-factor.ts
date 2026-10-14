/**
 * Pack size written in the trailing bracket of an invoice name:
 * "THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)" means 1 bao = 100 cái.
 *
 * The bracket is only trusted when its pack word matches the line unit and its
 * count word matches the stock unit, both compared accent- and case-insensitively
 * (đ = d). Every other trailing bracket ("BAO PE 13X23 (BAO 10 KG)" for a cái
 * item) is ignored.
 */

const PACK_BRACKET_RE = /\(\s*([^()\d]+?)\s+(\d+(?:[.,]\d+)?)\s+([^()\d]+?)\s*\)$/;

/** Accent/case-insensitive fold, with đ treated as d. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface PackBracket {
  /** Pack word as written, e.g. "Bao". */
  pack: string;
  /** Pack size, e.g. 100. */
  count: number;
  /** Count unit as written, e.g. "Cái". */
  unit: string;
}

/**
 * Read the last parenthesised group when it closes at the end of the
 * right-trimmed name and looks like "(<pack> <number> <unit>)".
 */
export function parsePackBracket(name: string | null | undefined): PackBracket | null {
  if (!name) return null;
  const match = name.replace(/\s+$/, "").match(PACK_BRACKET_RE);
  if (!match) return null;
  return {
    pack: match[1].trim(),
    count: Number(match[2].replace(",", ".")),
    unit: match[3].trim(),
  };
}

/**
 * A pack count from the trailing bracket, valid only when the pack word equals
 * the line unit and the count word equals the stock unit. Returns null when the
 * bracket is absent, mismatched, or not a positive finite number.
 */
export function packCountFactor(
  name: string | null | undefined,
  lineUnit: string | null | undefined,
  stockUnit: string,
): number | null {
  if (lineUnit == null) return null;
  const bracket = parsePackBracket(name);
  if (!bracket) return null;
  if (!Number.isFinite(bracket.count) || bracket.count <= 0) return null;
  if (fold(bracket.pack) !== fold(lineUnit)) return null;
  if (fold(bracket.unit) !== fold(stockUnit)) return null;
  return bracket.count;
}
