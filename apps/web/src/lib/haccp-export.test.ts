// Offline tests for the HACCP workbook writer.
// They read the real consultant template and check the output with ExcelJS and
// the raw sheet XML, so a dropped border, merge or column width fails the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  HACCP_EXCEL_FILE_NAME,
  HACCP_ZIP_FOLDERS,
  buildHaccpWorkbook,
  buildHaccpZip,
  haccpCellText,
  safeZipName,
  sanitizeCellValue,
} from "./haccp-export.ts";
import type { HaccpData, HaccpFile } from "./haccp-schema.ts";

const TEMPLATE = fs.readFileSync(new URL("../assets/haccp/haccp-q7-template.xlsx", import.meta.url));

function templateBuffer(): ArrayBuffer {
  return Uint8Array.from(TEMPLATE).buffer;
}

const EMPTY: HaccpData = {
  suppliers: [],
  team: [],
  staff: [],
  measure: [],
  machines: [],
  chemicals: [],
  process: [],
};

const row = (id: string, values: Record<string, string>, files: HaccpFile[] = []) => ({
  id,
  values,
  files,
  by: "Quản lý",
});

const FULL: HaccpData = {
  suppliers: [
    row("s1", {
      name: "Bột mì Hoa Sen",
      items: "Bột mì số 8, bột mì số 13",
      phone: "0900 000 101",
      address: "12 Đường Mẫu, Quận 7",
      contact: "Chị Lan",
    }),
    row("s2", { name: "Bơ Sữa Nam Việt", items: "Bơ lạt", phone: "0900 000 102", address: "Quận 4", contact: "Anh Bình" }),
  ],
  team: [
    row("t1", { name: "Nguyễn Văn An", job: "Quản lý bếp", role: "Đội trưởng" }),
    row("t2", { name: "Trần Thị Bích", job: "Trưởng ca", role: "Giám sát CCP" }),
  ],
  staff: [
    row("p1", { name: "Nguyễn Văn An", position: "Quản lý bếp", department: "Bếp bánh" }),
    row("p2", { name: "Trần Thị Bích", position: "Trưởng ca", department: "Bếp bánh" }),
  ],
  measure: [
    row("m1", {
      name: "Cân điện tử 30 kg",
      code: "CAN-01",
      range: "0 – 30 kg",
      origin: "Việt Nam",
      qty: "2",
      place: "Khu cân",
      calibrated: "Có",
    }),
  ],
  machines: [
    row("c1", {
      name: "Lò nướng xoay",
      symbol: "LO-01",
      qty: "1",
      origin: "Việt Nam",
      spec: "380 V, 2,2 kW",
      year: "2024",
      maintenance: "Tháng 6 và 12",
      note: "Đang dùng",
    }),
  ],
  chemicals: [
    row("h1", { name: "Cồn 70 độ", place: "Bàn sơ chế", purpose: "Sát khuẩn bề mặt", guide: "Không" }),
  ],
  process: [
    row("q1", { step: "Nhận nguyên liệu", owner: "Thủ kho", detail: "Kiểm tra bao bì, hạn dùng" }),
    row("q2", { step: "Nướng", owner: "Trưởng ca", detail: "180 – 200 °C trong 15 phút" }),
  ],
};

const LAYOUT_FILES: HaccpFile[] = [
  { id: "l1", name: "mat-bang-q7.pdf", size: 1200, type: "application/pdf" },
  { id: "l2", name: "khu-nuong.jpg", size: 2200, type: "image/jpeg" },
];

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as never);
  return wb;
}

async function sheetXml(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  return Promise.all(names.map((name) => zip.file(name)!.async("string")));
}

function widths(xml: string): string[] {
  return [...xml.matchAll(/<col[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*width="([^"]+)"/g)]
    .map((m) => `${m[1]}-${m[2]}:${m[3]}`);
}

function merges(xml: string): string[] {
  return [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
}

function cell(ws: ExcelJS.Worksheet, address: string): ExcelJS.Cell {
  return ws.getCell(address);
}

function text(ws: ExcelJS.Worksheet, address: string): string {
  return haccpCellText(cell(ws, address).value);
}

test("empty dossier clears the template's sample rows and keeps the workbook shell", async () => {
  const before = await load(Uint8Array.from(TEMPLATE));
  const bytes = await buildHaccpWorkbook(templateBuffer(), EMPTY, []);
  const after = await load(bytes);

  assert.deepEqual(after.worksheets.map((ws) => ws.name), before.worksheets.map((ws) => ws.name));

  const beforeXml = await sheetXml(Uint8Array.from(TEMPLATE));
  const afterXml = await sheetXml(bytes);
  const beforeMerges = beforeXml.flatMap(merges).sort();
  const afterMerges = afterXml.flatMap(merges).sort();
  assert.deepEqual(afterMerges, beforeMerges);
  assert.ok(afterMerges.includes("A1:I1"));
  assert.ok(afterMerges.includes("A2:C2"));
  assert.ok(afterMerges.includes("B2:F2"));

  const beforeWidths = beforeXml.flatMap(widths).sort();
  const afterWidths = afterXml.flatMap(widths).sort();
  assert.deepEqual(afterWidths, beforeWidths);

  const suppliers = after.getWorksheet("Thông tin NCC")!;
  assert.equal(text(suppliers, "A3"), "");
  assert.equal(text(suppliers, "F3"), "");
  assert.equal(text(suppliers, "F14"), "", "sample item must be gone");
  assert.equal(text(after.getWorksheet("ĐỘI HACCP")!, "A8"), "");
  assert.equal(text(after.getWorksheet("Quy trình sản xuất")!, "A5"), "");
  assert.equal(text(after.getWorksheet("Layout nhà xưởng")!, "E4"), "");
});

test("full dossier fills every sheet in the template's own column order", async () => {
  const bytes = await buildHaccpWorkbook(templateBuffer(), FULL, LAYOUT_FILES);
  const wb = await load(bytes);

  const suppliers = wb.getWorksheet("Thông tin NCC")!;
  assert.equal(suppliers.getCell("A3").value, 1);
  assert.equal(text(suppliers, "B3"), "Bột mì Hoa Sen");
  assert.equal(text(suppliers, "C3"), "0900 000 101");
  assert.equal(text(suppliers, "D3"), "12 Đường Mẫu, Quận 7");
  assert.equal(text(suppliers, "E3"), "Chị Lan");
  assert.equal(text(suppliers, "F3"), "Bột mì số 8, bột mì số 13");
  assert.equal(text(suppliers, "B4"), "Bơ Sữa Nam Việt");

  const people = wb.getWorksheet("ĐỘI HACCP")!;
  assert.equal(people.getCell("A8").value, 1);
  assert.equal(text(people, "B8"), "Nguyễn Văn An");
  assert.equal(text(people, "C8"), "Quản lý bếp");
  assert.equal(text(people, "D8"), "Đội trưởng");
  assert.equal(people.getCell("F8").value, 1);
  assert.equal(text(people, "G8"), "Nguyễn Văn An");
  assert.equal(text(people, "H8"), "Quản lý bếp");
  assert.equal(text(people, "I8"), "Bếp bánh");

  const measure = wb.getWorksheet("Danh sách thiết bị đo lường")!;
  assert.equal(text(measure, "B3"), "Cân điện tử 30 kg");
  assert.equal(text(measure, "C3"), "CAN-01");
  assert.equal(text(measure, "D3"), "0 – 30 kg");
  assert.equal(text(measure, "E3"), "Việt Nam");
  assert.equal(text(measure, "F3"), "2");
  assert.equal(text(measure, "G3"), "Khu cân");
  assert.equal(text(measure, "H3"), "Có");

  const machines = wb.getWorksheet("Danh mục máy móc thiết bị ") ?? wb.worksheets[3];
  assert.equal(text(machines, "B3"), "Lò nướng xoay");
  assert.equal(text(machines, "C3"), "LO-01");
  assert.equal(text(machines, "D3"), "1");
  assert.equal(text(machines, "E3"), "Việt Nam");
  assert.equal(text(machines, "F3"), "380 V, 2,2 kW");
  assert.equal(text(machines, "G3"), "2024");
  assert.equal(text(machines, "H3"), "Tháng 6 và 12");
  assert.equal(text(machines, "I3"), "Đang dùng");

  const chemicals = wb.getWorksheet("Danh muc hoa chat")!;
  assert.equal(text(chemicals, "B5"), "Cồn 70 độ");
  assert.equal(text(chemicals, "C5"), "Bàn sơ chế");
  assert.equal(text(chemicals, "D5"), "Sát khuẩn bề mặt");
  assert.equal(text(chemicals, "E5"), "Không");
  assert.match(text(chemicals, "B4"), /Tên hoá chất/);

  const process = wb.getWorksheet("Quy trình sản xuất")!;
  assert.equal(process.getCell("A5").value, 1);
  assert.equal(text(process, "B5"), "Thủ kho");
  assert.equal(text(process, "C5"), "Nhận nguyên liệu");
  assert.equal(text(process, "D5"), "Kiểm tra bao bì, hạn dùng");

  const layout = wb.getWorksheet("Layout nhà xưởng")!;
  assert.equal(text(layout, "E4"), "mat-bang-q7.pdf");
  assert.equal(text(layout, "E5"), "khu-nuong.jpg");
});

test("rows beyond the template clone the last styled row", async () => {
  const suppliers = Array.from({ length: 30 }, (_, i) =>
    row(`s${i}`, { name: `NCC ${i + 1}`, items: "Hàng", phone: "0900", address: "Q7", contact: "A" }));
  const machines = Array.from({ length: 45 }, (_, i) =>
    row(`m${i}`, { name: `Máy ${i + 1}`, symbol: `M-${i}`, qty: "1", origin: "VN", spec: "220 V", year: "2024", maintenance: "6", note: "" }));
  const team = Array.from({ length: 12 }, (_, i) =>
    row(`t${i}`, { name: `Đội ${i + 1}`, job: "Thợ", role: "Thành viên" }));
  const staff = Array.from({ length: 12 }, (_, i) =>
    row(`p${i}`, { name: `Nhân sự ${i + 1}`, position: "Thợ", department: "Bếp bánh" }));
  const process = Array.from({ length: 12 }, (_, i) =>
    row(`q${i}`, { step: `Bước ${i + 1}`, owner: "Bếp", detail: "Kiểm soát" }));

  const data: HaccpData = { ...EMPTY, suppliers, machines, team, staff, process };
  const bytes = await buildHaccpWorkbook(templateBuffer(), data, []);
  const wb = await load(bytes);

  const s = wb.getWorksheet("Thông tin NCC")!;
  assert.equal(text(s, "B32"), "NCC 30");
  assert.equal(cell(s, "B32").border?.top?.style, "thin");
  assert.equal(cell(s, "B32").font?.name, "Times New Roman");

  const m = wb.getWorksheet("Danh mục máy móc thiết bị ") ?? wb.worksheets[3];
  assert.equal(text(m, "B47"), "Máy 45");
  assert.equal(cell(m, "B47").border?.top?.style, "thin");

  const p = wb.getWorksheet("ĐỘI HACCP")!;
  assert.equal(text(p, "B19"), "Đội 12");
  assert.equal(text(p, "G19"), "Nhân sự 12");
  assert.equal(cell(p, "A19").border?.top?.style, "thin");
  assert.equal(cell(p, "F19").border?.top?.style, "thin");

  const q = wb.getWorksheet("Quy trình sản xuất")!;
  assert.equal(text(q, "C16"), "Bước 12");
  assert.equal(cell(q, "A16").border?.top?.style, "thin");
});

test("formula-looking input is written as text, not as a formula", async () => {
  const data: HaccpData = {
    ...EMPTY,
    suppliers: [row("s1", { name: "=HYPERLINK(\"http://evil\",\"x\")", items: "+1+1", phone: "0900", address: "@SUM(A1)", contact: "-2+2" })],
  };
  assert.equal(sanitizeCellValue("=1+1"), "=1+1");

  const bytes = await buildHaccpWorkbook(templateBuffer(), data, []);
  const wb = await load(bytes);
  const s = wb.getWorksheet("Thông tin NCC")!;

  for (const address of ["B3", "C3", "D3", "E3", "F3"]) {
    const value = cell(s, address).value;
    assert.equal(typeof value, "string", `${address} must stay a string`);
    assert.equal(cell(s, address).type, ExcelJS.ValueType.String, `${address} must be a string cell`);
    assert.equal((cell(s, address) as unknown as { formula?: string }).formula, undefined);
  }
  assert.equal(text(s, "B3"), "=HYPERLINK(\"http://evil\",\"x\")");
  assert.equal(text(s, "D3"), "@SUM(A1)");
  assert.equal(text(s, "E3"), "-2+2");
  assert.equal(text(s, "F3"), "+1+1");
});

test("ZIP contains the workbook and deduplicated, path-safe attachment folders", async () => {
  const bytes = await buildHaccpZip(templateBuffer(), FULL, LAYOUT_FILES, [
    { section: "suppliers", name: "../giay-attp.pdf", bytes: new Uint8Array([1, 2, 3]) },
    { section: "suppliers", name: "giay-attp.pdf", bytes: new Uint8Array([4, 5]) },
    { section: "layout", name: "So do!!.png", bytes: new Uint8Array([6]) },
    { section: "process", name: "quy-trinh.docx", bytes: new Uint8Array([7]) },
  ]);
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file(HACCP_EXCEL_FILE_NAME), "workbook at the ZIP root");

  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const supplierFolder = `${HACCP_ZIP_FOLDERS.suppliers}/`;
  const supplierFiles = names.filter((name) => name.startsWith(supplierFolder));
  assert.equal(supplierFiles.length, 2);
  assert.ok(supplierFiles.every((name) => !name.includes("..")));
  assert.equal(new Set(supplierFiles).size, 2);
  assert.ok(names.includes(`${HACCP_ZIP_FOLDERS.layout}/So-do.png`));
  assert.ok(names.includes(`${HACCP_ZIP_FOLDERS.process}/quy-trinh.docx`));

  const used = new Set<string>();
  assert.equal(safeZipName("a/b.pdf", used), "a-b.pdf");
  assert.equal(safeZipName("a-b.pdf", used), "a-b (2).pdf");
  assert.equal(safeZipName("../../x", used), "x");
});

test("header titles, merged cells, widths, fonts and borders match the template", async () => {
  const before = await load(Uint8Array.from(TEMPLATE));
  const bytes = await buildHaccpWorkbook(templateBuffer(), FULL, LAYOUT_FILES);
  const after = await load(bytes);

  for (const [index, name] of before.worksheets.map((ws, i) => [i, ws.name] as const)) {
    assert.equal(after.worksheets[index].name, name);
  }

  const beforeChem = before.getWorksheet("Danh muc hoa chat")!;
  const afterChem = after.getWorksheet("Danh muc hoa chat")!;
  assert.equal(text(afterChem, "A2"), text(beforeChem, "A2"));
  assert.equal(cell(afterChem, "A2").font?.bold, cell(beforeChem, "A2").font?.bold);
  assert.equal(cell(afterChem, "A2").font?.name, cell(beforeChem, "A2").font?.name);
  assert.equal(cell(afterChem, "A2").font?.size, cell(beforeChem, "A2").font?.size);

  const beforeMachines = before.worksheets[3];
  const afterMachines = after.worksheets[3];
  assert.equal(text(afterMachines, "A1"), text(beforeMachines, "A1"));
  assert.equal(cell(afterMachines, "A1").alignment?.horizontal, cell(beforeMachines, "A1").alignment?.horizontal);

  const beforeSuppliers = before.getWorksheet("Thông tin NCC")!;
  const afterSuppliers = after.getWorksheet("Thông tin NCC")!;
  assert.equal(text(afterSuppliers, "B2"), text(beforeSuppliers, "B2"));
  assert.equal(cell(afterSuppliers, "B2").font?.bold, cell(beforeSuppliers, "B2").font?.bold);
  assert.equal(cell(afterSuppliers, "B2").font?.name, cell(beforeSuppliers, "B2").font?.name);
  assert.equal(cell(afterSuppliers, "B2").border?.top?.style, cell(beforeSuppliers, "B2").border?.top?.style);
  assert.equal(cell(afterSuppliers, "A3").border?.left?.style, cell(beforeSuppliers, "A3").border?.left?.style);
  assert.equal(cell(afterSuppliers, "A3").font?.name, cell(beforeSuppliers, "A3").font?.name);
});
