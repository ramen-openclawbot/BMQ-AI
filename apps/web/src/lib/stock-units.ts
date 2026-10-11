/**
 * Standard stock units shared by the SQL layer and the web app.
 *
 * Mirrors supabase/migrations/20261022100000_shared_catalog_units.sql:
 * public.stock_units, public.stock_unit_aliases and public.normalize_stock_unit.
 * A composite unit (kg, l) collapses to its base (g, ml) so an item can only
 * ever be stored in one weight unit and one volume unit.
 */

export type StockUnitKind = "weight" | "volume" | "count";

export interface StockUnit {
  code: string;
  label: string;
  kind: StockUnitKind;
  baseCode: string;
  toBase: number;
}

/** Exactly the seeded public.stock_units rows. */
export const STOCK_UNITS: readonly StockUnit[] = [
  { code: "g", label: "g", kind: "weight", baseCode: "g", toBase: 1 },
  { code: "kg", label: "kg", kind: "weight", baseCode: "g", toBase: 1000 },
  { code: "ml", label: "ml", kind: "volume", baseCode: "ml", toBase: 1 },
  { code: "l", label: "l", kind: "volume", baseCode: "ml", toBase: 1000 },
  { code: "cái", label: "cái", kind: "count", baseCode: "cái", toBase: 1 },
  { code: "hộp", label: "hộp", kind: "count", baseCode: "hộp", toBase: 1 },
  { code: "cuộn", label: "cuộn", kind: "count", baseCode: "cuộn", toBase: 1 },
  { code: "chai", label: "chai", kind: "count", baseCode: "chai", toBase: 1 },
  { code: "bịch", label: "bịch", kind: "count", baseCode: "bịch", toBase: 1 },
  { code: "gói", label: "gói", kind: "count", baseCode: "gói", toBase: 1 },
  { code: "can", label: "can", kind: "count", baseCode: "can", toBase: 1 },
  { code: "bao", label: "bao", kind: "count", baseCode: "bao", toBase: 1 },
  { code: "quả", label: "quả", kind: "count", baseCode: "quả", toBase: 1 },
  { code: "tờ", label: "tờ", kind: "count", baseCode: "tờ", toBase: 1 },
  { code: "con", label: "con", kind: "count", baseCode: "con", toBase: 1 },
  { code: "cây", label: "cây", kind: "count", baseCode: "cây", toBase: 1 },
  { code: "thùng", label: "thùng", kind: "count", baseCode: "thùng", toBase: 1 },
  { code: "khối", label: "khối", kind: "count", baseCode: "khối", toBase: 1 },
  { code: "bình", label: "bình", kind: "count", baseCode: "bình", toBase: 1 },
  { code: "nắp", label: "nắp", kind: "count", baseCode: "nắp", toBase: 1 },
] as const;

/**
 * Exactly the seeded public.stock_unit_aliases rows. Ambiguous spellings
 * (pack, 'cối (pack)', định, đệnh, lần) are deliberately absent.
 */
export const STOCK_UNIT_ALIASES: Readonly<Record<string, string>> = {
  gr: "g",
  gram: "g",
  kí: "kg",
  ký: "kg",
  kgs: "kg",
  lit: "l",
  lít: "l",
  cuôn: "cuộn",
  cuốn: "cuộn",
  hôp: "hộp",
  từ: "tờ",
  cai: "cái",
  c: "cái",
  chiếc: "cái",
  bich: "bịch",
  goi: "gói",
  "can lớn": "can",
};

/** Shared case table: [input, normalized base code or null]. */
export const STOCK_UNIT_NORMALIZE_TEST_CASES: ReadonlyArray<
  readonly [string, string | null]
> = [
  ["g", "g"],
  ["Gr", "g"],
  ["gr", "g"],
  ["gram", "g"],
  ["Kg", "g"],
  ["KG", "g"],
  ["kí", "g"],
  ["ký", "g"],
  ["kgs", "g"],
  ["ml", "ml"],
  ["L", "ml"],
  ["l", "ml"],
  ["lít", "ml"],
  ["lit", "ml"],
  ["Hộp", "hộp"],
  ["hôp", "hộp"],
  ["Cuộn", "cuộn"],
  ["Cuôn", "cuộn"],
  ["cuốn", "cuộn"],
  ["Chai", "chai"],
  ["Bịch", "bịch"],
  ["bich", "bịch"],
  ["Gói", "gói"],
  ["goi", "gói"],
  ["cai", "cái"],
  ["Chiếc", "cái"],
  ["c", "cái"],
  ["Tờ", "tờ"],
  ["từ", "tờ"],
  ["Can", "can"],
  ["CAN", "can"],
  ["can lớn", "can"],
  ["Quả", "quả"],
  ["Con", "con"],
  ["Cây", "cây"],
  ["Thùng", "thùng"],
  ["Khối", "khối"],
  ["Bình", "bình"],
  ["Nắp", "nắp"],
  ["  Kg  ", "g"],
  ["PACK", null],
  ["CỐI (PACK)", null],
  ["CŨI (PACK)", null],
  ["định", null],
  ["đệnh", null],
  ["lần", null],
  ["", null],
  ["không rõ", null],
];

/** Resolve the alias / code / label spelling to a public.stock_units code. */
export function stockUnitCode(value: string | null | undefined): string | null {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "") return null;
  const alias = STOCK_UNIT_ALIASES[key];
  if (alias !== undefined) return alias;
  const unit = STOCK_UNITS.find(
    (candidate) => candidate.code.toLowerCase() === key || candidate.label.toLowerCase() === key,
  );
  return unit ? unit.code : null;
}

/** The standard base unit for a spelling, or null when it is unknown. */
export function normalizeStockUnit(value: string | null | undefined): string | null {
  const code = stockUnitCode(value);
  if (code === null) return null;
  const unit = STOCK_UNITS.find((candidate) => candidate.code === code);
  return unit ? unit.baseCode : null;
}

/**
 * The lowercase Vietnamese label stored on a document line, or null. The line
 * keeps its own unit (kg stays kg): its quantity and price are in that unit.
 */
export function stockUnitLabel(value: string | null | undefined): string | null {
  const code = stockUnitCode(value);
  if (code === null) return null;
  return STOCK_UNITS.find((candidate) => candidate.code === code)?.label ?? null;
}

/** The conversion from a spelling to the standard base unit, or null. */
export function stockUnitConversion(
  value: string | null | undefined,
): { newUnit: string; factor: number } | null {
  const code = stockUnitCode(value);
  if (code === null) return null;
  const unit = STOCK_UNITS.find((candidate) => candidate.code === code);
  if (!unit) return null;
  if ((value ?? "").trim() === unit.baseCode) return null;
  return { newUnit: unit.baseCode, factor: unit.baseCode === unit.code ? 1 : unit.toBase };
}
