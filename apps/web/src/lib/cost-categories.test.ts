import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupCategoriesByParent,
  leafCategoryOptions,
  type CostCategoryTreeRow,
} from "./cost-categories.ts";

const ROWS: CostCategoryTreeRow[] = [
  { code: "C_OPERATING", label: "Chi phí vận hành, quản lý", parent_code: null, is_active: true, sort_order: 300 },
  { code: "A_COGS", label: "Giá vốn hàng bán", parent_code: null, is_active: true, sort_order: 100 },
  { code: "A2_MEAT_OFFAL", label: "Thịt và nội tạng", parent_code: "A_COGS", is_active: true, sort_order: 102 },
  { code: "A1_BREAD_BOUGHT", label: "Bánh mì thành phẩm mua ngoài", parent_code: "A_COGS", is_active: true, sort_order: 101 },
  { code: "C2_ELECTRICITY", label: "Điện", parent_code: "C_OPERATING", is_active: true, sort_order: 302 },
  { code: "B_SELLING", label: "Chi phí bán hàng", parent_code: null, is_active: true, sort_order: 200 },
  { code: "PACKAGING_SALES", label: "Bao bì cũ", parent_code: null, is_active: false, sort_order: 30 },
  { code: "OLD_PARENT", label: "Nhóm cũ", parent_code: null, is_active: false, sort_order: 40 },
  { code: "OLD_CHILD", label: "Con cũ", parent_code: "OLD_PARENT", is_active: true, sort_order: 41 },
  { code: "UNMAPPED_REVIEW", label: "Chưa phân loại / cần review", parent_code: null, is_active: true, sort_order: 70 },
];

test("leafCategoryOptions keeps active leaves and UNMAPPED_REVIEW, never a parent", () => {
  const codes = leafCategoryOptions(ROWS).map((row) => row.code);
  assert.equal(codes.includes("A_COGS"), false);
  assert.equal(codes.includes("C_OPERATING"), false);
  assert.equal(codes.includes("PACKAGING_SALES"), false);
  // B_SELLING has no active child in this fixture, so by the leaf rule it is
  // selectable; on live every parent carries its active leaves.
  assert.deepEqual(codes, ["A2_MEAT_OFFAL", "A1_BREAD_BOUGHT", "C2_ELECTRICITY", "B_SELLING", "OLD_CHILD", "UNMAPPED_REVIEW"]);
});

test("leafCategoryOptions ignores an inactive parent", () => {
  const rows: CostCategoryTreeRow[] = [
    { code: "PARENT", is_active: true, sort_order: 1 },
    { code: "CHILD", parent_code: "PARENT", is_active: true, sort_order: 2 },
    { code: "OLD_PARENT", is_active: false, sort_order: 3 },
    { code: "OLD_CHILD", parent_code: "OLD_PARENT", is_active: true, sort_order: 4 },
  ];
  assert.deepEqual(leafCategoryOptions(rows).map((row) => row.code), ["CHILD", "OLD_CHILD"]);
});

test("groupCategoriesByParent nests children under parents in sort order", () => {
  const groups = groupCategoriesByParent(ROWS);
  assert.deepEqual(groups.map((group) => group.parent?.code), [
    "PACKAGING_SALES",
    "OLD_PARENT",
    "UNMAPPED_REVIEW",
    "A_COGS",
    "B_SELLING",
    "C_OPERATING",
  ]);
  const a = groups.find((group) => group.parent?.code === "A_COGS");
  assert.deepEqual(a?.children.map((row) => row.code), ["A1_BREAD_BOUGHT", "A2_MEAT_OFFAL"]);
  const c = groups.find((group) => group.parent?.code === "C_OPERATING");
  assert.deepEqual(c?.children.map((row) => row.code), ["C2_ELECTRICITY"]);
  assert.deepEqual(groups.find((group) => group.parent?.code === "OLD_PARENT")?.children.map((row) => row.code), ["OLD_CHILD"]);
  assert.deepEqual(groups.find((group) => group.parent?.code === "B_SELLING")?.children, []);
});

test("groupCategoriesByParent keeps every row exactly once", () => {
  const groups = groupCategoriesByParent(ROWS);
  const seen = groups.flatMap((group) => [
    ...(group.parent ? [group.parent.code] : []),
    ...group.children.map((row) => row.code),
  ]);
  assert.equal(seen.length, ROWS.length);
  assert.deepEqual(new Set(seen), new Set(ROWS.map((row) => row.code)));
});
