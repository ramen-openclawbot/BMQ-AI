// Định lượng (gram) typed by hand in the COGS formula editor.
//
// Business rule: a comma is the decimal mark ("2,234" = 2.234 g); without a comma the number is
// whole grams and dots are thousands separators ("2.234" = 2234 g).
// A dot form that cannot be thousands grouping is a decimal typed on a phone keypad:
// "0.033" (leading zero) or "2.5" / "12.34" (last group is not exactly 3 digits).
// Reading "0.033" as 33 g would be wrong by a factor of 1000.

const DOT_GROUPING = /^[1-9]\d{0,2}(\.\d{3})+$/;
const DOT_DECIMAL = /^\d+\.\d+$/;

export const parseDosageGramInput = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;

  if (raw.includes(",")) {
    const n = Number(raw.replace(/\./g, "").replace(/,/g, "."));
    return Number.isFinite(n) ? n : fallback;
  }

  if (DOT_DECIMAL.test(raw) && !DOT_GROUPING.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(raw.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Text for the định lượng input. Keep what the person typed ("0", "0,", "0,03") while it still
 * means the stored quantity; otherwise show the stored quantity. The old code always printed the
 * parsed number, so "0" and a trailing "," were erased and no decimal could be typed.
 */
export const dosageInputText = (typed: unknown, quantity: number): string => {
  if (typeof typed === "string" && parseDosageGramInput(typed, NaN) === quantity) return typed;
  return quantity === 0 ? "" : String(quantity).replace(".", ",");
};
