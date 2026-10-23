import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  buildTraceWorkbook,
  buildTraceZip,
  formatTraceDate,
  lotsToRows,
  qtyWithUnit,
  type KhoTraceReport,
  type TraceLot,
  type TraceMaterial,
} from "./kho-trace.ts";

function lot(overrides: Partial<TraceLot>): TraceLot {
  return {
    receipt_number: "PN-2026-001",
    received_date: "2026-09-29",
    quantity: 100,
    unit: "kg",
    manufacture_date: "2026-09-08",
    expiry_date: "2026-12-08",
    manufacturer_lot: "LOT-001",
    lot_code: "LOT-001",
    lot_code_internal: false,
    manufacturer_id: "00000000-0000-0000-0000-000000000001",
    manufacturer_name: "Cty TNHH Interflour Vietnam",
    supplier_name: "NCC Bột mì",
    ...overrides,
  };
}

function rawMaterial(
  name: string,
  itemCode: string,
  requiredQty: number,
  unit: string,
  lots: TraceLot[],
  missing: TraceMaterial["missing"] = [],
): TraceMaterial {
  return {
    item_id: `item-${itemCode}`,
    item_code: itemCode,
    name,
    section: "raw",
    required_qty: requiredQty,
    unit,
    lots,
    missing,
  };
}

function packagingMaterial(
  name: string,
  itemCode: string,
  requiredQty: number,
  unit: string,
  lots: TraceLot[],
): TraceMaterial {
  return {
    item_id: `item-${itemCode}`,
    item_code: itemCode,
    name,
    section: "packaging",
    required_qty: requiredQty,
    unit,
    lots,
    missing: [],
  };
}

const rawMaterials: TraceMaterial[] = [
  rawMaterial("Bột mì 888 Orange", "NL-BOTMI", 250, "kg", [
    lot({ manufacturer_lot: "M829092026", lot_code: "M829092026" }),
    lot({
      receipt_number: "PN-2026-002",
      received_date: "2026-09-20",
      quantity: 100,
      manufacturer_lot: "M829092027",
      lot_code: "M829092027",
    }),
  ]),
  rawMaterial("Đường", "NL-DUONG", 250, "kg", [lot({
    receipt_number: "PN-2026-003",
    received_date: "2026-08-28",
    quantity: 250,
    manufacturer_lot: "DU28082026",
    lot_code: "DU28082026",
    manufacturer_name: "Cty CP Đường Quảng Ngãi",
  })]),
  rawMaterial("Trứng gà", "NL-TRUNG", 200, "quả", [lot({
    receipt_number: "PN-2026-004",
    received_date: "2026-10-06",
    quantity: 200,
    unit: "quả",
    manufacturer_lot: "TG06102026",
    lot_code: "TG06102026",
    manufacturer_name: "Cty SX Thương Mại Thực phẩm Khang Thịnh Phát",
  })]),
  rawMaterial("Bơ", "NL-BO", 100, "kg", [lot({
    receipt_number: "PN-2026-005",
    received_date: "2026-10-06",
    quantity: 100,
    manufacturer_lot: "BH06102026",
    lot_code: "BH06102026",
    manufacturer_name: "Cty SữaTH True Milk",
  })]),
  rawMaterial("Muối", "NL-MUOI", 200, "kg", [lot({
    receipt_number: "PN-2026-006",
    received_date: "2026-09-11",
    quantity: 200,
    manufacturer_lot: "MU011092026",
    lot_code: "MU011092026",
    manufacturer_name: "Cty SX TMDV Muối Iod Thành Phát",
  })]),
  rawMaterial("Men", "NL-MEN", 10, "kg", [lot({
    receipt_number: "PN-2026-007",
    received_date: "2026-09-16",
    quantity: 10,
    manufacturer_lot: "ME16092026",
    lot_code: "ME16092026",
    manufacturer_name: "Cty TNHH Xay Lúa Mì Việt Nam",
  })]),
  rawMaterial("Kem sữa whipping", "NL-KEM", 3, "lít", [lot({
    receipt_number: "PN-2026-008",
    received_date: "2026-09-12",
    quantity: 3,
    unit: "lít",
    manufacturer_lot: "KS120092026",
    lot_code: "KS120092026",
    manufacturer_name: "Cty TNHH Đại Tân Việt - The Tatua Co-operative Dairy",
  })]),
  rawMaterial("Bột Sữa", "NL-BOTSUA", 25, "kg", [lot({
    receipt_number: "PN-2026-009",
    received_date: "2026-08-02",
    quantity: 25,
    manufacturer_lot: "SB02082026",
    lot_code: "SB02082026",
    manufacturer_name: "Cty TNHH Đại Tân Việt - Fonterra New Zealand",
  })]),
  rawMaterial("Phụ gia Bánh mì ngọt", "NL-PHUGA", 1, "kg", [lot({
    receipt_number: "PN-2026-010",
    received_date: "2026-09-16",
    quantity: 1,
    manufacturer_lot: "P16092026",
    lot_code: "P16092026",
    manufacturer_name: "Cty TNHH AB Mauri Vietnam",
  })]),
  rawMaterial(
    "Phô mai Diary",
    "NL-PHOMAI",
    4,
    "kg",
    [],
    ["lot", "manufacturer", "nsx", "hsd", "receipt"],
  ),
];

const packagingMaterials: TraceMaterial[] = [
  packagingMaterial("Túi OPP", "BB-TUIOPP", 10, "kg", [lot({
    receipt_number: "PN-2026-011",
    received_date: "2026-06-18",
    quantity: 10,
    manufacturer_lot: "TU18062026",
    lot_code: "TU18062026",
    manufacturer_name: "Cty TNHH Sản xuất-Thương mại Minh Sang",
    supplier_name: "Cty TNHH Sản xuất-Thương mại Minh Sang",
  })]),
  packagingMaterial("Nhãn sản phẩm", "BB-NHAN", 197, "nhãn", [lot({
    receipt_number: "PN-2026-012",
    received_date: "2026-09-15",
    quantity: 197,
    unit: "nhãn",
    manufacturer_lot: "NH15092026",
    lot_code: "NH15092026",
    manufacturer_name: "In Ấn Hoàng Tuấn",
  })]),
  packagingMaterial("Tem sản phẩm", "BB-TEM", 20000, "tem", [lot({
    receipt_number: "PN-2026-013",
    received_date: "2026-10-02",
    quantity: 20000,
    unit: "tem",
    manufacturer_lot: "Tự in theo đơn hàng",
    lot_code: "Tự in theo đơn hàng",
    manufacturer_name: "Công ty TNHH TMDV Nam Nguyễn",
  })]),
  packagingMaterial("Gói hút ẩm", "BB-HUTAM", 30, "bịch", [lot({
    receipt_number: "PN-2026-014",
    received_date: "2026-09-13",
    quantity: 30,
    unit: "bịch",
    manufacturer_lot: "HA13092026",
    lot_code: "HA13092026",
    manufacture_date: "2026-09-06",
    expiry_date: "2028-09-06",
    manufacturer_name: "Công ty TNHH Thịnh Phong",
  })]),
];

const report: KhoTraceReport = {
  production_order_item_id: "poi-001",
  product_name: "Bánh Mì Phô Mai (90gr)",
  sku_code: "VPM-BANHMI-PHOMAI",
  production_number: "SX-20261012-001",
  production_date: "2026-10-12",
  qty: 600,
  unit: "cái",
  shelf_life_days: 2,
  expiry_date: "2026-10-14",
  missing: [],
  materials: [...rawMaterials, ...packagingMaterials],
  certificates: [],
  company_certificates: [],
  semi_finished: [
    {
      name: "Lô bánh ủ",
      production_date: "2026-10-12",
      qty: 600,
      remaining: 0,
      lot_code: "VPM12102026 Ủ",
    },
    {
      name: "Vỏ bánh",
      production_date: "2026-10-12",
      qty: 600,
      remaining: 4,
      lot_code: "VPM12102026",
    },
  ],
};

test("formatTraceDate / qtyWithUnit follow the template", () => {
  assert.equal(formatTraceDate("2026-10-12", "header"), "12.10.2026");
  assert.equal(formatTraceDate("2026-10-12", "cell"), "2026-10-12");
  assert.equal(formatTraceDate(null, "cell"), "");
  assert.equal(formatTraceDate("31/02/2026", "cell"), "");

  assert.equal(qtyWithUnit(250, "kg"), "250kg");
  assert.equal(qtyWithUnit(600, "cái"), "600 cái");
  assert.equal(qtyWithUnit(20000, "tem"), "20.000 tem");
  assert.equal(qtyWithUnit(null, "kg"), "chưa có");
});

test("lotsToRows joins multiple lots and fills missing fields with 'chưa có'", () => {
  const first = lotsToRows(rawMaterials[0], 1);
  assert.equal(first.index, 1);
  assert.equal(first.received_date, "2026-09-29; 2026-09-20");
  assert.equal(first.quantity, "100kg; 100kg");
  assert.equal(first.lot_code, "M829092026; M829092027");

  const missing = lotsToRows(rawMaterials[9], 10);
  assert.equal(missing.manufacturer, "chưa có");
  assert.equal(missing.received_date, "chưa có");
  assert.equal(missing.quantity, "chưa có");
  assert.equal(missing.manufacture_date, "chưa có");
  assert.equal(missing.expiry_date, "chưa có");
  assert.equal(missing.lot_code, "chưa có");
});

test("buildTraceWorkbook reproduces the KFM 'BC truy xuat' layout", async () => {
  const buffer = await buildTraceWorkbook(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const worksheet = workbook.getWorksheet("BC truy xuat");
  assert.ok(worksheet, "worksheet 'BC truy xuat' is required");

  assert.equal(worksheet.getCell("B1").value, "BÁO CÁO TRUY XUẤT SẢN PHẨM");
  assert.equal(worksheet.getCell("B3").value, "TÊN SẢN PHẨM");
  assert.equal(worksheet.getCell("C3").value, "Bánh Mì Phô Mai (90gr)");
  assert.equal(worksheet.getCell("E3").value, "NSX: ");
  assert.equal(worksheet.getCell("F3").value, "12.10.2026");
  assert.equal(worksheet.getCell("G3").value, "HSD:");
  assert.equal(worksheet.getCell("H3").value, "14.10.2026");
  assert.equal(worksheet.getCell("B4").value, "Số lượng:");
  assert.equal(worksheet.getCell("C4").value, "600 cái");

  // I. Nguyên liệu (10 rows, then one blank row).
  assert.equal(worksheet.getCell("A6").value, "I.");
  assert.equal(worksheet.getCell("B6").value, "Nguyên liệu");
  assert.equal(worksheet.getCell("C6").value, "Nhà sản xuất");
  assert.equal(worksheet.getCell("D6").value, "Ngày nhập");
  assert.equal(worksheet.getCell("E6").value, "Số lượng nhập (ĐVT)");
  assert.equal(worksheet.getCell("F6").value, "NSX");
  assert.equal(worksheet.getCell("G6").value, "HSD");
  assert.equal(worksheet.getCell("H6").value, "Mã lô NVL");
  assert.equal(worksheet.getCell("A7").value, 1);
  assert.equal(worksheet.getCell("B7").value, "Bột mì 888 Orange");
  assert.equal(worksheet.getCell("D7").value, "2026-09-29; 2026-09-20");
  assert.equal(worksheet.getCell("H7").value, "M829092026; M829092027");
  assert.equal(worksheet.getCell("A16").value, 10);
  assert.equal(worksheet.getCell("B16").value, "Phô mai Diary");
  assert.equal(worksheet.getCell("F16").value, "chưa có");
  assert.equal(worksheet.getCell("H16").value, "chưa có");

  // II. Bao bì (4 rows).
  assert.equal(worksheet.getCell("A18").value, "II.");
  assert.equal(worksheet.getCell("B18").value, "Bao bì");
  assert.equal(worksheet.getCell("C18").value, "Nhà sản xuất");
  assert.equal(worksheet.getCell("D18").value, "Ngày nhập");
  assert.equal(worksheet.getCell("E18").value, "Số lượng nhập");
  assert.equal(worksheet.getCell("F18").value, "NSX");
  assert.equal(worksheet.getCell("G18").value, "HSD");
  assert.equal(worksheet.getCell("H18").value, "Mã lô NVL");
  assert.equal(worksheet.getCell("A22").value, 4);
  assert.equal(worksheet.getCell("B22").value, "Gói hút ẩm");

  // III. Bán thành phẩm (2 rows).
  assert.equal(worksheet.getCell("A24").value, "III");
  assert.equal(worksheet.getCell("B24").value, "Bán thành phẩm");
  assert.equal(worksheet.getCell("C24").value, "Ngày sản xuất");
  assert.equal(worksheet.getCell("D24").value, "Số lượng SX");
  assert.equal(worksheet.getCell("E24").value, "Số lượng tồn ( sau giao )");
  assert.equal(worksheet.getCell("F24").value, "Mã lô");
  assert.equal(worksheet.getCell("A25").value, 1);
  assert.equal(worksheet.getCell("B25").value, "Lô bánh ủ");
  assert.equal(worksheet.getCell("C25").value, "2026-10-12");
  assert.equal(worksheet.getCell("D25").value, "600 cái");
  assert.equal(worksheet.getCell("E25").value, "0 cái");
  assert.equal(worksheet.getCell("F25").value, "VPM12102026 Ủ");
  assert.equal(worksheet.getCell("B26").value, "Vỏ bánh");
  assert.equal(worksheet.getCell("E26").value, "4 cái");
  assert.equal(worksheet.getCell("F26").value, "VPM12102026");
});

test("buildTraceZip bundles report.xlsx, report.pdf and certificate files", async () => {
  const xlsx = await buildTraceWorkbook(report);
  const pdf = new TextEncoder().encode("%PDF-1.4\n% trace\n").buffer as ArrayBuffer;
  const certificateFiles = [
    { name: "giay-attp.pdf", data: new TextEncoder().encode("attp").buffer as ArrayBuffer },
    { name: "coa.pdf", data: new TextEncoder().encode("coa").buffer as ArrayBuffer },
  ];

  const blob = await buildTraceZip(report, { xlsx, pdf, certificateFiles });
  assert.equal(blob.type, "application/zip");

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.ok(zip.file("report.xlsx"), "report.xlsx is required");
  assert.ok(zip.file("report.pdf"), "report.pdf is required");
  assert.ok(zip.file("giay-attp.pdf"), "certificate file names must be kept");
  assert.ok(zip.file("coa.pdf"), "all certificate files must be added");
  assert.match(await zip.file("report.pdf")!.async("string"), /%PDF/);
});
