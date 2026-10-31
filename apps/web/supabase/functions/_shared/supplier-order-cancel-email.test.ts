import assert from "node:assert/strict";
import test from "node:test";

import { buildSupplierOrderCancelEmail } from "./supplier-order-cancel-email.ts";

const baseInput = {
  poNumber: "PO-2026-001",
  supplierName: "TV Food",
  sentAt: "2026-10-28T03:00:00Z",
  reason: "Nhà cung cấp hết hàng đột xuất",
  lines: [
    { productName: "Bột mì 999 Cam", quantity: 25, unit: "kg" },
    { productName: "Tương ớt Cholimex", quantity: 1.5, unit: "chai" },
  ],
  total: 1250000,
};

test("builds the cancellation subject", () => {
  const email = buildSupplierOrderCancelEmail(baseInput);
  assert.equal(
    email.subject,
    "[HUỶ ĐƠN] BMQ huỷ đơn đặt hàng PO-2026-001 – TV Food",
  );
});

test("writes the cancellation text with date, reason, lines and total", () => {
  const email = buildSupplierOrderCancelEmail(baseInput);
  assert.ok(email.text.startsWith("Kính gửi TV Food,"));
  assert.ok(
    email.text.includes(
      "Công ty CP Thực phẩm BMQ xin HUỶ đơn đặt hàng PO-2026-001 đã gửi ngày 28/10/2026.",
    ),
  );
  assert.ok(email.text.includes("Lý do: Nhà cung cấp hết hàng đột xuất"));
  assert.ok(email.text.includes("• Bột mì 999 Cam: 25 kg"));
  assert.ok(email.text.includes("• Tương ớt Cholimex: 1,5 chai"));
  assert.ok(email.text.includes("Tổng giá trị đơn huỷ: 1.250.000 đ"));
  assert.ok(email.text.includes("Quý công ty vui lòng KHÔNG giao đơn này."));
  assert.ok(email.text.endsWith("Trân trọng,\nCông ty CP Thực phẩm BMQ"));
});

test("escapes every interpolated HTML value", () => {
  const email = buildSupplierOrderCancelEmail({
    ...baseInput,
    poNumber: `PO "<script>"`,
    supplierName: `<b>TV & Food</b>`,
    reason: `Hết <hàng> & "gấp"`,
    lines: [
      { productName: `<img src=x onerror=alert(1)>`, quantity: 2, unit: `<kg>` },
    ],
  });

  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(!email.html.includes("<b>TV"));
  assert.ok(!email.html.includes("<hàng>"));
  assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(email.html.includes("TV &amp; Food"));
  assert.ok(email.html.includes("Hết &lt;hàng&gt; &amp; &quot;gấp&quot;"));
  assert.ok(email.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(email.html.includes("&lt;kg&gt;"));
  assert.ok(email.html.includes("ĐƠN ĐẶT HÀNG ĐÃ BỊ HUỶ"));
});

test("omits the reason line when the reason is empty", () => {
  const email = buildSupplierOrderCancelEmail({ ...baseInput, reason: "   " });
  assert.ok(!email.text.includes("Lý do:"));
  assert.ok(!email.html.includes("Lý do huỷ"));
});
