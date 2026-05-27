#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const sourcePath = resolve(root, "supabase/functions/_shared/ocr-cost-classifier.ts");
const outPath = resolve(root, ".tmp/ocr-cost-classifier.test.mjs");

const source = await readFile(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    strict: true,
  },
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, output.outputText, "utf8");

const mod = await import(pathToFileURL(outPath).href + `?t=${Date.now()}`);

const mappings = [
  {
    id: "map-dau",
    source_name: "Dầu hướng dương",
    source_name_key: "dau huong duong",
    supplier_id: null,
    standard_cost_code_type: "NVL",
    standard_cost_code: "NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI",
    canonical_cost_item_name: "Dầu Hướng Dương Simply 2L x 6 Chai",
    category_code: "COGS_SWEET_KITCHEN",
    product_line: "sweet_kitchen",
    allocation_rule: "direct",
    mapping_status: "approved",
    active: true,
  },
  {
    id: "map-dien",
    source_name: "Khung giờ trung bình",
    source_name_key: "khung gio trung binh",
    supplier_id: null,
    standard_cost_code_type: "OPEX",
    standard_cost_code: "OPEX-TIEN-DIEN",
    canonical_cost_item_name: "tiền điện",
    category_code: "OPEX_GENERAL",
    product_line: "general",
    allocation_rule: "none",
    mapping_status: "approved",
    active: true,
  },
  {
    id: "map-review",
    source_name: "Đá",
    source_name_key: "da",
    mapping_status: "needs_review",
    active: true,
  },
];

{
  const prResult = mod.classifyOcrCostLineFromMappings(
    { rawProductName: "Dầu hướng dương", documentType: "payment_request", unit: "thùng" },
    mappings,
  );
  const invoiceResult = mod.classifyOcrCostLineFromMappings(
    { rawProductName: "Dầu hướng dương", documentType: "invoice", unit: "thùng" },
    mappings,
  );

  assert.equal(prResult.resolved, true);
  assert.equal(invoiceResult.resolved, true);
  assert.equal(prResult.classification.suggested_standard_cost_code, invoiceResult.classification.suggested_standard_cost_code);
  assert.equal(prResult.classification.standard_cost_code_type, "NVL");
  assert.equal(prResult.classification.cost_review_routing, "none");
  assert.equal(prResult.display_standard_cost_label, "NVL · NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI — Dầu Hướng Dương Simply 2L x 6 Chai");
}

{
  const result = mod.classifyOcrCostLineFromMappings(
    { rawProductName: "Khung giờ trung bình", documentType: "invoice" },
    mappings,
  );

  assert.equal(result.resolved, true);
  assert.equal(result.classification.standard_cost_code_type, "OPEX");
  assert.equal(result.classification.suggested_standard_cost_code, "OPEX-TIEN-DIEN");
  assert.equal(result.classification.cost_category_code, "OPEX_GENERAL");
}

{
  const result = mod.classifyOcrCostLineFromMappings(
    { rawProductName: "Tên OCR chưa biết", documentType: "payment_request" },
    mappings,
  );

  assert.equal(result.resolved, false);
  assert.equal(result.classification.raw_product_name, "Tên OCR chưa biết");
  assert.equal(result.classification.canonical_cost_item_name, "Tên OCR chưa biết");
  assert.equal(result.classification.cost_category_code, "UNMAPPED_REVIEW");
  assert.equal(result.classification.cost_review_routing, "needs_review");
  assert.equal(result.classification.suggested_standard_cost_code, null);
}

{
  const result = mod.classifyOcrCostLineFromMappings(
    { rawProductName: "Đá", documentType: "invoice" },
    mappings,
  );

  assert.equal(result.resolved, false);
  assert.equal(result.classification.cost_review_routing, "needs_review");
  assert.equal(result.classification.ocr_classification_json.reason, "existing_mapping_needs_review");
}

{
  const ambiguous = [
    ...mappings,
    {
      id: "map-dau-2",
      source_name: "Dầu hướng dương",
      source_name_key: "dau huong duong",
      standard_cost_code_type: "NVL",
      standard_cost_code: "NVL-SAI-KHAC",
      canonical_cost_item_name: "Sai khác",
      category_code: "COGS_SWEET_KITCHEN",
      product_line: "sweet_kitchen",
      allocation_rule: "direct",
      mapping_status: "approved",
      active: true,
    },
  ];
  const result = mod.classifyOcrCostLineFromMappings({ rawProductName: "Dầu hướng dương" }, ambiguous);
  assert.equal(result.resolved, false);
  assert.equal(result.classification.ocr_classification_json.reason, "ambiguous_approved_alias");
}

console.log("ocr cost classifier tests ok");
