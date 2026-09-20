// Synthetic labelled tune/holdout fixtures for the deterministic material matcher.
//
// NO REAL BENCHMARK: these are hand-written synthetic cases only. They contain no
// real BMQ business data, no monetary values, no contact data and no documents, and
// the tests that consume them make no provider call. They exist to keep the exact
// matching precedence and the group/conflict safety measurable as code changes.
//
// The model path is intentionally not scored here: Jev only proposes a bounded
// candidate and every suggestion still requires explicit human review, so there is
// nothing to calibrate and no fine-tuning is claimed or performed.

import type { MaterialMatchInput } from "./material-suggest.ts";

export const MATERIAL_SUGGEST_FIXTURE_CLAIM = "synthetic tune/holdout fixtures; no real benchmark, no provider call, no fine-tuning";

const BO = { id: "mat_bo", material_code: "NVL-BO", canonical_name: "Bơ", normalized_name: "bo", default_unit: "kg", category: null, brand: null, specification: null, active: true };
const PEANUT = { id: "mat_peanut", material_code: "NVL-DAU", canonical_name: "Đậu phộng", normalized_name: "dau phong", default_unit: "kg", category: "hạt", brand: "BMQ", specification: null, active: true };
const BUTTER_A = { id: "mat_a", material_code: "NVL-A", canonical_name: "Bơ lạt", normalized_name: "bo lat", default_unit: "kg", category: "bơ", brand: null, specification: null, active: true };
const BUTTER_B = { id: "mat_b", material_code: "NVL-B", canonical_name: "Bơ thực vật", normalized_name: "bo thuc vat", default_unit: "kg", category: "bơ", brand: null, specification: null, active: true };

const base = {
  request_id: "11111111-1111-1111-1111-111111111111",
  raw_name: "",
  raw_code: null,
  raw_unit: null,
  supplier_id: null,
  supplier_name: null,
  source_type: "payment_request",
  materials: [BO, PEANUT],
  scoped_aliases: [],
  supplier_products: [],
} satisfies MaterialMatchInput;

export interface MaterialFixture {
  id: string;
  split: "tune" | "holdout";
  input: MaterialMatchInput;
  expected: { kind: "exact" | "ambiguous" | "none"; matched_by: string | null; material_id: string | null };
}

export const MATERIAL_SUGGEST_TUNE_FIXTURES: MaterialFixture[] = [
  { id: "tune-exact-name", split: "tune", input: { ...base, raw_name: "Bơ" }, expected: { kind: "exact", matched_by: "canonical_name", material_id: "mat_bo" } },
  { id: "tune-exact-code", split: "tune", input: { ...base, raw_name: "khong ro", raw_code: "NVL-DAU" }, expected: { kind: "exact", matched_by: "material_code", material_id: "mat_peanut" } },
  { id: "tune-group-category", split: "tune", input: { ...base, raw_name: "bơ", materials: [BUTTER_A, BUTTER_B] }, expected: { kind: "ambiguous", matched_by: "canonical_category_group", material_id: null } },
  { id: "tune-approved-alias", split: "tune", input: { ...base, raw_name: "Đậu phộng rang", supplier_id: "sup_tv", scoped_aliases: [{ material_id: "mat_peanut", supplier_id: "sup_tv", normalized_alias: "dau phong rang", approved: true, active: true }] }, expected: { kind: "exact", matched_by: "approved_supplier_alias", material_id: "mat_peanut" } },
  { id: "tune-canonical-scoped-conflict", split: "tune", input: { ...base, raw_name: "Bơ", supplier_id: "sup_tv", scoped_aliases: [{ material_id: "mat_peanut", supplier_id: "sup_tv", normalized_alias: "bo", approved: true, active: true }] }, expected: { kind: "ambiguous", matched_by: "canonical_scoped_conflict", material_id: null } },
];

export const MATERIAL_SUGGEST_HOLDOUT_FIXTURES: MaterialFixture[] = [
  { id: "holdout-approved-product", split: "holdout", input: { ...base, raw_name: "BỘ PEERLESS 25KG", supplier_id: "sup_tv", supplier_products: [{ material_id: "mat_bo", supplier_id: "sup_tv", normalized_supplier_product_name: "bo peerless 25kg", purchase_unit: "thùng", approved: true, active: true }] }, expected: { kind: "exact", matched_by: "approved_supplier_product", material_id: "mat_bo" } },
  { id: "holdout-wrong-supplier", split: "holdout", input: { ...base, raw_name: "ten ncc", supplier_id: "sup_tv", scoped_aliases: [{ material_id: "mat_peanut", supplier_id: "sup_other", normalized_alias: "ten ncc", approved: true, active: true }] }, expected: { kind: "none", matched_by: null, material_id: null } },
  { id: "holdout-unapproved-alias", split: "holdout", input: { ...base, raw_name: "ten ncc", supplier_id: "sup_tv", scoped_aliases: [{ material_id: "mat_peanut", supplier_id: "sup_tv", normalized_alias: "ten ncc", approved: false, active: true }] }, expected: { kind: "none", matched_by: null, material_id: null } },
  { id: "holdout-punctuation-alias", split: "holdout", input: { ...base, raw_name: "Đậu phộng rang (500g)", supplier_id: "sup_tv", scoped_aliases: [{ material_id: "mat_peanut", supplier_id: "sup_tv", normalized_alias: "dau phong rang 500g", approved: true, active: true }] }, expected: { kind: "exact", matched_by: "approved_supplier_alias", material_id: "mat_peanut" } },
  { id: "holdout-inactive-ignored", split: "holdout", input: { ...base, raw_name: "Bơ", materials: [{ ...BO, active: false }] }, expected: { kind: "none", matched_by: null, material_id: null } },
];

export const MATERIAL_SUGGEST_FIXTURE_SPLITS = {
  tune: MATERIAL_SUGGEST_TUNE_FIXTURES,
  holdout: MATERIAL_SUGGEST_HOLDOUT_FIXTURES,
};
