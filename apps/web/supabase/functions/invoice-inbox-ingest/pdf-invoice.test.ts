import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BMQ_TAX_CODE,
  looksLikeInvoiceText,
  normalizePdfDate,
  normalizePdfInvoice,
  parsePdfNumber,
  validatePdfInvoice,
} from "./pdf-invoice.ts";

const MAB_TEXT = readFileSync(
  new URL("./fixtures/pdf-text-mab-1037992.txt", import.meta.url),
  "utf8",
);
const VIETTEL_TEXT = readFileSync(
  new URL("./fixtures/pdf-text-viettel-6016614.txt", import.meta.url),
  "utf8",
);

const VALID = {
  seller_name: "CÔNG TY TNHH MM MEGA MARKET (VIỆT NAM)",
  seller_tax_code: "0302249586",
  buyer_tax_code: "0311840107",
  invoice_number: "1037992",
  invoice_series: "1C26MAB",
  invoice_date: "2026-10-21",
  subtotal: 1317651,
  vat_amount: 66433,
  total_amount: 1384084,
  lines: [],
};

test("looksLikeInvoiceText: nhận hoá đơn MAB và Viettel", () => {
  assert.equal(looksLikeInvoiceText(MAB_TEXT), true);
  assert.equal(looksLikeInvoiceText(VIETTEL_TEXT), true);
});

test("looksLikeInvoiceText: bản không dấu vẫn nhận", () => {
  assert.equal(looksLikeInvoiceText("HOA DON GTGT - Ma so thue: 0302249586"), true);
  assert.equal(looksLikeInvoiceText("SERVICE INVOICE - Tax code: 0302249586"), true);
});

test("looksLikeInvoiceText: catalogue không phải hoá đơn", () => {
  assert.equal(looksLikeInvoiceText("LỜI TRỊ ÂN GỬI QUÝ ĐỐI TÁC"), false);
  assert.equal(looksLikeInvoiceText("HÓA ĐƠN GTGT nhưng không có thông tin bên bán"), false);
  assert.equal(looksLikeInvoiceText("Mã số thuế: 0302249586 nhưng không có tiêu đề"), false);
});

test("parsePdfNumber: kiểu Việt Nam và kiểu phẩy nghìn", () => {
  assert.equal(parsePdfNumber("1.234.567"), 1234567);
  assert.equal(parsePdfNumber("1,234,567"), 1234567);
  assert.equal(parsePdfNumber("1.384.084"), 1384084);
  assert.equal(parsePdfNumber("0,204"), 0.204);
  assert.equal(parsePdfNumber("10,016"), 10.016);
  assert.equal(parsePdfNumber("1.234,56"), 1234.56);
  assert.equal(parsePdfNumber("1,234,567.89"), 1234567.89);
  assert.equal(parsePdfNumber(1234.5), 1234.5);
  assert.equal(parsePdfNumber(""), null);
  assert.equal(parsePdfNumber(null), null);
  assert.equal(parsePdfNumber("không có số"), null);
});

test("normalizePdfDate: dd/mm/yyyy và yyyy-mm-dd", () => {
  assert.equal(normalizePdfDate("21/10/2026"), "2026-10-21");
  assert.equal(normalizePdfDate("21-10-2026"), "2026-10-21");
  assert.equal(normalizePdfDate("21.10.2026"), "2026-10-21");
  assert.equal(normalizePdfDate("2026-10-21"), "2026-10-21");
  assert.equal(normalizePdfDate("21/10/2026 08:21"), "2026-10-21");
  assert.equal(normalizePdfDate("Ngày 21 tháng 10 năm 2026"), "2026-10-21");
  assert.equal(normalizePdfDate("31/02/2026"), null);
  assert.equal(normalizePdfDate(""), null);
});

test("normalizePdfInvoice: chuyển số, ngày và mã số thuế", () => {
  const inv = normalizePdfInvoice({
    seller_name: "  CÔNG TY TNHH MM MEGA MARKET (VIỆT NAM)  ",
    seller_tax_code: "0311 840 107",
    buyer_tax_code: "0302-249-586",
    invoice_number: "1037992",
    invoice_series: "1C26MAB",
    invoice_date: "21/10/2026",
    subtotal: "1.317.651",
    vat_amount: "66.433",
    total_amount: "1.384.084",
    lines: [
      {
        name: " GAN HEO ",
        unit: "KY",
        quantity: "10,016",
        unit_price: "116.393",
        amount: "982.000",
        vat_rate: "5",
      },
    ],
  });

  assert.equal(inv.seller_name, "CÔNG TY TNHH MM MEGA MARKET (VIỆT NAM)");
  assert.equal(inv.seller_tax_code, "0311840107");
  assert.equal(inv.buyer_tax_code, "0302249586");
  assert.equal(inv.invoice_date, "2026-10-21");
  assert.equal(inv.subtotal, 1317651);
  assert.equal(inv.vat_amount, 66433);
  assert.equal(inv.total_amount, 1384084);
  assert.equal(inv.lines.length, 1);
  assert.equal(inv.lines[0].name, "GAN HEO");
  assert.equal(inv.lines[0].quantity, 10.016);
  assert.equal(inv.lines[0].unit_price, 116393);
  assert.equal(inv.lines[0].amount, 982000);
  assert.equal(inv.lines[0].vat_rate, 5);
});

test("normalizePdfInvoice: object rỗng trả null, không ném", () => {
  const inv = normalizePdfInvoice({});
  assert.equal(inv.seller_name, null);
  assert.equal(inv.total_amount, null);
  assert.deepEqual(inv.lines, []);
});

test("validatePdfInvoice: hoá đơn hợp lệ", () => {
  assert.deepEqual(validatePdfInvoice(VALID), { ok: true });
});

test("validatePdfInvoice: not_invoice", () => {
  assert.deepEqual(validatePdfInvoice(null), { ok: false, reason: "not_invoice" });
});

test("validatePdfInvoice: no_total", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, total_amount: null }),
    { ok: false, reason: "no_total" },
  );
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, total_amount: 0 }),
    { ok: false, reason: "no_total" },
  );
});

test("validatePdfInvoice: amount_mismatch", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, total_amount: 1384086 }),
    { ok: false, reason: "amount_mismatch" },
  );
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, total_amount: 1384084 + 2 }),
    { ok: false, reason: "amount_mismatch" },
  );
});

test("validatePdfInvoice: bad_tax_code", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, seller_tax_code: "030224958" }),
    { ok: false, reason: "bad_tax_code" },
  );
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, seller_tax_code: null }),
    { ok: false, reason: "bad_tax_code" },
  );
});

test("validatePdfInvoice: buyer_is_seller", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, seller_tax_code: BMQ_TAX_CODE }),
    { ok: false, reason: "buyer_is_seller" },
  );
});

test("validatePdfInvoice: chấp nhận MST 13 số", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, seller_tax_code: "0311840107001" }),
    { ok: true },
  );
});

test("validatePdfInvoice: sai lệch 1 đồng vẫn chấp nhận", () => {
  assert.deepEqual(
    validatePdfInvoice({ ...VALID, total_amount: 1384085 }),
    { ok: true },
  );
  assert.deepEqual(
    validatePdfInvoice({
      ...VALID,
      subtotal: 1317651,
      vat_amount: 66434,
      total_amount: 1384085,
    }),
    { ok: true },
  );
});
