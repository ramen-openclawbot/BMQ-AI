import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEALER_CART_MAX_LINES,
  DEALER_ORDER_STEP,
  normalizeProposal,
  normalizeRouteProposal,
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

const routes = [
  { id: "route-1", name: "Điểm bán Một" },
  { id: "route-2", name: "Điểm bán Hai" },
];

Deno.test("route proposal bỏ điểm bán không thuộc NPP kèm cảnh báo", () => {
  const result = normalizeRouteProposal(
    [{ route_id: "route-la", product_id: catalog[0].id, quantity: 10 }],
    catalog,
    routes,
  );
  assertEquals(result.lines, []);
  assertEquals(result.warnings.length > 0, true);
});

Deno.test("route proposal mặc định sản phẩm BMQ-001 khi không nêu món", () => {
  const result = normalizeRouteProposal(
    [{ route_id: "route-1", quantity: 10 }],
    catalog,
    routes,
  );
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].product_id, catalog[0].id);
  assertEquals(result.lines[0].sku_code, "BMQ-001");
});

Deno.test("route proposal làm tròn 95 lên 100", () => {
  const result = normalizeRouteProposal(
    [{ route_id: "route-1", product_id: catalog[0].id, quantity: 95 }],
    catalog,
    routes,
  );
  assertEquals(result.lines[0].quantity, 100);
  assertEquals(result.warnings.length > 0, true);
});

Deno.test("route proposal giữ đổi/bù, làm tròn và cắt trần", () => {
  const result = normalizeRouteProposal(
    [{
      route_id: "route-1",
      product_id: catalog[0].id,
      quantity: 10,
      exchange_quantity: 3.6,
      makeup_quantity: 600,
    }],
    catalog,
    routes,
  );
  assertEquals(result.lines[0].exchange_quantity, 4);
  assertEquals(result.lines[0].makeup_quantity, 500);
  assertEquals(result.lines[0].quantity, 10);
});

Deno.test("route proposal giữ dòng quantity 0 khi có bù 3", () => {
  const result = normalizeRouteProposal(
    [{ route_id: "route-1", product_id: catalog[0].id, quantity: 0, makeup_quantity: 3 }],
    catalog,
    routes,
  );
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].quantity, 0);
  assertEquals(result.lines[0].makeup_quantity, 3);
});

Deno.test("route proposal bỏ dòng quantity 0 không có đổi/bù", () => {
  const result = normalizeRouteProposal(
    [{ route_id: "route-1", product_id: catalog[0].id, quantity: 0 }],
    catalog,
    routes,
  );
  assertEquals(result.lines, []);
  assertEquals(result.warnings.length > 0, true);
});

Deno.test("route proposal gộp dòng trùng route + sản phẩm", () => {
  const result = normalizeRouteProposal(
    [
      { route_id: "route-1", product_id: catalog[0].id, quantity: 3, exchange_quantity: 1, note: "xin thêm ớt" },
      { route_id: "route-1", product_id: catalog[0].id, quantity: 4, makeup_quantity: 2, note: "và 2 hộp pate" },
    ],
    catalog,
    routes,
  );
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].quantity, 10);
  assertEquals(result.lines[0].exchange_quantity, 1);
  assertEquals(result.lines[0].makeup_quantity, 2);
  assertEquals(result.lines[0].note, "xin thêm ớt; và 2 hộp pate");
});

Deno.test("route proposal lấy giá từ catalog, không lấy giá model gửi", () => {
  const result = normalizeRouteProposal(
    [{
      route_id: "route-1",
      product_id: catalog[0].id,
      quantity: 10,
      unit_price: 1,
      product_name: "Tên giả",
    }],
    catalog,
    routes,
  );
  assertEquals(result.lines[0].unit_price, 5500);
  assertEquals(result.lines[0].product_name, "Bánh Mì Que Pate");
  assertEquals(result.lines[0].line_total, 55000);
});

Deno.test("route proposal trim và cắt ghi chú còn 160 ký tự", () => {
  const result = normalizeRouteProposal(
    [{
      route_id: "route-1",
      product_id: catalog[0].id,
      quantity: 10,
      note: `  ${"x".repeat(200)}  `,
    }],
    catalog,
    routes,
  );
  assertEquals(result.lines[0].note.length, 160);
  assertEquals(result.lines[0].note, "x".repeat(160));
});

Deno.test(`route proposal giữ tối đa ${DEALER_CART_MAX_LINES} dòng`, () => {
  const manyRoutes = Array.from({ length: DEALER_CART_MAX_LINES + 2 }, (_, index) => ({
    id: `route-${index + 1}`,
    name: `Điểm bán ${index + 1}`,
  }));
  const result = normalizeRouteProposal(
    manyRoutes.map((route) => ({ route_id: route.id, product_id: catalog[0].id, quantity: 10 })),
    catalog,
    manyRoutes,
  );
  assertEquals(result.lines.length, DEALER_CART_MAX_LINES);
  assertEquals(result.warnings.length > 0, true);
});
