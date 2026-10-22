import assert from "node:assert/strict";
import test from "node:test";

import {
  filterItems,
  khoErrorText,
  searchKey,
  standardUnitFactor,
  type KhoItem,
} from "./kho-items.ts";

function item(overrides: Partial<KhoItem> & { name: string; id?: string }): KhoItem {
  return {
    id: overrides.id ?? overrides.name,
    item_code: null,
    name: overrides.name,
    unit: "kg",
    active: true,
    item_class: null,
    in_q7: false,
    qty: { tan_tao: null, q7: null },
    last_count_date: { tan_tao: null, q7: null },
    pending_count: { tan_tao: null, q7: null },
    doc_lines: 0,
    ...overrides,
  };
}

test("standardUnitFactor mirrors q7_unit_factor for weight", () => {
  assert.equal(standardUnitFactor("kg", "g"), 1000);
  assert.equal(standardUnitFactor("g", "kg"), 0.001);
  assert.equal(standardUnitFactor("mg", "g"), 0.001);
  assert.equal(standardUnitFactor("g", "mg"), 1000);
  assert.equal(standardUnitFactor(" KG ", "g"), 1000);
  assert.equal(standardUnitFactor("k g", "g"), 1000);
  assert.equal(standardUnitFactor("g", "g"), 1);
});

test("standardUnitFactor mirrors q7_unit_factor for volume", () => {
  assert.equal(standardUnitFactor("l", "ml"), 1000);
  assert.equal(standardUnitFactor("ml", "l"), 0.001);
  assert.equal(standardUnitFactor(" L ", "ml"), 1000);
});

test("standardUnitFactor refuses a game unit or a different kind", () => {
  assert.equal(standardUnitFactor("bao", "kg"), null);
  assert.equal(standardUnitFactor("g", "ml"), null);
  assert.equal(standardUnitFactor("", "g"), null);
  assert.equal(standardUnitFactor(null, "g"), null);
});

test("searchKey strips Vietnamese accents, đ and extra spaces", () => {
  assert.equal(searchKey("Bánh mì Đặc Biệt"), "banh mi dac biet");
  assert.equal(searchKey("  Bột   mì  "), "bot mi");
  assert.equal(searchKey("Đường"), "duong");
  assert.equal(searchKey("Tỏi"), "toi");
  assert.equal(searchKey(null), "");
});

test("filterItems searches accent-insensitively", () => {
  const items = [
    item({ name: "Bánh mì" }),
    item({ name: "Bột mì" }),
    item({ name: "Đường" }),
  ];
  assert.deepEqual(
    filterItems(items, "banh mi").map((row) => row.name),
    ["Bánh mì"],
  );
  assert.deepEqual(
    filterItems(items, "duong").map((row) => row.name),
    ["Đường"],
  );
  assert.deepEqual(
    filterItems(items, "mì").map((row) => row.name),
    ["Bánh mì", "Bột mì"],
  );
});

test("filterItems applies activeOnly and location", () => {
  const items = [
    item({ name: "Tỏi", in_q7: true }),
    item({ name: "Gan", in_q7: true, active: false }),
    item({
      name: "Bột mì",
      qty: { tan_tao: 12, q7: null },
    }),
    item({ name: "Món mới" }),
  ];

  assert.deepEqual(
    filterItems(items, "", { activeOnly: true }).map((row) => row.name),
    ["Tỏi", "Bột mì", "Món mới"],
  );
  assert.deepEqual(
    filterItems(items, "", { location: "q7" }).map((row) => row.name),
    ["Tỏi", "Gan"],
  );
  assert.deepEqual(
    filterItems(items, "", { location: "tan_tao" }).map((row) => row.name),
    ["Bột mì"],
  );
  assert.deepEqual(
    filterItems(items, "", { location: "tan_tao", activeOnly: true }).map((row) => row.name),
    ["Bột mì"],
  );
});

test("khoErrorText maps every game error", () => {
  const expected: Record<string, string> = {
    insufficient_privilege: "Anh/chị không có quyền thực hiện thao tác này.",
    rename_forbidden: "Anh/chị không có quyền đổi tên món.",
    unit_forbidden: "Anh/chị không có quyền đổi đơn vị món.",
    invalid_name: "Tên món phải có từ 2 đến 120 ký tự.",
    item_not_found: "Không tìm thấy món này.",
    item_name_duplicate: "Tên món đã được dùng cho món khác.",
    invalid_factor: "Hệ số quy đổi phải lớn hơn 0.",
    unit_not_allowed: "Đơn vị này không được dùng trong kho.",
    invalid_quantity: "Số lượng đếm phải lớn hơn hoặc bằng 0.",
    item_inactive: "Món này đã tắt nên không đếm được.",
    item_not_in_location: "Món này không có trong kho đã chọn.",
    item_in_open_count: "Món này đã được đếm trong phiếu kiểm kê đang mở. Nộp phiếu kiểm kê đó trước, rồi mới tắt được món.",
    item_merged: "Món này đã gộp vào món khác. Mở món mới để sửa.",
  };

  for (const [code, text] of Object.entries(expected)) {
    assert.equal(khoErrorText({ message: code, code: "22023" }), text, code);
  }

  assert.equal(
    khoErrorText({ code: "57014", message: "canceling statement due to statement timeout" }),
    "Máy chủ xử lý quá lâu, anh/chị thử lại giúp.",
  );
  assert.equal(
    khoErrorText(new Error("statement timeout")),
    "Máy chủ xử lý quá lâu, anh/chị thử lại giúp.",
  );
  assert.equal(
    khoErrorText({ message: "something unexpected" }),
    "Có lỗi xảy ra, anh/chị thử lại giúp.",
  );
});
