/**
 * Pure helpers for the per-item unit / conversion dialog.
 *
 * Server contract (apps/web/supabase/migrations/20261102560000_kho_unit_conversions.sql):
 *   kho_get_units()                -> KhoUnit[]
 *   kho_add_stock_unit()           -> KhoAddUnitResult
 *   kho_get_item_conversions()     -> KhoItemConversions
 *   kho_set_item_conversion()      -> KhoConversionPreview | KhoSetConversionResult
 *
 * The conversion factor is always "stock units per 1 receipt unit", exactly what
 * post_stock_goods_receipt_item multiplies the receipt quantity by. The sentence
 * helpers show that relation in the natural direction (the bigger unit first)
 * and convert an edited sentence back to the factor.
 */

export type KhoUnitKind = "weight" | "volume" | "count";

export interface KhoUnit {
  code: string;
  label: string;
  kind: KhoUnitKind;
  base_code: string;
  to_base: number;
}

export interface KhoConversionGroup {
  unit: string;
  factors: number[];
  disagree: boolean;
  auto: boolean;
  alias_count: number;
  supplier_names: string[];
  line_count: number;
  posted_count: number;
  last_receipt_date: string | null;
}

export interface KhoSavedConversion {
  unit: string;
  factor: number;
  updated_at: string | null;
}

export interface KhoItemConversions {
  item: {
    id: string;
    name: string;
    unit: string;
    in_q7: boolean;
  };
  can_edit: boolean;
  cutover: {
    tan_tao: string | null;
    q7: string | null;
  };
  conversions: KhoConversionGroup[];
  saved: KhoSavedConversion[];
}

export type KhoConversionLocation = "tan_tao" | "q7";

export interface KhoConversionLine {
  receipt_number: string;
  receipt_date: string;
  location: KhoConversionLocation;
  posted_qty: number;
  new_qty: number;
  delta: number;
}

export interface KhoConversionTotalDelta {
  tan_tao: number;
  q7: number;
}

export interface KhoConversionPreview {
  status: "preview";
  aliases: number;
  lines: KhoConversionLine[];
  total_delta: KhoConversionTotalDelta;
}

export interface KhoSetConversionResult {
  status: "saved" | "saved_only";
  aliases_updated: number;
  lines: number;
  total_delta: KhoConversionTotalDelta;
}

export interface KhoAddUnitResult {
  status: "created" | "exists";
  unit: string;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function asUnitKind(value: unknown, path: string): KhoUnitKind {
  const kind = asString(value, path);
  if (kind !== "weight" && kind !== "volume" && kind !== "count") {
    throw new TypeError(`${path} is invalid`);
  }
  return kind;
}

function asLocation(value: unknown, path: string): KhoConversionLocation {
  const location = asString(value, path);
  if (location !== "tan_tao" && location !== "q7") {
    throw new TypeError(`${path} is invalid`);
  }
  return location;
}

function parseKhoUnit(raw: unknown, path: string): KhoUnit {
  const row = asRecord(raw, path);
  const toBase = asNumber(row.to_base, `${path}.to_base`);
  if (toBase <= 0) throw new TypeError(`${path}.to_base must be greater than 0`);
  return {
    code: asString(row.code, `${path}.code`),
    label: asString(row.label, `${path}.label`),
    kind: asUnitKind(row.kind, `${path}.kind`),
    base_code: asString(row.base_code, `${path}.base_code`),
    to_base: toBase,
  };
}

/** Parse the jsonb array returned by `kho_get_units`. */
export function parseKhoUnits(raw: unknown): KhoUnit[] {
  return asArray(raw, "khoUnits").map((unit, index) =>
    parseKhoUnit(unit, `khoUnits[${index}]`),
  );
}

function parseNumberArray(raw: unknown, path: string): number[] {
  return asArray(raw, path).map((value, index) => asNumber(value, `${path}[${index}]`));
}

function parseStringArray(raw: unknown, path: string): string[] {
  return asArray(raw, path).map((value, index) => asString(value, `${path}[${index}]`));
}

function parseConversionGroup(raw: unknown, path: string): KhoConversionGroup {
  const row = asRecord(raw, path);
  return {
    unit: asString(row.unit, `${path}.unit`),
    factors: parseNumberArray(row.factors, `${path}.factors`),
    disagree: asBoolean(row.disagree, `${path}.disagree`),
    auto: asBoolean(row.auto, `${path}.auto`),
    alias_count: asNumber(row.alias_count, `${path}.alias_count`),
    supplier_names: parseStringArray(row.supplier_names, `${path}.supplier_names`),
    line_count: asNumber(row.line_count, `${path}.line_count`),
    posted_count: asNumber(row.posted_count, `${path}.posted_count`),
    last_receipt_date: asNullableString(row.last_receipt_date, `${path}.last_receipt_date`),
  };
}

function parseSavedConversion(raw: unknown, path: string): KhoSavedConversion {
  const row = asRecord(raw, path);
  return {
    unit: asString(row.unit, `${path}.unit`),
    factor: asNumber(row.factor, `${path}.factor`),
    updated_at: asNullableString(row.updated_at, `${path}.updated_at`),
  };
}

/** Parse the jsonb object returned by `kho_get_item_conversions`. */
export function parseKhoItemConversions(raw: unknown): KhoItemConversions {
  const root = asRecord(raw, "khoItemConversions");
  const item = asRecord(root.item, "khoItemConversions.item");
  const cutover = asRecord(root.cutover, "khoItemConversions.cutover");
  return {
    item: {
      id: asString(item.id, "khoItemConversions.item.id"),
      name: asString(item.name, "khoItemConversions.item.name"),
      unit: asString(item.unit, "khoItemConversions.item.unit"),
      in_q7: asBoolean(item.in_q7, "khoItemConversions.item.in_q7"),
    },
    can_edit: asBoolean(root.can_edit, "khoItemConversions.can_edit"),
    cutover: {
      tan_tao: asNullableString(cutover.tan_tao, "khoItemConversions.cutover.tan_tao"),
      q7: asNullableString(cutover.q7, "khoItemConversions.cutover.q7"),
    },
    conversions: asArray(root.conversions, "khoItemConversions.conversions").map(
      (group, index) => parseConversionGroup(group, `khoItemConversions.conversions[${index}]`),
    ),
    saved: asArray(root.saved, "khoItemConversions.saved").map((row, index) =>
      parseSavedConversion(row, `khoItemConversions.saved[${index}]`),
    ),
  };
}

function parseConversionLine(raw: unknown, path: string): KhoConversionLine {
  const row = asRecord(raw, path);
  return {
    receipt_number: asString(row.receipt_number, `${path}.receipt_number`),
    receipt_date: asString(row.receipt_date, `${path}.receipt_date`),
    location: asLocation(row.location, `${path}.location`),
    posted_qty: asNumber(row.posted_qty, `${path}.posted_qty`),
    new_qty: asNumber(row.new_qty, `${path}.new_qty`),
    delta: asNumber(row.delta, `${path}.delta`),
  };
}

function parseTotalDelta(raw: unknown, path: string): KhoConversionTotalDelta {
  const row = asRecord(raw, path);
  return {
    tan_tao: asNumber(row.tan_tao, `${path}.tan_tao`),
    q7: asNumber(row.q7, `${path}.q7`),
  };
}

/** Parse the jsonb object returned by `kho_set_item_conversion` with p_dry_run. */
export function parseKhoConversionPreview(raw: unknown): KhoConversionPreview {
  const root = asRecord(raw, "khoConversionPreview");
  if (root.status !== "preview") {
    throw new TypeError("khoConversionPreview.status must be 'preview'");
  }
  return {
    status: "preview",
    aliases: asNumber(root.aliases, "khoConversionPreview.aliases"),
    lines: asArray(root.lines, "khoConversionPreview.lines").map((line, index) =>
      parseConversionLine(line, `khoConversionPreview.lines[${index}]`),
    ),
    total_delta: parseTotalDelta(root.total_delta, "khoConversionPreview.total_delta"),
  };
}

/** Parse the jsonb object returned by `kho_set_item_conversion` when saving. */
export function parseKhoSetConversionResult(raw: unknown): KhoSetConversionResult {
  const root = asRecord(raw, "khoSetConversionResult");
  if (root.status !== "saved" && root.status !== "saved_only") {
    throw new TypeError("khoSetConversionResult.status is invalid");
  }
  return {
    status: root.status,
    aliases_updated: asNumber(
      root.aliases_updated,
      "khoSetConversionResult.aliases_updated",
    ),
    lines: asNumber(root.lines, "khoSetConversionResult.lines"),
    total_delta: parseTotalDelta(root.total_delta, "khoSetConversionResult.total_delta"),
  };
}

/** Parse the jsonb object returned by `kho_add_stock_unit`. */
export function parseKhoAddUnitResult(raw: unknown): KhoAddUnitResult {
  const root = asRecord(raw, "khoAddUnitResult");
  if (root.status !== "created" && root.status !== "exists") {
    throw new TypeError("khoAddUnitResult.status is invalid");
  }
  return {
    status: root.status,
    unit: asString(root.unit, "khoAddUnitResult.unit"),
  };
}

/**
 * Show one conversion in the natural direction: the unit that needs a single
 * coefficient first, so a factor below 1 is inverted instead of printed as
 * "1 cuộn = 0.083 cây".
 *
 * factor is stock units per 1 receipt unit:
 *   ("cuộn", 0.083333, "cây") -> "1 cây = 12 cuộn"
 *   ("cây", 6, "cuộn")       -> "1 cây = 6 cuộn"
 */
export function conversionSentence(
  receiptUnit: string,
  factor: number,
  stockUnit: string,
): string {
  const receipt = receiptUnit.trim();
  const stock = stockUnit.trim();
  if (receipt === "") throw new TypeError("receiptUnit must not be empty");
  if (stock === "") throw new TypeError("stockUnit must not be empty");
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError("factor must be a finite number greater than 0");
  }

  const biggerFirst = factor >= 1;
  const leftUnit = biggerFirst ? receipt : stock;
  const rightUnit = biggerFirst ? stock : receipt;
  const rightQty = biggerFirst ? factor : 1 / factor;

  return `1 ${leftUnit} = ${formatQuantity(rightQty)} ${rightUnit}`;
}

/**
 * Convert an edited sentence ("leftQty leftUnit = rightQty rightUnit") back to
 * stock units per 1 receipt unit. One side must be the item's stock unit.
 */
export function factorFromSentence(
  leftUnit: string,
  leftQty: number,
  rightUnit: string,
  rightQty: number,
  stockUnit: string,
): number {
  const left = leftUnit.trim().toLowerCase();
  const right = rightUnit.trim().toLowerCase();
  const stock = stockUnit.trim().toLowerCase();
  if (left === "") throw new TypeError("leftUnit must not be empty");
  if (right === "") throw new TypeError("rightUnit must not be empty");
  if (stock === "") throw new TypeError("stockUnit must not be empty");
  assertPositiveQuantity(leftQty, "leftQty");
  assertPositiveQuantity(rightQty, "rightQty");

  let factor: number;
  if (left === stock) {
    factor = leftQty / rightQty;
  } else if (right === stock) {
    factor = rightQty / leftQty;
  } else {
    throw new TypeError("one side of the sentence must be the stock unit");
  }

  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError("factor must be a finite number greater than 0");
  }
  return factor;
}

function assertPositiveQuantity(value: number, path: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${path} must be a finite number greater than 0`);
  }
}

/** At most 3 decimals; snap a value within 0.0005 of an integer to that integer. */
function formatQuantity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("quantity must be a finite number greater than 0");
  }
  const nearest = Math.round(value);
  const rounded = Math.abs(value - nearest) < 0.0005
    ? nearest
    : Math.round(value * 1000) / 1000;
  return rounded.toFixed(3).replace(/\.?0+$/, "");
}
