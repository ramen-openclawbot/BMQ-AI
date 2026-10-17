/**
 * Pure helpers for the Q7 BOM ↔ kitchen-count matching data layer
 * (2026-10-17).
 *
 * The parsers validate the JSON returned by
 *   public.get_q7_bom_mismatch_review(),
 *   public.resolve_q7_bom_line(...) and
 *   public.post_pending_q7_material_issues(boolean).
 *
 * No React / DOM code lives here so the shapes can be unit tested.
 */

export type Q7BomAction = "remap" | "not_tracked" | "bom_error";

export interface Q7BomMaterial {
  id: string;
  code: string;
  name: string;
  default_unit: string;
}

export interface Q7BomCurrentMapping {
  q7_mapping_id: string;
  kitchen_inventory_item_id: string;
  item_code: string;
  name: string;
  unit: string;
  conversion_factor: number;
}

export interface Q7BomIssueDateQty {
  issue_date: string;
  planned_qty: number;
}

export interface Q7BomCandidate {
  kitchen_inventory_item_id: string;
  item_code: string;
  name: string;
  unit: string;
  counted_balance: number;
  similarity: number;
}

export interface Q7BomDecision {
  id: string;
  action: Q7BomAction;
  new_kitchen_item_id: string | null;
  conversion_factor: number | null;
  note: string | null;
  created_at: string;
}

export interface Q7BomMismatchLine {
  canonical_material_id: string;
  canonical_material: Q7BomMaterial;
  source_unit: string;
  current_mapping: Q7BomCurrentMapping | null;
  planned_qty_total: number;
  planned_by_issue_date: Q7BomIssueDateQty[];
  latest_issue_date: string;
  current_balance: number;
  projected_balance: number;
  has_count_since_cutover: boolean;
  item_class: string | null;
  open: boolean;
  resolved: boolean;
  excluded: boolean;
  decision: Q7BomDecision | null;
  candidates: Q7BomCandidate[];
}

export interface Q7BomResolveResult {
  status: string;
  replay: boolean;
  decision_id: string;
  action: Q7BomAction;
  canonical_material_id: string;
  source_unit: string;
  old_kitchen_item_id: string | null;
  new_kitchen_item_id: string | null;
  conversion_factor: number | null;
  note: string | null;
  created_at: string;
}

export type Q7BomCatchUpAction =
  | "posted"
  | "already_posted"
  | "regenerated"
  | "skipped_open_mismatch"
  | "before_cutover";

export interface Q7BomCatchUpIssue {
  issue_id: string;
  issue_number: string;
  issue_date: string;
  action: Q7BomCatchUpAction;
  movements: number;
  skipped: number;
}

export interface Q7BomCatchUpResult {
  status: string;
  dry_run: boolean;
  cutover_date: string | null;
  issues: Q7BomCatchUpIssue[];
  posted: number;
  already_posted: number;
  regenerated: number;
  skipped_open_mismatch: number;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
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

function asAction(value: unknown, path: string): Q7BomAction {
  const action = asString(value, path);
  if (action !== "remap" && action !== "not_tracked" && action !== "bom_error") {
    throw new TypeError(`${path} is invalid`);
  }
  return action;
}

function asCatchUpAction(value: unknown, path: string): Q7BomCatchUpAction {
  const action = asString(value, path);
  if (
    action !== "posted" &&
    action !== "already_posted" &&
    action !== "regenerated" &&
    action !== "skipped_open_mismatch" &&
    action !== "before_cutover"
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return action;
}

function parseMaterial(raw: unknown, path: string): Q7BomMaterial {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    code: asString(row.code, `${path}.code`),
    name: asString(row.name, `${path}.name`),
    default_unit: asString(row.default_unit, `${path}.default_unit`),
  };
}

function parseNullableMapping(raw: unknown, path: string): Q7BomCurrentMapping | null {
  if (raw === null || raw === undefined) return null;
  const row = asRecord(raw, path);
  return {
    q7_mapping_id: asString(row.q7_mapping_id, `${path}.q7_mapping_id`),
    kitchen_inventory_item_id: asString(
      row.kitchen_inventory_item_id,
      `${path}.kitchen_inventory_item_id`,
    ),
    item_code: asString(row.item_code, `${path}.item_code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    conversion_factor: asNumber(row.conversion_factor, `${path}.conversion_factor`),
  };
}

function parseNullableDecision(raw: unknown, path: string): Q7BomDecision | null {
  if (raw === null || raw === undefined) return null;
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    action: asAction(row.action, `${path}.action`),
    new_kitchen_item_id: asNullableString(
      row.new_kitchen_item_id,
      `${path}.new_kitchen_item_id`,
    ),
    conversion_factor: asNullableNumber(row.conversion_factor, `${path}.conversion_factor`),
    note: asNullableString(row.note, `${path}.note`),
    created_at: asString(row.created_at, `${path}.created_at`),
  };
}

function parseCandidate(raw: unknown, path: string): Q7BomCandidate {
  const row = asRecord(raw, path);
  return {
    kitchen_inventory_item_id: asString(
      row.kitchen_inventory_item_id,
      `${path}.kitchen_inventory_item_id`,
    ),
    item_code: asString(row.item_code, `${path}.item_code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    counted_balance: asNumber(row.counted_balance ?? 0, `${path}.counted_balance`),
    similarity: asNumber(row.similarity ?? 0, `${path}.similarity`),
  };
}

/** Parse one open review row. Throws on a garbled row. */
export function parseQ7BomMismatchLine(raw: unknown, path = "review"): Q7BomMismatchLine {
  const row = asRecord(raw, path);
  return {
    canonical_material_id: asString(
      row.canonical_material_id,
      `${path}.canonical_material_id`,
    ),
    canonical_material: parseMaterial(row.canonical_material, `${path}.canonical_material`),
    source_unit: asString(row.source_unit, `${path}.source_unit`),
    current_mapping: parseNullableMapping(row.current_mapping, `${path}.current_mapping`),
    planned_qty_total: asNumber(row.planned_qty_total ?? 0, `${path}.planned_qty_total`),
    planned_by_issue_date: asArray(
      row.planned_by_issue_date ?? [],
      `${path}.planned_by_issue_date`,
    ).map((entry, index) => {
      const itemPath = `${path}.planned_by_issue_date[${index}]`;
      const item = asRecord(entry, itemPath);
      return {
        issue_date: asString(item.issue_date, `${itemPath}.issue_date`),
        planned_qty: asNumber(item.planned_qty ?? 0, `${itemPath}.planned_qty`),
      };
    }),
    latest_issue_date: asString(row.latest_issue_date, `${path}.latest_issue_date`),
    current_balance: asNumber(row.current_balance ?? 0, `${path}.current_balance`),
    projected_balance: asNumber(row.projected_balance ?? 0, `${path}.projected_balance`),
    has_count_since_cutover: asBoolean(
      row.has_count_since_cutover,
      `${path}.has_count_since_cutover`,
    ),
    item_class: asNullableString(row.item_class, `${path}.item_class`),
    open: asBoolean(row.open, `${path}.open`),
    resolved: asBoolean(row.resolved ?? false, `${path}.resolved`),
    excluded: asBoolean(row.excluded ?? false, `${path}.excluded`),
    decision: parseNullableDecision(row.decision, `${path}.decision`),
    candidates: asArray(row.candidates ?? [], `${path}.candidates`).map((entry, index) =>
      parseCandidate(entry, `${path}.candidates[${index}]`),
    ),
  };
}

/**
 * Parse the array returned by get_q7_bom_mismatch_review(). Garbled rows are
 * dropped one by one so the review never goes blank because of one bad row.
 */
export function parseQ7BomMismatchReview(raw: unknown): Q7BomMismatchLine[] {
  if (!Array.isArray(raw)) return [];
  const rows: Q7BomMismatchLine[] = [];
  raw.forEach((entry, index) => {
    try {
      rows.push(parseQ7BomMismatchLine(entry, `review[${index}]`));
    } catch {
      // Drop only the garbled row.
    }
  });
  return rows;
}

/** Parse the JSON returned by resolve_q7_bom_line(...). */
export function parseQ7BomResolveResult(raw: unknown): Q7BomResolveResult {
  const row = asRecord(raw, "resolveQ7BomLine");
  return {
    status: asString(row.status, "resolveQ7BomLine.status"),
    replay: asBoolean(row.replay ?? false, "resolveQ7BomLine.replay"),
    decision_id: asString(row.decision_id, "resolveQ7BomLine.decision_id"),
    action: asAction(row.action, "resolveQ7BomLine.action"),
    canonical_material_id: asString(
      row.canonical_material_id,
      "resolveQ7BomLine.canonical_material_id",
    ),
    source_unit: asString(row.source_unit, "resolveQ7BomLine.source_unit"),
    old_kitchen_item_id: asNullableString(
      row.old_kitchen_item_id,
      "resolveQ7BomLine.old_kitchen_item_id",
    ),
    new_kitchen_item_id: asNullableString(
      row.new_kitchen_item_id,
      "resolveQ7BomLine.new_kitchen_item_id",
    ),
    conversion_factor: asNullableNumber(
      row.conversion_factor,
      "resolveQ7BomLine.conversion_factor",
    ),
    note: asNullableString(row.note, "resolveQ7BomLine.note"),
    created_at: asString(row.created_at, "resolveQ7BomLine.created_at"),
  };
}

function parseCatchUpIssue(raw: unknown, path: string): Q7BomCatchUpIssue {
  const row = asRecord(raw, path);
  return {
    issue_id: asString(row.issue_id, `${path}.issue_id`),
    issue_number: asString(row.issue_number, `${path}.issue_number`),
    issue_date: asString(row.issue_date, `${path}.issue_date`),
    action: asCatchUpAction(row.action, `${path}.action`),
    movements: asNumber(row.movements ?? 0, `${path}.movements`),
    skipped: asNumber(row.skipped ?? 0, `${path}.skipped`),
  };
}

/** Parse the JSON returned by post_pending_q7_material_issues(boolean). */
export function parseQ7BomCatchUpResult(raw: unknown): Q7BomCatchUpResult {
  const row = asRecord(raw, "postPendingQ7Issues");
  return {
    status: asString(row.status, "postPendingQ7Issues.status"),
    dry_run: asBoolean(row.dry_run ?? false, "postPendingQ7Issues.dry_run"),
    cutover_date: asNullableString(row.cutover_date, "postPendingQ7Issues.cutover_date"),
    issues: asArray(row.issues ?? [], "postPendingQ7Issues.issues").map((entry, index) =>
      parseCatchUpIssue(entry, `postPendingQ7Issues.issues[${index}]`),
    ),
    posted: asNumber(row.posted ?? 0, "postPendingQ7Issues.posted"),
    already_posted: asNumber(row.already_posted ?? 0, "postPendingQ7Issues.already_posted"),
    regenerated: asNumber(row.regenerated ?? 0, "postPendingQ7Issues.regenerated"),
    skipped_open_mismatch: asNumber(
      row.skipped_open_mismatch ?? 0,
      "postPendingQ7Issues.skipped_open_mismatch",
    ),
  };
}

export const parseQ7BomReview = parseQ7BomMismatchReview;
export const parseQ7BomResolve = parseQ7BomResolveResult;
export const parseQ7BomCatchUp = parseQ7BomCatchUpResult;

/** The conversion-factor question shown next to a remap target. */
export function factorPrompt(sourceUnit: string, targetUnit: string): string {
  const source = sourceUnit.trim() || "đơn vị nguồn";
  const target = targetUnit.trim() || "đơn vị kho";
  return `1 ${source} = ? ${target}`;
}

/** Projected balance after the not-yet-posted planned usage is subtracted. */
export function projectedBalance(balance: number, planned: number): number {
  if (!Number.isFinite(balance) || !Number.isFinite(planned)) return 0;
  const value = Math.round((balance - planned) * 1000) / 1000;
  // Normalize -0 so a fully consumed balance renders as "0".
  return Object.is(value, -0) ? 0 : value;
}
