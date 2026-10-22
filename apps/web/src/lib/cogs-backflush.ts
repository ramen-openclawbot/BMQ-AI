/**
 * Pure data layer for the revenue-COGS backflush screen.
 *
 * Server contract:
 *   cogs_backflush_overview(date, date) -> CogsOverview
 *   cogs_item_usage_trace(text, uuid, date, date) -> CogsTrace
 *
 * Both readers are SECURITY DEFINER RPCs. The parser is deliberately tolerant
 * of missing keys so a freshly deployed database (or an older run with no
 * trace yet) renders zeroes/empty lists instead of breaking the page.
 */

export type CogsLocation = "q7" | "tan_tao";

export interface CogsSetting {
  location: CogsLocation;
  enabled: boolean;
  start_date: string | null;
  cutover_date: string | null;
  updated_at: string | null;
}

export interface CogsRun {
  id: string;
  started_at: string | null;
  finished_at: string | null;
  window_from: string | null;
  window_to: string | null;
  dry_run: boolean;
  posted_rows: number;
  summary: Record<string, unknown>;
  error: string | null;
}

export interface CogsCoverage {
  channel: string;
  lines: number;
  qty: number;
  value: number;
  mapped_lines: number;
  mapped_qty: number;
  mapped_value: number;
  mapped_pct: number;
  mapped_value_pct: number;
}

export interface CogsItemUsage {
  item_id: string;
  name: string;
  unit: string;
  location: CogsLocation;
  recipe_qty: number;
  pxk_usage: number;
  posted_cogs: number;
}

export interface CogsGapProduct {
  map_id: string | null;
  channel: string;
  product_code: string;
  name: string;
  lines: number;
  qty: number;
  value: number;
  candidates: unknown[];
}

export interface CogsGapIngredient {
  canonical_material_id: string | null;
  material_name: string;
  recipe_unit: string;
  reason: string;
  sku_codes: string[];
  candidates: unknown[];
}

export interface CogsGapRecipe {
  sku_code: string;
  name: string;
  reason: string;
  lines: number;
}

export interface CogsGaps {
  products: CogsGapProduct[];
  ingredients: CogsGapIngredient[];
  recipes: CogsGapRecipe[];
}

export interface CogsSkuOption {
  sku_id: string;
  sku_code: string;
  name: string;
  unit: string;
}

export interface CogsOverview {
  as_of: string | null;
  from: string | null;
  to: string | null;
  settings: CogsSetting[];
  last_run: CogsRun | null;
  coverage: CogsCoverage[];
  items: CogsItemUsage[];
  gaps: CogsGaps;
  /** Server gate of the decision RPCs (owner or kho admin). */
  can_decide: boolean;
  /** Server gate of cogs_set_backflush (owner). */
  can_switch: boolean;
  /** Finished-good SKUs for the product picker. */
  sku_options: CogsSkuOption[];
}

export interface CogsTraceLine {
  revenue_date: string | null;
  sku_id: string | null;
  sku_code: string;
  sku_name: string;
  revenue_line_id: string;
  channel: string;
  ref: string;
  customer: string;
  revenue_qty: number;
  version_id: string | null;
  version_no: number | null;
  version_no_text: string;
  recipe_unit: string;
  recipe_qty: number;
  stock_qty: number;
  status: string;
}

export interface CogsTrace {
  location: CogsLocation;
  item_id: string;
  from: string | null;
  to: string | null;
  rows: CogsTraceLine[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asLocation(value: unknown): CogsLocation {
  return value === "tan_tao" ? "tan_tao" : "q7";
}

function parseSetting(raw: unknown): CogsSetting {
  const row = asRecord(raw);
  return {
    location: asLocation(row.location),
    enabled: asBoolean(row.enabled),
    start_date: asNullableString(row.start_date),
    cutover_date: asNullableString(row.cutover_date),
    updated_at: asNullableString(row.updated_at),
  };
}

function parseRun(raw: unknown): CogsRun | null {
  if (raw === null || raw === undefined) return null;
  const row = asRecord(raw);
  if (Object.keys(row).length === 0) return null;
  return {
    id: asString(row.id),
    started_at: asNullableString(row.started_at),
    finished_at: asNullableString(row.finished_at),
    window_from: asNullableString(row.window_from),
    window_to: asNullableString(row.window_to),
    dry_run: asBoolean(row.dry_run, true),
    posted_rows: asNumber(row.posted_rows),
    summary: asRecord(row.summary),
    error: asNullableString(row.error),
  };
}

function parseCoverage(raw: unknown): CogsCoverage {
  const row = asRecord(raw);
  return {
    channel: asString(row.channel),
    lines: asNumber(row.lines),
    qty: asNumber(row.qty),
    value: asNumber(row.value),
    mapped_lines: asNumber(row.mapped_lines),
    mapped_qty: asNumber(row.mapped_qty),
    mapped_value: asNumber(row.mapped_value),
    mapped_pct: asNumber(row.mapped_pct),
    mapped_value_pct: asNumber(row.mapped_value_pct),
  };
}

function parseItem(raw: unknown): CogsItemUsage {
  const row = asRecord(raw);
  return {
    item_id: asString(row.item_id),
    name: asString(row.name),
    unit: asString(row.unit),
    location: asLocation(row.location),
    recipe_qty: asNumber(row.recipe_qty),
    pxk_usage: asNumber(row.pxk_usage),
    posted_cogs: asNumber(row.posted_cogs),
  };
}

function parseGapProduct(raw: unknown): CogsGapProduct {
  const row = asRecord(raw);
  return {
    map_id: asNullableString(row.map_id),
    channel: asString(row.channel),
    product_code: asString(row.product_code),
    name: asString(row.name),
    lines: asNumber(row.lines),
    qty: asNumber(row.qty),
    value: asNumber(row.value),
    candidates: asArray(row.candidates),
  };
}

function parseGapIngredient(raw: unknown): CogsGapIngredient {
  const row = asRecord(raw);
  return {
    canonical_material_id: asNullableString(row.canonical_material_id),
    material_name: asString(row.material_name),
    recipe_unit: asString(row.recipe_unit),
    reason: asString(row.reason),
    sku_codes: asArray(row.sku_codes).map((code) => asString(code)).filter(Boolean),
    candidates: asArray(row.candidates),
  };
}

function parseSkuOption(raw: unknown): CogsSkuOption {
  const row = asRecord(raw);
  return {
    sku_id: asString(row.sku_id),
    sku_code: asString(row.sku_code),
    name: asString(row.name),
    unit: asString(row.unit),
  };
}

function parseGapRecipe(raw: unknown): CogsGapRecipe {
  const row = asRecord(raw);
  return {
    sku_code: asString(row.sku_code),
    name: asString(row.name),
    reason: asString(row.reason),
    lines: asNumber(row.lines),
  };
}

/** Parse the jsonb object returned by `cogs_backflush_overview`. */
export function parseCogsOverview(raw: unknown): CogsOverview {
  const root = asRecord(raw);
  const gaps = asRecord(root.gaps);
  return {
    as_of: asNullableString(root.as_of),
    from: asNullableString(root.from),
    to: asNullableString(root.to),
    settings: asArray(root.settings).map(parseSetting),
    last_run: parseRun(root.last_run),
    coverage: asArray(root.coverage).map(parseCoverage),
    items: asArray(root.items).map(parseItem),
    gaps: {
      products: asArray(gaps.products).map(parseGapProduct),
      ingredients: asArray(gaps.ingredients).map(parseGapIngredient),
      recipes: asArray(gaps.recipes).map(parseGapRecipe),
    },
    can_decide: asBoolean(root.can_decide),
    can_switch: asBoolean(root.can_switch),
    sku_options: asArray(root.sku_options).map(parseSkuOption).filter((option) => option.sku_id !== ""),
  };
}

function parseTraceLine(raw: unknown): CogsTraceLine {
  const row = asRecord(raw);
  return {
    revenue_date: asNullableString(row.revenue_date),
    sku_id: asNullableString(row.sku_id),
    sku_code: asString(row.sku_code),
    sku_name: asString(row.sku_name),
    revenue_line_id: asString(row.revenue_line_id),
    channel: asString(row.channel),
    ref: asString(row.ref),
    customer: asString(row.customer),
    revenue_qty: asNumber(row.revenue_qty),
    version_id: asNullableString(row.version_id),
    version_no: typeof row.version_no === "number" ? row.version_no : null,
    version_no_text: asString(row.version_no_text),
    recipe_unit: asString(row.recipe_unit),
    recipe_qty: asNumber(row.recipe_qty),
    stock_qty: asNumber(row.stock_qty),
    status: asString(row.status),
  };
}

/** Parse the jsonb object returned by `cogs_item_usage_trace`. */
export function parseCogsTrace(raw: unknown): CogsTrace {
  const root = asRecord(raw);
  return {
    location: asLocation(root.location),
    item_id: asString(root.item_id),
    from: asNullableString(root.from),
    to: asNullableString(root.to),
    rows: asArray(root.rows).map(parseTraceLine),
  };
}

/** Mapped share of revenue value, 0..100. Missing/zero value -> 0. */
export function coveragePct(source: CogsCoverage[] | Pick<CogsOverview, "coverage">): number {
  const rows = Array.isArray(source) ? source : source.coverage;
  const total = rows.reduce((sum, row) => sum + (row.value || 0), 0);
  const mapped = rows.reduce((sum, row) => sum + (row.mapped_value || 0), 0);
  if (total <= 0) return 0;
  return (mapped / total) * 100;
}

/** Number of reported product + ingredient + recipe gaps. */
export function gapCount(source: CogsGaps | Pick<CogsOverview, "gaps">): number {
  const gaps = "products" in source ? source : source.gaps;
  return (
    (gaps.products?.length ?? 0) +
    (gaps.ingredients?.length ?? 0) +
    (gaps.recipes?.length ?? 0)
  );
}

/** Why an ingredient is not deducted yet, in words the kho team uses. */
export function ingredientReasonText(gap: Pick<CogsGapIngredient, "reason" | "recipe_unit" | "candidates">): string {
  const first = asRecord(gap.candidates[0]);
  const itemUnit = asString(first.unit);
  switch (gap.reason) {
    case "unit":
      return itemUnit
        ? `Công thức tính bằng ${gap.recipe_unit}, món kho tính bằng ${itemUnit}: chưa có quy đổi.`
        : `Công thức tính bằng ${gap.recipe_unit}: chưa đổi được ra đơn vị kho.`;
    case "never_stocked":
      return "Món kho nối với nguyên liệu này chưa từng có nhập hay xuất.";
    case "several_items":
      return "Có nhiều món kho cùng nối với nguyên liệu này: chọn 1 món.";
    case "no_item":
      return "Chưa có món kho nào nối với nguyên liệu này.";
    case "material":
      return "Dòng công thức chưa nối mã nguyên liệu chuẩn: sửa trong Giá vốn.";
    case "sub_recipe_unit":
      return "Công thức con khác đơn vị với dòng gọi nó: sửa trong Giá vốn.";
    default:
      return "Chưa nối với món kho.";
  }
}

/**
 * How far the recipe figure is from what the material issues (PXK) took, as a
 * whole percent of the PXK figure; null when there is no PXK figure to compare.
 */
export function recipeVsIssuePct(item: Pick<CogsItemUsage, "recipe_qty" | "pxk_usage">): number | null {
  if (!(item.pxk_usage > 0)) return null;
  return Math.round(((item.recipe_qty - item.pxk_usage) / item.pxk_usage) * 100);
}
