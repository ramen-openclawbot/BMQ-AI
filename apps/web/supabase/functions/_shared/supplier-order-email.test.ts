import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSupplierOrderEmail,
  buildSupplierOrderEmailLines,
  escapeHtml,
  formatQuantity,
  formatUnitPrice,
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
  assert.equal(formatUnitPrice(90000), "90.000 đ");
  assert.equal(formatUnitPrice(19296.3), "19.296,30 đ");
  assert.equal(formatUnitPrice(18925.93), "18.925,93 đ");
  assert.equal(formatUnitPrice(140740.74), "140.740,74 đ");
  assert.equal(formatUnitPrice(null), "0 đ");
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

test("renders VAT columns, subtotal, VAT and total rows", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "PO-2026-003",
    lines: [
      {
        productName: "Bột mì 999 Cam",
        quantity: 25,
        unit: "kg",
        unitPrice: 19300,
        lineTotal: 482500,
        vatRate: 8,
      },
      {
        productName: "Bột mì 888 Cam",
        quantity: 25,
        unit: "kg",
        unitPrice: 18900,
        lineTotal: 472500,
        vatRate: 8,
      },
    ],
    subtotal: 955000,
    vatAmount: 76400,
    total: 1031400,
  });

  assert.ok(email.html.includes("% VAT</th>"));
  assert.ok(email.html.includes("8%"));
  assert.ok(email.html.includes('colspan="5"'));
  assert.ok(email.html.includes("Cộng tiền hàng"));
  assert.ok(email.html.includes("Thuế GTGT"));
  assert.ok(email.html.includes("Tổng cộng"));
  assert.ok(email.html.includes("955.000 đ"));
  assert.ok(email.html.includes("76.400 đ"));
  assert.ok(email.html.includes("1.031.400 đ"));

  assert.ok(email.text.includes("Cộng tiền hàng: 955.000 đ"));
  assert.ok(email.text.includes("Thuế GTGT: 76.400 đ"));
  assert.ok(email.text.includes("Tổng cộng: 1.031.400 đ"));
  assert.ok(!email.text.includes("% VAT"));
});

test("renders the ĐH19993 decimal unit prices and totals", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "PO-2026-004",
    supplierName: "Phúc Thịnh",
    lines: [
      {
        productName: "Bột mì 999",
        quantity: 200,
        unit: "kg",
        unitPrice: 19296.3,
        lineTotal: 3859259,
        vatRate: 8,
      },
      {
        productName: "Bột mì 888",
        quantity: 250,
        unit: "kg",
        unitPrice: 18925.93,
        lineTotal: 4731481,
        vatRate: 8,
      },
      {
        productName: "Sữa bột",
        quantity: 25,
        unit: "kg",
        unitPrice: 140740.74,
        lineTotal: 3518519,
        vatRate: 8,
      },
    ],
    subtotal: 12109259,
    vatAmount: 968741,
    total: 13078000,
  });

  assert.ok(
    email.text.includes(
      "Bột mì 999 | 200 | kg | 19.296,30 đ | 3.859.259 đ",
    ),
  );
  assert.ok(
    email.text.includes(
      "Bột mì 888 | 250 | kg | 18.925,93 đ | 4.731.481 đ",
    ),
  );
  assert.ok(
    email.text.includes(
      "Sữa bột | 25 | kg | 140.740,74 đ | 3.518.519 đ",
    ),
  );
  assert.ok(email.html.includes("19.296,30 đ"));
  assert.ok(email.html.includes("18.925,93 đ"));
  assert.ok(email.html.includes("140.740,74 đ"));
  assert.ok(email.text.includes("Cộng tiền hàng: 12.109.259 đ"));
  assert.ok(email.text.includes("Thuế GTGT: 968.741 đ"));
  assert.ok(email.text.includes("Tổng cộng: 13.078.000 đ"));
  // Amount columns stay whole-đồng.
  assert.ok(!email.text.includes("3.859.259,00 đ"));
});

test("keeps whole-number unit prices byte-identical", () => {
  const whole = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "PO-2026-005",
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
  assert.ok(whole.text.includes("Bơ Peerless | 25 | kg | 90.000 đ | 2.250.000 đ"));
  assert.ok(!whole.text.includes("90.000,00 đ"));
  assert.ok(whole.html.includes("90.000 đ"));
  assert.ok(!whole.html.includes("90.000,00 đ"));
});

test("keeps the no-VAT output exactly as before", () => {
  const omitted = buildSupplierOrderEmailLines({
    ...baseInput,
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
  const zero = buildSupplierOrderEmailLines({
    ...baseInput,
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
    subtotal: 2250000,
    vatAmount: 0,
  });

  assert.equal(zero.text, omitted.text);
  assert.equal(zero.html, omitted.html);
  assert.ok(!zero.html.includes("% VAT"));
  assert.ok(!zero.html.includes("Thuế GTGT"));
  assert.ok(zero.html.includes('colspan="4"'));
  assert.ok(zero.text.includes("Tổng cộng: 2.250.000 đ"));
});

test("escapes every value on the VAT path", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    supplierName: `<script>`,
    lines: [
      {
        productName: `<b>Bột mì</b>`,
        quantity: 1,
        unit: `<i>kg</i>`,
        unitPrice: 1,
        lineTotal: 1,
        vatRate: 8,
      },
    ],
    subtotal: 1,
    vatAmount: 1,
    total: 2,
    deliveryAddress: `<img src=x onerror=alert(1)>`,
    note: `<iframe>`,
  });

  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<iframe>"));
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(!email.html.includes("<b>Bột mì</b>"));
  assert.ok(email.html.includes("&lt;b&gt;Bột mì&lt;/b&gt;"));
  assert.ok(email.html.includes("Cộng tiền hàng"));
});

test("renders two delivery blocks with the items going to each warehouse", () => {
  const email = buildSupplierOrderEmailLines({
    ...baseInput,
    poNumber: "PO-2026-006",
    lines: [
      {
        productName: "Bột mì 999 Cam",
        quantity: 25,
        unit: "kg",
        unitPrice: 19300,
        lineTotal: 482500,
      },
      {
        productName: "Bơ Peerless",
        quantity: 10,
        unit: "kg",
        unitPrice: 90000,
        lineTotal: 900000,
      },
    ],
    total: 1382500,
    deliveries: [
      {
        label: "Kho Q7",
        address: "123 Nguyễn Văn A, Quận 1",
        contactName: "Anh Minh",
        contactPhone: "0909 123 456",
        items: ["Bột mì 999 Cam"],
      },
      {
        label: "Kho Tân Tạo",
        address: "Kho Tân Tạo, Bình Tân",
        contactName: "Tú Trinh",
        contactPhone: "0911 222 333",
        items: ["Bơ Peerless"],
      },
    ],
  });

  assert.ok(email.text.includes("Địa chỉ giao hàng"));
  assert.ok(email.text.includes("Kho Q7: 123 Nguyễn Văn A, Quận 1"));
  assert.ok(email.text.includes("Người nhận: Anh Minh - 0909 123 456"));
  assert.ok(email.text.includes("Món giao về đây: Bột mì 999 Cam"));
  assert.ok(email.text.includes("Kho Tân Tạo: Kho Tân Tạo, Bình Tân"));
  assert.ok(email.text.includes("Người nhận: Tú Trinh - 0911 222 333"));
  assert.ok(email.text.includes("Món giao về đây: Bơ Peerless"));

  assert.ok(email.html.includes("Địa chỉ giao hàng"));
  assert.ok(email.html.includes("Kho Q7: 123 Nguyễn Văn A, Quận 1"));
  assert.ok(email.html.includes("Người nhận: Anh Minh - 0909 123 456"));
  assert.ok(email.html.includes("Món giao về đây: Bột mì 999 Cam"));
  assert.ok(email.html.includes("Kho Tân Tạo: Kho Tân Tạo, Bình Tân"));
  assert.ok(email.html.includes("Người nhận: Tú Trinh - 0911 222 333"));
  assert.ok(email.html.includes("Món giao về đây: Bơ Peerless"));
});

test("single-item output keeps the same subject, table and total", () => {
  const single = buildSupplierOrderEmail(baseInput);
  assert.equal(single.subject, "BMQ đặt hàng PO-2026-001 – Bơ Peerless");
  assert.ok(single.text.includes("Bơ Peerless | 25 | kg | 90.000 đ | 2.250.000 đ"));
  assert.ok(single.text.includes("Tổng cộng: 2.250.000 đ"));
  assert.ok(single.html.includes("2.250.000 đ"));
  assert.ok(single.html.includes('href="https://ai.banhmique.vn/ncc/hoa-don/token-abc"'));
});
