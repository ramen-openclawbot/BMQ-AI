import assert from "node:assert/strict";
import test from "node:test";
import { MERCHANT_PAGE_CONTEXT_MAX, MERCHANT_PAGE_GUIDES, merchantPageContext, merchantPageGuide } from "./merchantPageGuide.ts";

test("the most specific page wins", () => {
  assert.equal(merchantPageGuide("/warehouse/kiem-ke")?.label, "Kiểm kê");
  assert.equal(merchantPageGuide("/warehouse/catalog-cleanup")?.label, "Kho");
  assert.equal(merchantPageGuide("/finance-control/revenue/points")?.label, "Doanh thu điểm bán");
  assert.equal(merchantPageGuide("/finance-control/revenue/setup")?.label, "Quản lý doanh thu");
  assert.equal(merchantPageGuide("/finance")?.label, "Finance");
  assert.equal(merchantPageGuide("/production/planning/q7/kfm")?.label, "Xưởng Q7");
});

test("detail routes and trailing slashes keep their parent page", () => {
  assert.equal(merchantPageGuide("/payment-requests/submissions/abc")?.label, "Duyệt chi");
  assert.equal(merchantPageGuide("/purchase-orders/")?.label, "PO mua hàng");
});

test("prefixes match whole path segments only", () => {
  assert.equal(merchantPageGuide("/finance-control/payables")?.label, "Công nợ phải trả");
  assert.notEqual(merchantPageGuide("/financex")?.label, "Finance");
  assert.equal(merchantPageGuide("/settings"), null);
  assert.equal(merchantPageGuide("/")?.label, "Tổng quan");
  assert.equal(merchantPageGuide("/unknown")?.label, undefined);
});

test("pages whose data the agent cannot read offer no suggestions", () => {
  for (const path of ["/", "/payroll", "/production/qa", "/finance-control/revenue/debt", "/salary-payouts/1"]) {
    assert.equal(merchantPageGuide(path)?.suggestions, undefined, path);
  }
  assert.equal(merchantPageGuide("/payment-requests")?.suggestions?.length, 4);
});

test("page context carries the path, label and purpose within the server limit", () => {
  assert.equal(
    merchantPageContext("/purchase-orders"),
    "/purchase-orders · PO mua hàng: đơn mua hàng (PO) BMQ gửi nhà cung cấp",
  );
  assert.equal(merchantPageContext("/settings"), "/settings");
  const long = merchantPageContext(`/payment-requests/${"x".repeat(400)}`);
  assert.equal(long.length, MERCHANT_PAGE_CONTEXT_MAX);
  assert.ok(long.endsWith("…"));
  for (const guide of MERCHANT_PAGE_GUIDES) {
    assert.ok(merchantPageContext(guide.prefix).length <= MERCHANT_PAGE_CONTEXT_MAX, guide.prefix);
  }
});

test("every guide has 2–4 short, unique suggestions when it has any", () => {
  const prefixes = new Set<string>();
  for (const guide of MERCHANT_PAGE_GUIDES) {
    assert.ok(!prefixes.has(guide.prefix), `duplicate ${guide.prefix}`);
    prefixes.add(guide.prefix);
    if (!guide.suggestions) continue;
    assert.ok(guide.suggestions.length >= 2 && guide.suggestions.length <= 4, guide.prefix);
    assert.equal(new Set(guide.suggestions).size, guide.suggestions.length, guide.prefix);
    for (const suggestion of guide.suggestions) assert.ok(suggestion.length <= 45, suggestion);
  }
});
