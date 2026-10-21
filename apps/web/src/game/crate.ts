import type { WarehouseGamePendingRow } from "@/lib/warehouse-game";

/** Stable key of one pending receipt name (one "crate"): supplier + normalized name. */
export const crateKey = (row: WarehouseGamePendingRow) => `${row.supplier_id ?? "-"}|${row.normalized_name}`;

/** Receipt name → a clean catalog name: no [tags], no "/ English", no "ngày 10" or trailing day number. */
export function cleanCrateName(raw: string): string {
  let name = raw.replace(/^\s*(\[[^\]]*\]\s*)+/, "").split("/")[0];
  name = name.replace(/\bng[aà]y\s*\d{1,2}\b/giu, " ").replace(/\s+\d{1,2}\s*$/u, "").replace(/\s+/g, " ").trim();
  if (!name) return raw.trim();
  if (name === name.toUpperCase() && /\p{L}/u.test(name)) name = name.toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A name-match candidate worth showing. One shared word ("bánh", "nhãn") gives a 0.63 token score that ties
 * across many items (owner 12/10: "Nhãn Bánh Pháp" → "Chất làm mềm bánh"), so token-only matches need ≥ 0.75.
 */
export function strongCandidate(crate: WarehouseGamePendingRow) {
  const c = crate.top_candidate;
  if (!c?.name) return null;
  const tokenOnly = (c.reason ?? "").includes("token");
  return tokenOnly && Number(c.score ?? 0) < 0.75 ? null : c;
}
