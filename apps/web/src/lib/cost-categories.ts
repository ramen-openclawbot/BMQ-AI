/**
 * Pure helpers for the cost category tree.
 *
 * The database stores the tree as a flat `cost_categories` table with a
 * nullable `parent_code`: the four approved parents (A_COGS, B_SELLING,
 * C_OPERATING, D_INVESTMENT) have no parent, and the 24 leaves point at one of
 * them. The edit picker must offer leaves only, while the summary/report code
 * may group the same rows by parent.
 */

export interface CostCategoryTreeRow {
  code: string;
  label?: string | null;
  parent_code?: string | null;
  is_active?: boolean | null;
  sort_order?: number | null;
}

export interface CostCategoryGroup<T extends CostCategoryTreeRow> {
  parent: T | null;
  children: T[];
}

function sortOrder(row: CostCategoryTreeRow): number {
  const value = Number(row.sort_order ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function compareCategories(a: CostCategoryTreeRow, b: CostCategoryTreeRow): number {
  const bySort = sortOrder(a) - sortOrder(b);
  if (bySort !== 0) return bySort;
  return String(a.code).localeCompare(String(b.code));
}

function isActive(row: CostCategoryTreeRow): boolean {
  return row.is_active !== false;
}

/**
 * Active categories that are not the parent of another active category.
 *
 * `UNMAPPED_REVIEW` is intentionally always selectable; it is a review bucket,
 * not a parent. Input order is preserved so the existing sort_order query keeps
 * driving the picker.
 */
export function leafCategoryOptions<T extends CostCategoryTreeRow>(rows: readonly T[]): T[] {
  const activeRows = rows.filter((row) => isActive(row) && typeof row.code === "string" && row.code !== "");
  const activeParentCodes = new Set(
    activeRows
      .map((row) => row.parent_code)
      .filter((code): code is string => typeof code === "string" && code !== ""),
  );
  return activeRows.filter((row) => row.code === "UNMAPPED_REVIEW" || !activeParentCodes.has(row.code));
}

/**
 * Group rows under their parent, parents first and children sorted by
 * sort_order then code. Rows whose parent is not present are kept as their own
 * group so no input row is dropped.
 */
export function groupCategoriesByParent<T extends CostCategoryTreeRow>(
  rows: readonly T[],
): CostCategoryGroup<T>[] {
  const sorted = [...rows]
    .filter((row) => typeof row.code === "string" && row.code !== "")
    .sort(compareCategories);
  const codes = new Set(sorted.map((row) => row.code));
  const roots: T[] = [];
  const childrenByParent = new Map<string, T[]>();

  for (const row of sorted) {
    const parentCode = typeof row.parent_code === "string" ? row.parent_code : "";
    if (parentCode !== "" && codes.has(parentCode)) {
      const children = childrenByParent.get(parentCode) ?? [];
      children.push(row);
      childrenByParent.set(parentCode, children);
    } else {
      roots.push(row);
    }
  }

  const groups: CostCategoryGroup<T>[] = roots.map((parent) => ({
    parent,
    children: childrenByParent.get(parent.code) ?? [],
  }));

  return groups;
}
