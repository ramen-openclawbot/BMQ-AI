import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSupplierOrderEmail,
  buildSupplierOrderEmailLines,
  escapeHtml,
  formatQuantity,
  formatVnd,
} from "./supplier-order-email.ts";

const baseInput = {
  poNumber: "PO-2026-001",
  supplierName: "TV Food",
  productName: "Bơ Peerless",
  quantity: 25,
  unit: "kg",
  unitPrice: 90000,
  lineTotal: 2250000,
  deliveryAddress: "123 Nguyễn Văn A, Quận 1, TP.HCM",
  contactName: "Anh Minh",
  contactPhone: "0909 123 456",
  note: "Giao trong giờ hành chính",
  requestedDate: "2026-10-25",
  uploadUrl: "https://ai.banhmique.vn/ncc/hoa-don/token-abc",
};

test("formats Vietnamese money and quantities", () => {
  assert.equal(formatVnd(1234567), "1.234.567 đ");
  assert.equal(formatVnd(0), "0 đ");
  assert.equal(formatVnd(null), "0 đ");
  assert.equal(formatQuantity(25), "25");
  assert.equal(formatQuantity(1.5), "1,5");
  assert.equal(formatQuantity(1000), "1.000");
  assert.equal(formatQuantity(1.23456), "1,235");
});

test("escapes every interpolated HTML value", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'test'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;test&#39;",
  );

  const email = buildSupplierOrderEmail({
    ...baseInput,
    supplierName: `<b>TV Food</b>`,
    productName: `Bơ & "Peerless" <script>`,
    deliveryAddress: `<img src=x onerror=alert(1)>`,
    note: `<iframe>`,
  });

  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<iframe>"));
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(email.html.includes("&lt;script&gt;"));
  assert.ok(email.html.includes("Bơ &amp; &quot;Peerless&quot;"));
});

test("builds the exact Vietnamese subject", () => {
  const email = buildSupplierOrderEmail(baseInput);
  assert.equal(
    email.subject,
    "BMQ đặt hàng PO-2026-001 – Bơ Peerless",
  );
});

test("includes the upload link in both text and HTML", () => {
  const email = buildSupplierOrderEmail(baseInput);
  assert.ok(email.text.includes(baseInput.uploadUrl));
  assert.ok(email.html.includes(`href="${baseInput.uploadUrl}"`));
  assert.ok(email.text.includes("hóa đơn / phiếu giao hàng"));
  assert.ok(email.html.includes("hóa đơn / phiếu giao hàng"));
});

test("renders one order table, delivery details, totals and reply note", () => {
  const email = buildSupplierOrderEmail(baseInput);
  assert.ok(email.text.includes("Kính gửi TV Food,"));
  assert.ok(email.text.includes("Tên hàng | Số lượng | Đơn vị | Đơn giá | Thành tiền"));
  assert.ok(email.text.includes("25 | kg | 90.000 đ | 2.250.000 đ"));
  assert.ok(email.text.includes("Tổng cộng: 2.250.000 đ"));
  assert.ok(email.text.includes("Ngày đặt hàng: 25/10/2026"));
  assert.ok(email.text.includes("Vui lòng trả lời (reply) email này"));

  assert.ok(email.html.includes("Tổng cộng"));
  assert.ok(email.html.includes("2.250.000 đ"));
  assert.ok(email.html.includes("25/10/2026"));
  assert.ok(email.html.includes("123 Nguyễn Văn A"));
  assert.ok(email.html.includes("Anh Minh"));
  assert.ok(email.html.includes("0909 123 456"));
  assert.ok(email.html.includes("Mã số thuế: 0311840107"));
  assert.ok(email.html.includes("max-width:640px"));
});

test("omits the optional note row when empty", () => {
  const email = buildSupplierOrderEmail({ ...baseInput, note: "" });
  assert.ok(!email.text.includes("Ghi chú:"));
  assert.ok(!email.html.includes("Ghi chú"));
});

test("renders two lines and a total row", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "PO-2026-002",
    lines: [
      {
        productName: "Bột mì 999 Cam",
        quantity: 25,
        unit: "kg",
        unitPrice: 19300,
        lineTotal: 482500,
      },
      {
        productName: "Bột mì 888 Cam",
        quantity: 50,
        unit: "kg",
        unitPrice: 18296,
        lineTotal: 914800,
      },
    ],
    total: 1397300,
  });

  assert.equal(email.subject, "BMQ đặt hàng PO-2026-002 – TV Food");
  assert.ok(
    email.text.includes(
      "Bột mì 999 Cam | 25 | kg | 19.300 đ | 482.500 đ\nBột mì 888 Cam | 50 | kg | 18.296 đ | 914.800 đ",
    ),
  );
  assert.ok(email.text.includes("Tổng cộng: 1.397.300 đ"));
  assert.ok(email.html.includes("Bột mì 999 Cam"));
  assert.ok(email.html.includes("Bột mì 888 Cam"));
  assert.ok(email.html.includes("1.397.300 đ"));
});

test("escapes every multi-line value", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    lines: [
      {
        productName: `<b>Bột mì</b>`,
        quantity: 1,
        unit: `<i>kg</i>`,
        unitPrice: 1,
        lineTotal: 1,
      },
    ],
    total: 1,
    deliveryAddress: `<img src=x onerror=alert(1)>`,
    note: `<iframe>`,
    supplierName: `<script>`,
  });

  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<iframe>"));
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(!email.html.includes("<b>Bột mì</b>"));
  assert.ok(email.html.includes("&lt;b&gt;Bột mì&lt;/b&gt;"));
});

test("preview keeps a PO and upload placeholder", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "",
    uploadUrl: "",
    lines: [
      {
        productName: "Bơ Peerless",
        quantity: 25,
        unit: "kg",
        unitPrice: 90000,
        lineTotal: 2250000,
      },
    ],
    total: 2250000,
  });

  assert.ok(email.subject.includes("PO mới (số cấp khi gửi)"));
  assert.ok(email.text.includes("PO mới (số cấp khi gửi)"));
  assert.ok(email.html.includes("PO mới (số cấp khi gửi)"));
  assert.ok(!email.html.includes('href=""'));
  assert.ok(email.text.includes("sẽ được gửi kèm"));
  assert.ok(email.html.includes("sẽ được gửi kèm"));
});

test("single-item output keeps the same subject, table and total", () => {
  const single = buildSupplierOrderEmail(baseInput);
  assert.equal(single.subject, "BMQ đặt hàng PO-2026-001 – Bơ Peerless");
  assert.ok(single.text.includes("Bơ Peerless | 25 | kg | 90.000 đ | 2.250.000 đ"));
  assert.ok(single.text.includes("Tổng cộng: 2.250.000 đ"));
  assert.ok(single.html.includes("2.250.000 đ"));
  assert.ok(single.html.includes('href="https://ai.banhmique.vn/ncc/hoa-don/token-abc"'));
});
