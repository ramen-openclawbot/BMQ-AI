import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateKfmMaterialIssue,
  resolveKfmProductionSources,
  selectPositiveFinishedQuantity,
  type KfmBomRow,
  type KfmProductionSourceRecord,
} from "./kfm-material-issue";

const issueDate = "2026-08-16";

function bom(overrides: Partial<KfmBomRow> = {}): KfmBomRow {
  return {
    finished_sku_code: "FG-1",
    finished_output_qty: 100,
    formulation_version_id: "v1",
    effective_from: "2026-08-01",
    ingredient_name: "Flour",
    material_code: "FLOUR",
    material_name: "Flour",
    unit: "kg",
    dosage_qty: 2,
    wastage_percent: 0,
    ...overrides,
  };
}

function source(overrides: Partial<KfmProductionSourceRecord> = {}): KfmProductionSourceRecord {
  return {
    source_id: "src-1",
    order_identity: "order-1",
    replacement_group: null,
    created_at: "2026-08-16T08:00:00Z",
    finished_sku_code: "FG-1",
    actual_qty: null,
    planned_qty: null,
    ordered_qty: 150,
    ...overrides,
  };
}

test("selectPositiveFinishedQuantity uses actual then planned then ordered positive quantities only", () => {
  assert.equal(selectPositiveFinishedQuantity({ actual_qty: 8, planned_qty: 7, ordered_qty: 6 }), 8);
  assert.equal(selectPositiveFinishedQuantity({ actual_qty: 0, planned_qty: 7, ordered_qty: 6 }), 7);
  assert.equal(selectPositiveFinishedQuantity({ actual_qty: -1, planned_qty: 0, ordered_qty: 6 }), 6);
  assert.equal(selectPositiveFinishedQuantity({ actual_qty: Number.NaN, planned_qty: -2, ordered_qty: 0 }), null);
});

test("calculateKfmMaterialIssue scales dosage by finished batch output", () => {
  const result = calculateKfmMaterialIssue({ issue_date: issueDate, sources: [source()], bom_rows: [bom()] });

  assert.deepEqual(result.blockers, []);
  assert.equal(result.materials[0].required_qty, 3);
});

test("calculateKfmMaterialIssue applies wastage percentage", () => {
  const result = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source({ ordered_qty: 100 })],
    bom_rows: [bom({ dosage_qty: 10, wastage_percent: 5 })],
  });

  assert.deepEqual(result.blockers, []);
  assert.equal(result.materials[0].required_qty, 10.5);
});

test("calculateKfmMaterialIssue selects latest eligible effective BOM version and blocks when none is eligible", () => {
  const selected = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source()],
    bom_rows: [
      bom({ formulation_version_id: "old", effective_from: "2026-08-01", dosage_qty: 2 }),
      bom({ formulation_version_id: "new", effective_from: "2026-08-15", dosage_qty: 4 }),
      bom({ formulation_version_id: "future", effective_from: "2026-08-17", dosage_qty: 100 }),
    ],
  });
  assert.deepEqual(selected.blockers, []);
  assert.equal(selected.materials[0].required_qty, 6);

  const blocked = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source()],
    bom_rows: [bom({ effective_from: "2026-08-17" })],
  });
  assert.equal(blocked.materials.length, 0);
  assert.equal(blocked.blockers[0].code, "no_eligible_bom_version");
});

test("calculateKfmMaterialIssue omits parent only when a child exists in the selected version and strips child prefix", () => {
  const result = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source()],
    bom_rows: [
      bom({ formulation_version_id: "v1", ingredient_name: "Sauce", material_code: "SAUCE", material_name: "Sauce", dosage_qty: 5 }),
      bom({ formulation_version_id: "v1", ingredient_name: "Sauce > Mayo", material_code: "MAYO", material_name: "Mayo", dosage_qty: 1 }),
      bom({ formulation_version_id: "v1", ingredient_name: "Salt", material_code: "SALT", material_name: "Salt", dosage_qty: 2 }),
    ],
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.materials.map((row) => row.display_name), ["Mayo", "Salt"]);
  assert.deepEqual(result.materials.map((row) => row.material_code), ["MAYO", "SALT"]);
});

test("calculateKfmMaterialIssue validates only leaf BOM rows after omitting structural parents", () => {
  const result = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source({ ordered_qty: 100 })],
    bom_rows: [
      bom({
        ingredient_name: "Sauce",
        material_code: "",
        material_name: "",
        unit: "",
        dosage_qty: 0,
      }),
      bom({ ingredient_name: "Sauce > Mayo", material_code: "MAYO", material_name: "Mayo", dosage_qty: 1 }),
    ],
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.materials.map((row) => [row.display_name, row.material_code, row.required_qty]), [
    ["Mayo", "MAYO", 1],
  ]);
});

test("calculateKfmMaterialIssue aggregates same canonical material and unit but keeps differing units separate", () => {
  const result = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source({ ordered_qty: 100 })],
    bom_rows: [
      bom({ ingredient_name: "Flour A", material_code: "FLOUR", unit: "kg", dosage_qty: 1 }),
      bom({ ingredient_name: "Flour B", material_code: " flour ", unit: " KG ", dosage_qty: 2 }),
      bom({ ingredient_name: "Flour Each", material_code: "FLOUR", unit: "pcs", dosage_qty: 3 }),
    ],
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.materials.map((row) => [row.material_code, row.unit, row.required_qty]), [
    ["FLOUR", "kg", 3],
    ["FLOUR", "pcs", 3],
  ]);
});

test("calculateKfmMaterialIssue fails closed with actionable blockers for invalid source and BOM data", () => {
  const result = calculateKfmMaterialIssue({
    issue_date: issueDate,
    sources: [source({ source_id: "bad-source", actual_qty: null, planned_qty: 0, ordered_qty: Number.NaN })],
    bom_rows: [
      bom({ finished_output_qty: 0, ingredient_name: "Zero output" }),
      bom({ dosage_qty: -1, ingredient_name: "Negative dosage" }),
      bom({ dosage_qty: Number.NaN, ingredient_name: "NaN dosage" }),
      bom({ material_code: "", material_name: "", ingredient_name: "Missing material" }),
    ],
  });

  assert.equal(result.materials.length, 0);
  assert.deepEqual(result.blockers.map((blocker) => blocker.code), [
    "invalid_finished_quantity",
    "invalid_bom_output_qty",
    "invalid_bom_dosage_qty",
    "invalid_bom_dosage_qty",
    "missing_material_identity",
  ]);
  assert.ok(result.blockers.every((blocker) => blocker.message.length > 12));
});

test("resolveKfmProductionSources retains independent orders, keeps latest replacement revision, and blocks ambiguous rows", () => {
  const resolved = resolveKfmProductionSources([
    source({ source_id: "independent-a", order_identity: "order-a", replacement_group: null, created_at: "2026-08-16T08:00:00Z", ordered_qty: 10 }),
    source({ source_id: "independent-b", order_identity: "order-b", replacement_group: null, created_at: "2026-08-16T08:01:00Z", ordered_qty: 20 }),
    source({ source_id: "rev-old", order_identity: "order-c-old", replacement_group: "replace-c", created_at: "2026-08-16T08:02:00Z", ordered_qty: 30 }),
    source({ source_id: "rev-new", order_identity: "order-c-new", replacement_group: "replace-c", created_at: "2026-08-16T08:03:00Z", ordered_qty: 40 }),
    source({ source_id: "ambiguous", order_identity: null, replacement_group: null, created_at: "2026-08-16T08:04:00Z", ordered_qty: 50 }),
  ]);

  assert.deepEqual(resolved.sources.map((row) => row.source_id), ["independent-a", "independent-b", "rev-new"]);
  assert.equal(resolved.blockers.length, 1);
  assert.equal(resolved.blockers[0].code, "ambiguous_source_identity");
});
