import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEALER_CART_MAX_LINES,
  DEALER_ORDER_STEP,
  normalizeProposal,
  type DealerCartCatalogItem,
} from "./dealer-cart-gates.ts";

const catalog: DealerCartCatalogItem[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    sku_code: "BMQ-001",
    product_name: "Bánh Mì Que Pate",
    unit: "que",
    price_vnd: 5500,
    unit_price: 5000,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    sku_code: "BMD-2026",
    product_name: "Bánh Mì Dark Rye",
    unit: "cái",
    price_vnd: 12000,
    unit_price: 12000,
  },
];

Deno.test("loại món lạ không thuộc danh mục đại lý", () => {
  const result = normalizeProposal([{ product_id: "khong-ton-tai", quantity: 10 }], catalog);
  assertEquals(result.lines, []);
  assertEquals(result.warnings.length, 1);
});

Deno.test("làm tròn 7 lên bội số 10 và điền giá từ catalog", () => {
  const result = normalizeProposal([{ product_id: catalog[0].id, quantity: 7 }], catalog);
  assertEquals(result.lines, [{
    product_id: catalog[0].id,
    sku_code: "BMQ-001",
    product_name: "Bánh Mì Que Pate",
    unit: "que",
    unit_price: 5500,
    quantity: 10,
  }]);
  assertEquals(DEALER_ORDER_STEP, 10);
});

Deno.test("cắt số lượng 1001 còn tối đa 1000", () => {
  const result = normalizeProposal([{ product_id: catalog[1].id, quantity: 1001 }], catalog);
  assertEquals(result.lines[0].quantity, 1000);
  assertEquals(result.warnings.length > 0, true);
});

Deno.test("gộp các dòng trùng product_id", () => {
  const result = normalizeProposal([
    { product_id: catalog[0].id, quantity: 3 },
    { product_id: catalog[0].id, quantity: 4 },
  ], catalog);
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].quantity, 10);
});

Deno.test("khớp món bằng sku_code và không lấy tên/giá từ model", () => {
  const result = normalizeProposal([{
    product_id: "",
    sku_code: "bmd-2026",
    quantity: 20,
    product_name: "Tên giả",
    unit_price: 1,
  }], catalog);
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].product_id, catalog[1].id);
  assertEquals(result.lines[0].product_name, "Bánh Mì Dark Rye");
  assertEquals(result.lines[0].unit_price, 12000);
});

Deno.test("loại số lượng âm, chữ và dòng không hợp lệ", () => {
  const result = normalizeProposal([
    { product_id: catalog[0].id, quantity: -10 },
    { product_id: catalog[0].id, quantity: "abc" },
    null,
  ], catalog);
  assertEquals(result.lines, []);
  assertEquals(result.warnings.length, 3);
});

Deno.test(`giới hạn tối đa ${DEALER_CART_MAX_LINES} dòng`, () => {
  const manyCatalog = Array.from({ length: DEALER_CART_MAX_LINES + 2 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sku_code: `SKU-${index + 1}`,
    product_name: `Món ${index + 1}`,
    unit: "cái",
    price_vnd: 1000,
  }));
  const result = normalizeProposal(
    manyCatalog.map((item) => ({ product_id: item.id, quantity: 10 })),
    manyCatalog,
  );
  assertEquals(result.lines.length, DEALER_CART_MAX_LINES);
  assertEquals(result.warnings.length, 1);
});
