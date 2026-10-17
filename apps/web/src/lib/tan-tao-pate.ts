/**
 * Pure data layer for the Tân Tạo pate recipe / production game (2026-11-01).
 *
 * The parsers validate the jsonb returned by
 *   public.get_tan_tao_recipe(text),
 *   public.answer_tan_tao_recipe_line(...),
 *   public.set_tan_tao_recipe_batch(text, numeric, uuid) and
 *   public.record_tan_tao_pate_production(date, numeric, jsonb, text, uuid).
 *
 * The server is authoritative: a broken RPC response raises instead of being
 * rendered as a fake success.
 */

export type TanTaoPateLineKind = "ingredient" | "pack";
export type TanTaoPateLineStatus = "open" | "answered" | "not_used";
export type TanTaoPateRecipeStatus = "draft" | "complete";

export interface TanTaoPateLine {
  id: string;
  line_kind: TanTaoPateLineKind;
  sort_order: number;
  label: string;
  kitchen_inventory_item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  item_unit: string | null;
  sku_code: string | null;
  grams_per_batch: number | null;
  pate_grams_per_pack: number | null;
  pack_item_id: string | null;
  pack_item_code: string | null;
  pack_item_name: string | null;
  pack_item_unit: string | null;
  label_item_id: string | null;
  label_item_code: string | null;
  label_item_name: string | null;
  label_item_unit: string | null;
  status: TanTaoPateLineStatus;
  answered_by: string | null;
  answered_at: string | null;
}

export interface TanTaoPateRecipe {
  id: string;
  code: string;
  name: string;
  batch_output_kg: number | null;
  batch_set: boolean;
  status: TanTaoPateRecipeStatus;
  updated_by: string | null;
  updated_at: string | null;
  line_count: number;
  open_count: number;
  answered_count: number;
  not_used_count: number;
  lines: TanTaoPateLine[];
  can_answer: boolean;
}

export interface TanTaoPatePackInput {
  sku_code: string;
  quantity: number;
}

export interface TanTaoPateIngredientUsage {
  itemId: string;
  itemName: string | null;
  itemUnit: string | null;
  grams: number;
  lineIds: string[];
}

export interface TanTaoPatePackUsage {
  lineId: string;
  label: string;
  skuCode: string;
  quantity: number;
  pateGrams: number;
  packItemId: string | null;
  labelItemId: string | null;
}

export interface TanTaoPateRecipeProgress {
  total: number;
  answered: number;
  open: number;
  notUsed: number;
  batchSet: boolean;
  left: number;
  complete: boolean;
  pct: number;
}

export interface TanTaoPateProductionIngredient {
  line_id: string;
  item_id: string;
  item_name: string;
  unit: string;
  grams: number;
  quantity: number;
}

export interface TanTaoPateProductionPackaging {
  line_id: string;
  kind: string;
  item_id: string;
  item_name: string;
  unit: string;
  packs: number;
  quantity: number;
}

export interface TanTaoPateProductionDocument {
  sku_code: string;
  quantity: number;
  result: Record<string, unknown>;
}

export interface TanTaoPateProductionResult {
  status: string;
  slip_id: string;
  recipe_code: string;
  production_date: string;
  batches: number;
  packs: TanTaoPatePackInput[];
  ingredients: TanTaoPateProductionIngredient[];
  packaging: TanTaoPateProductionPackaging[];
  documents: TanTaoPateProductionDocument[];
  movement_count: number;
  replay: boolean;
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

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function parseLineKind(value: unknown, path: string): TanTaoPateLineKind {
  if (value === "ingredient" || value === "pack") return value;
  throw new TypeError(`${path} must be one of ingredient, pack`);
}

function parseLineStatus(value: unknown, path: string): TanTaoPateLineStatus {
  if (value === "open" || value === "answered" || value === "not_used") return value;
  throw new TypeError(`${path} must be one of open, answered, not_used`);
}

function parseRecipeStatus(value: unknown, path: string): TanTaoPateRecipeStatus {
  if (value === "draft" || value === "complete") return value;
  throw new TypeError(`${path} must be one of draft, complete`);
}

export function parseTanTaoPateLine(raw: unknown, path = "line"): TanTaoPateLine {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    line_kind: parseLineKind(row.line_kind, `${path}.line_kind`),
    sort_order: asNumber(row.sort_order ?? 0, `${path}.sort_order`),
    label: asString(row.label, `${path}.label`),
    kitchen_inventory_item_id: asNullableString(
      row.kitchen_inventory_item_id,
      `${path}.kitchen_inventory_item_id`,
    ),
    item_code: asNullableString(row.item_code, `${path}.item_code`),
    item_name: asNullableString(row.item_name, `${path}.item_name`),
    item_unit: asNullableString(row.item_unit, `${path}.item_unit`),
    sku_code: asNullableString(row.sku_code, `${path}.sku_code`),
    grams_per_batch: asNullableNumber(row.grams_per_batch, `${path}.grams_per_batch`),
    pate_grams_per_pack: asNullableNumber(
      row.pate_grams_per_pack,
      `${path}.pate_grams_per_pack`,
    ),
    pack_item_id: asNullableString(row.pack_item_id, `${path}.pack_item_id`),
    pack_item_code: asNullableString(row.pack_item_code, `${path}.pack_item_code`),
    pack_item_name: asNullableString(row.pack_item_name, `${path}.pack_item_name`),
    pack_item_unit: asNullableString(row.pack_item_unit, `${path}.pack_item_unit`),
    label_item_id: asNullableString(row.label_item_id, `${path}.label_item_id`),
    label_item_code: asNullableString(row.label_item_code, `${path}.label_item_code`),
    label_item_name: asNullableString(row.label_item_name, `${path}.label_item_name`),
    label_item_unit: asNullableString(row.label_item_unit, `${path}.label_item_unit`),
    status: parseLineStatus(row.status, `${path}.status`),
    answered_by: asNullableString(row.answered_by, `${path}.answered_by`),
    answered_at: asNullableString(row.answered_at, `${path}.answered_at`),
  };
}

export function parseTanTaoPateRecipe(raw: unknown, path = "tanTaoPateRecipe"): TanTaoPateRecipe {
  const row = asRecord(raw, path);
  const lines = Array.isArray(row.lines)
    ? row.lines.map((line, index) => parseTanTaoPateLine(line, `${path}.lines[${index}]`))
    : [];
  const batchOutput = asNullableNumber(row.batch_output_kg, `${path}.batch_output_kg`);
  const batchSet =
    row.batch_set === null || row.batch_set === undefined
      ? (batchOutput ?? 0) > 0
      : asBoolean(row.batch_set, `${path}.batch_set`);

  return {
    id: asString(row.id, `${path}.id`),
    code: asString(row.code, `${path}.code`),
    name: asString(row.name, `${path}.name`),
    batch_output_kg: batchOutput,
    batch_set: batchSet,
    status: parseRecipeStatus(row.status, `${path}.status`),
    updated_by: asNullableString(row.updated_by, `${path}.updated_by`),
    updated_at: asNullableString(row.updated_at, `${path}.updated_at`),
    line_count: asNumber(row.line_count ?? lines.length, `${path}.line_count`),
    open_count: asNumber(
      row.open_count ?? lines.filter((line) => line.status === "open").length,
      `${path}.open_count`,
    ),
    answered_count: asNumber(
      row.answered_count ?? lines.filter((line) => line.status === "answered").length,
      `${path}.answered_count`,
    ),
    not_used_count: asNumber(
      row.not_used_count ?? lines.filter((line) => line.status === "not_used").length,
      `${path}.not_used_count`,
    ),
    lines,
    can_answer: row.can_answer === null || row.can_answer === undefined
      ? false
      : asBoolean(row.can_answer, `${path}.can_answer`),
  };
}

export function parseTanTaoPatePackInput(raw: unknown, path = "pack"): TanTaoPatePackInput {
  const row = asRecord(raw, path);
  return {
    sku_code: asString(row.sku_code, `${path}.sku_code`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
  };
}

function parseProductionIngredient(
  raw: unknown,
  path: string,
): TanTaoPateProductionIngredient {
  const row = asRecord(raw, path);
  return {
    line_id: asString(row.line_id, `${path}.line_id`),
    item_id: asString(row.item_id, `${path}.item_id`),
    item_name: asString(row.item_name, `${path}.item_name`),
    unit: asString(row.unit, `${path}.unit`),
    grams: asNumber(row.grams, `${path}.grams`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
  };
}

function parseProductionPackaging(
  raw: unknown,
  path: string,
): TanTaoPateProductionPackaging {
  const row = asRecord(raw, path);
  return {
    line_id: asString(row.line_id, `${path}.line_id`),
    kind: asString(row.kind, `${path}.kind`),
    item_id: asString(row.item_id, `${path}.item_id`),
    item_name: asString(row.item_name, `${path}.item_name`),
    unit: asString(row.unit, `${path}.unit`),
    packs: asNumber(row.packs, `${path}.packs`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
  };
}

function parseProductionDocument(
  raw: unknown,
  path: string,
): TanTaoPateProductionDocument {
  const row = asRecord(raw, path);
  return {
    sku_code: asString(row.sku_code, `${path}.sku_code`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
    result:
      row.result === null || row.result === undefined
        ? {}
        : asRecord(row.result, `${path}.result`),
  };
}

export function parseTanTaoPateProductionResult(
  raw: unknown,
  path = "tanTaoPateProduction",
): TanTaoPateProductionResult {
  const row = asRecord(raw, path);
  return {
    status: asString(row.status, `${path}.status`),
    slip_id: asString(row.slip_id, `${path}.slip_id`),
    recipe_code: asString(row.recipe_code, `${path}.recipe_code`),
    production_date: asString(row.production_date, `${path}.production_date`),
    batches: asNumber(row.batches, `${path}.batches`),
    packs: Array.isArray(row.packs)
      ? row.packs.map((pack, index) => parseTanTaoPatePackInput(pack, `${path}.packs[${index}]`))
      : [],
    ingredients: Array.isArray(row.ingredients)
      ? row.ingredients.map((line, index) =>
          parseProductionIngredient(line, `${path}.ingredients[${index}]`),
        )
      : [],
    packaging: Array.isArray(row.packaging)
      ? row.packaging.map((line, index) =>
          parseProductionPackaging(line, `${path}.packaging[${index}]`),
        )
      : [],
    documents: Array.isArray(row.documents)
      ? row.documents.map((doc, index) =>
          parseProductionDocument(doc, `${path}.documents[${index}]`),
        )
      : [],
    movement_count: asNumber(row.movement_count ?? 0, `${path}.movement_count`),
    replay: row.replay === null || row.replay === undefined
      ? false
      : asBoolean(row.replay, `${path}.replay`),
  };
}

// ---------------------------------------------------------------------------
// Pure gameplay helpers
// ---------------------------------------------------------------------------

/** Grams of each ingredient for N batches, aggregated per kitchen item. */
export function usageForBatches(
  lines: TanTaoPateLine[],
  batches: number,
): TanTaoPateIngredientUsage[] {
  if (!Number.isFinite(batches) || batches <= 0) return [];

  const byItem = new Map<string, TanTaoPateIngredientUsage>();
  for (const line of lines) {
    if (line.line_kind !== "ingredient" || line.status !== "answered") continue;
    if (!line.kitchen_inventory_item_id) continue;
    const grams = line.grams_per_batch;
    if (grams === null || !Number.isFinite(grams) || grams <= 0) continue;

    const total = grams * batches;
    const current = byItem.get(line.kitchen_inventory_item_id);
    if (current) {
      current.grams += total;
      current.lineIds.push(line.id);
    } else {
      byItem.set(line.kitchen_inventory_item_id, {
        itemId: line.kitchen_inventory_item_id,
        itemName: line.item_name,
        itemUnit: line.item_unit,
        grams: total,
        lineIds: [line.id],
      });
    }
  }

  return [...byItem.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Pack item / label item / pate grams consumed by the submitted pack counts. */
export function packUsage(
  packs: TanTaoPatePackInput[],
  lines: TanTaoPateLine[],
): TanTaoPatePackUsage[] {
  const totals = new Map<string, number>();
  for (const pack of packs) {
    const sku = pack.sku_code.trim().toUpperCase();
    if (sku === "" || !Number.isFinite(pack.quantity) || pack.quantity <= 0) continue;
    totals.set(sku, (totals.get(sku) ?? 0) + pack.quantity);
  }

  const usage: TanTaoPatePackUsage[] = [];
  for (const line of lines) {
    if (line.line_kind !== "pack" || line.status !== "answered") continue;
    const sku = (line.sku_code ?? "").trim().toUpperCase();
    const quantity = totals.get(sku);
    if (!sku || quantity === undefined || quantity <= 0) continue;

    usage.push({
      lineId: line.id,
      label: line.label,
      skuCode: sku,
      quantity,
      pateGrams: quantity * (line.pate_grams_per_pack ?? 0),
      packItemId: line.pack_item_id,
      labelItemId: line.label_item_id,
    });
  }

  return usage.sort((a, b) => a.skuCode.localeCompare(b.skuCode));
}

/** Question / answer progress including the single batch-output question. */
export function recipeProgress(
  recipe: Pick<TanTaoPateRecipe, "status" | "batch_output_kg" | "batch_set" | "lines">,
): TanTaoPateRecipeProgress {
  const lines = recipe.lines;
  const open = lines.filter((line) => line.status === "open").length;
  const answered = lines.filter((line) => line.status === "answered").length;
  const notUsed = lines.filter((line) => line.status === "not_used").length;
  const batchSet = recipe.batch_set || (recipe.batch_output_kg ?? 0) > 0;
  const total = lines.length + 1;
  const left = open + (batchSet ? 0 : 1);
  const complete = recipe.status === "complete";
  const pct = total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));

  return {
    total,
    answered,
    open,
    notUsed,
    batchSet,
    left,
    complete,
    pct,
  };
}
