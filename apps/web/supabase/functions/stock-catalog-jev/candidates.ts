// Pure candidate logic for the Q7 stock catalog Jev scan.
//
// Jev only ever receives the named fields built here (name, unit, item_type,
// usage counts and the canonical material code); no user id, no item uuid and no
// financial amount is placed in the state. Code also decides which side of a pair
// is kept: the item with more issue-slip lines in the last 90 days, and on a tie
// the side whose unit is the smaller mass/volume unit (g or ml). No I/O.

export interface StockCatalogCandidate {
  left_id: string;
  right_id: string;
  left_name: string;
  right_name: string;
  left_unit: string;
  right_unit: string;
  left_item_type: string;
  right_item_type: string;
  left_issue_count_90d: number;
  right_issue_count_90d: number;
  left_movement_count_90d: number;
  right_movement_count_90d: number;
  left_canonical_material_id: string | null;
  right_canonical_material_id: string | null;
  left_canonical_material_code: string | null;
  right_canonical_material_code: string | null;
  left_to_right_factor: number | null;
  right_to_left_factor: number | null;
}

export interface StockCatalogClassifyItem {
  id: string;
  name: string;
  unit: string;
  item_type: string;
  issue_count_90d: number;
  movement_count_90d: number;
  canonical_material_id: string | null;
  canonical_material_code: string | null;
}

/** One side of a candidate pair with the fields code needs to reason about. */
export interface CatalogSide {
  id: string;
  name: string;
  unit: string;
  item_type: string;
  issue_count_90d: number;
  movement_count_90d: number;
  canonical_material_id: string | null;
  canonical_material_code: string | null;
}

/** State sent to Jev: no ids, no financial data. */
export interface SameItemJevState {
  a: SameItemJevItem;
  b: SameItemJevItem;
}

export interface SameItemJevItem {
  name: string;
  unit: string;
  item_type: string;
  issue_count_90d: number;
  movement_count_90d: number;
  canonical_material_code: string | null;
}

/** State sent to Jev for one item classification: no ids, no financial data. */
export interface ClassifyJevState {
  item: SameItemJevItem;
}

export function candidatePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

export function sideOf(pair: StockCatalogCandidate, side: "left" | "right"): CatalogSide {
  if (side === "left") {
    return {
      id: pair.left_id,
      name: pair.left_name,
      unit: pair.left_unit,
      item_type: pair.left_item_type,
      issue_count_90d: pair.left_issue_count_90d,
      movement_count_90d: pair.left_movement_count_90d,
      canonical_material_id: pair.left_canonical_material_id,
      canonical_material_code: pair.left_canonical_material_code,
    };
  }
  return {
    id: pair.right_id,
    name: pair.right_name,
    unit: pair.right_unit,
    item_type: pair.right_item_type,
    issue_count_90d: pair.right_issue_count_90d,
    movement_count_90d: pair.right_movement_count_90d,
    canonical_material_id: pair.right_canonical_material_id,
    canonical_material_code: pair.right_canonical_material_code,
  };
}

function jevItem(side: CatalogSide): SameItemJevItem {
  return {
    name: side.name,
    unit: side.unit,
    item_type: side.item_type,
    issue_count_90d: side.issue_count_90d,
    movement_count_90d: side.movement_count_90d,
    canonical_material_code: side.canonical_material_code,
  };
}

export function buildSameItemState(pair: StockCatalogCandidate): SameItemJevState {
  return { a: jevItem(sideOf(pair, "left")), b: jevItem(sideOf(pair, "right")) };
}

export function buildClassifyState(item: StockCatalogClassifyItem): ClassifyJevState {
  return {
    item: {
      name: item.name,
      unit: item.unit,
      item_type: item.item_type,
      issue_count_90d: item.issue_count_90d,
      movement_count_90d: item.movement_count_90d,
      canonical_material_code: item.canonical_material_code,
    },
  };
}

/** Lowercase, accentless unit used only for the smaller-unit tie-break. */
export function normalizeUnit(unit: string | null | undefined): string {
  return (unit ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** 0 for the smaller mass/volume units (g, ml), 1 for kg/l, 2 otherwise. */
export function unitRank(unit: string | null | undefined): number {
  const normalized = normalizeUnit(unit);
  if (normalized === "g" || normalized === "gr" || normalized === "gram" || normalized === "ml") return 0;
  if (normalized === "kg" || normalized === "kilogram" || normalized === "l" || normalized === "lit") return 1;
  return 2;
}

export interface PrimarySelection {
  target: CatalogSide;
  source: CatalogSide;
  /** Factor converting the source unit into the target unit, or null. */
  factor: number | null;
}

/**
 * The kept item is the side with more issue-slip lines in 90 days; on a tie it is
 * the side with the smaller mass/volume unit (g or ml); a final tie falls back to
 * the smaller item id so the choice is deterministic.
 */
export function selectPrimaryItem(pair: StockCatalogCandidate): PrimarySelection {
  const left = sideOf(pair, "left");
  const right = sideOf(pair, "right");
  let targetIsLeft: boolean;
  if (left.issue_count_90d !== right.issue_count_90d) {
    targetIsLeft = left.issue_count_90d > right.issue_count_90d;
  } else if (unitRank(left.unit) !== unitRank(right.unit)) {
    targetIsLeft = unitRank(left.unit) < unitRank(right.unit);
  } else {
    targetIsLeft = left.id < right.id;
  }
  const target = targetIsLeft ? left : right;
  const source = targetIsLeft ? right : left;
  const factor = targetIsLeft ? pair.right_to_left_factor : pair.left_to_right_factor;
  return { target, source, factor };
}
