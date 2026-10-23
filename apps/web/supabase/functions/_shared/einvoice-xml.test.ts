import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVietnamEInvoiceXml } from "./einvoice-xml.ts";

// Mẫu 1 — đúng chuẩn TCT, có namespace prefix.
const NAMESPACED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ns0:HDon xmlns:ns0="http://www.w3.org/2001/XMLSchema-instance">
  <ns0:DLHDon>
    <ns0:TTChung>
      <ns0:KHMSHDon>1</ns0:KHMSHDon>
      <ns0:KHHDon>C26TAA</ns0:KHHDon>
      <ns0:SHDon>0000001</ns0:SHDon>
      <ns0:NLap>2026-09-30</ns0:NLap>
    </ns0:TTChung>
    <ns0:NDHDon>
      <ns0:NBan>
        <ns0:Ten>CÔNG TY TNHH GREEN SM</ns0:Ten>
        <ns0:MST>0301234567</ns0:MST>
      </ns0:NBan>
      <ns0:TToan>
        <ns0:TgTCThue>10000000</ns0:TgTCThue>
        <ns0:TgTThue>800000</ns0:TgTThue>
        <ns0:TgTTTBSo>10800000</ns0:TgTTTBSo>
      </ns0:TToan>
      <ns0:DSHHDVu>
        <ns0:HHDVu>
          <ns0:THHDVu>Chi phí vận chuyển</ns0:THHDVu>
          <ns0:DVTinh>tháng</ns0:DVTinh>
          <ns0:SLuong>1</ns0:SLuong>
          <ns0:DGia>10000000</ns0:DGia>
          <ns0:ThTien>10000000</ns0:ThTien>
          <ns0:TSuat>8</ns0:TSuat>
        </ns0:HHDVu>
      </ns0:DSHHDVu>
    </ns0:NDHDon>
  </ns0:DLHDon>
</ns0:HDon>`;

// Mẫu 2 — không namespace, số dùng dấu chấm nghìn, 2 dòng, TSuat có %.
const NO_NAMESPACE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon>
    <TTChung>
      <KHMSHDon>1</KHMSHDon>
      <KHHDon>AA/26E</KHHDon>
      <SHDon>123</SHDon>
      <NLap>15/10/2026</NLap>
    </TTChung>
    <NDHDon>
      <NBan>
        <Ten>CÔNG TY ĐIỆN LỰC BÌNH PHÚ</Ten>
        <MST>0309999999</MST>
      </NBan>
      <TToan>
        <TgTCThue>1.050.000</TgTCThue>
        <TgTThue>84.000</TgTThue>
        <TgTTTBSo>1.134.000</TgTTTBSo>
      </TToan>
      <DSHHDVu>
        <HHDVu>
          <THHDVu>Điện</THHDVu>
          <DVTinh>kWh</DVTinh>
          <SLuong>100</SLuong>
          <DGia>10.000</DGia>
          <ThTien>1.000.000</ThTien>
          <TSuat>8%</TSuat>
        </HHDVu>
        <HHDVu>
          <THHDVu>Phí cố định</THHDVu>
          <DVTinh>tháng</DVTinh>
          <SLuong>1</SLuong>
          <DGia>50.000</DGia>
          <ThTien>50.000</ThTien>
          <TSuat>8%</TSuat>
        </HHDVu>
      </DSHHDVu>
    </NDHDon>
  </DLHDon>
</HDon>`;

// Mẫu 3 — biến thể không namespace, tổng lấy từ TgTTTBTr, XML declaration + attr.
const COMPACT_XML = `<?xml version="1.0"?>
<HDon version="2.0">
  <DLHDon>
    <TTChung>
      <KHHDon>BB/26E</KHHDon>
      <SHDon>0000123</SHDon>
      <NLap>20261019</NLap>
    </TTChung>
    <NDHDon>
      <NBan>
        <Ten>ANH HẢI</Ten>
        <MST>0312345678</MST>
      </NBan>
      <TToan>
        <TgTCThue>28000000</TgTCThue>
        <TgTThue>0</TgTThue>
        <TgTTTBTr>28000000</TgTTTBTr>
      </TToan>
      <DSHHDVu>
        <HHDVu>
          <THHDVu>Thuê nhà</THHDVu>
          <DVTinh>tháng</DVTinh>
          <SLuong>1</SLuong>
          <DGia>28000000</DGia>
          <ThTien>28000000</ThTien>
          <TSuat>0</TSuat>
        </HHDVu>
      </DSHHDVu>
    </NDHDon>
  </DLHDon>
</HDon>`;

test("đọc hóa đơn có namespace prefix", () => {
  const invoice = parseVietnamEInvoiceXml(NAMESPACED_XML);
  assert.ok(invoice);
  assert.equal(invoice.seller.name, "CÔNG TY TNHH GREEN SM");
  assert.equal(invoice.seller.tax_code, "0301234567");
  assert.equal(invoice.invoice_number, "0000001");
  assert.equal(invoice.invoice_series, "C26TAA");
  assert.equal(invoice.invoice_date, "2026-09-30");
  assert.equal(invoice.subtotal, 10000000);
  assert.equal(invoice.vat, 800000);
  assert.equal(invoice.total, 10800000);
  assert.equal(invoice.lines.length, 1);
  assert.deepEqual(
    {
      name: invoice.lines[0].name,
      unit: invoice.lines[0].unit,
      quantity: invoice.lines[0].quantity,
      unitPrice: invoice.lines[0].unitPrice,
      amount: invoice.lines[0].amount,
      vatRate: invoice.lines[0].vatRate,
    },
    {
      name: "Chi phí vận chuyển",
      unit: "tháng",
      quantity: 1,
      unitPrice: 10000000,
      amount: 10000000,
      vatRate: 8,
    },
  );
});

test("đọc hóa đơn không namespace, số có dấu chấm nghìn", () => {
  const invoice = parseVietnamEInvoiceXml(NO_NAMESPACE_XML);
  assert.ok(invoice);
  assert.equal(invoice.seller.name, "CÔNG TY ĐIỆN LỰC BÌNH PHÚ");
  assert.equal(invoice.seller.tax_code, "0309999999");
  assert.equal(invoice.invoice_date, "2026-10-15");
  assert.equal(invoice.subtotal, 1050000);
  assert.equal(invoice.vat_amount, 84000);
  assert.equal(invoice.total_amount, 1134000);
  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.lines[0].quantity, 100);
  assert.equal(invoice.lines[0].unitPrice, 10000);
  assert.equal(invoice.lines[0].line_total, 1000000);
  assert.equal(invoice.lines[0].vat_rate, 8);
});

test("đọc biến thể nén, tổng lấy từ TgTTTBTr", () => {
  const invoice = parseVietnamEInvoiceXml(COMPACT_XML);
  assert.ok(invoice);
  assert.equal(invoice.seller.name, "ANH HẢI");
  assert.equal(invoice.invoice_number, "0000123");
  assert.equal(invoice.invoice_series, "BB/26E");
  assert.equal(invoice.invoice_date, "2026-10-19");
  assert.equal(invoice.subtotal, 28000000);
  assert.equal(invoice.vat, 0);
  assert.equal(invoice.total, 28000000);
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].name, "Thuê nhà");
  assert.equal(invoice.lines[0].vatRate, 0);
});

test("XML hỏng hoặc không phải hóa đơn trả null, không ném lỗi", () => {
  assert.equal(parseVietnamEInvoiceXml(""), null);
  assert.equal(parseVietnamEInvoiceXml("not xml at all"), null);
  assert.equal(parseVietnamEInvoiceXml("<HDon><DLHDon><TTChung>"), null);
  assert.equal(parseVietnamEInvoiceXml("<root><foo>bar</foo></root>"), null);
});
