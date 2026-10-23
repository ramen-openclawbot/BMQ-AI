/**
 * Pure export layer for the KFM trace sheet.
 *
 * Server contracts:
 *   kho_trace_candidates(date, date)
 *   kho_trace_report(uuid)
 *
 * Nothing here reads or writes the database.  The workbook follows the
 * owner's 'BC truy xuat' template; the ZIP bundles Excel, PDF and the
 * certificate files.  Vietnamese PDF text uses the repo's Unicode Noto Sans
 * TTF when it can be fetched, otherwise the built-in PDF font is used.
 */

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export type TraceSection = "raw" | "packaging";

export type TraceMissingField = "lot" | "manufacturer" | "nsx" | "hsd" | "receipt";

export interface KhoTraceCandidate {
  production_order_item_id: string;
  production_number: string;
  production_date: string | null;
  sku_id: string | null;
  sku_code: string | null;
  product_name: string;
  qty: number | null;
  unit: string | null;
  location_code: string | null;
  has_issue: boolean;
}

export interface TraceLot {
  receipt_number: string | null;
  received_date: string | null;
  quantity: number | null;
  unit: string | null;
  manufacture_date: string | null;
  expiry_date: string | null;
  manufacturer_lot: string | null;
  lot_code: string | null;
  lot_code_internal: boolean;
  manufacturer_id?: string | null;
  manufacturer_name: string | null;
  supplier_name: string | null;
}

export interface TraceMaterial {
  item_id: string;
  item_code: string | null;
  name: string;
  section: TraceSection;
  required_qty: number | null;
  unit: string | null;
  lots: TraceLot[];
  missing: TraceMissingField[];
}

export interface TraceCertificate {
  id: string;
  cert_type: string;
  cert_no: string | null;
  issuer: string | null;
  expires_on: string | null;
  file_path: string;
  file_name: string | null;
  mime_type: string | null;
}

export interface TraceSemiFinishedRow {
  name: string;
  production_date: string | null;
  qty: number | null;
  remaining: number | null;
  lot_code: string | null;
}

export interface KhoTraceReport {
  production_order_item_id?: string;
  product_name: string;
  sku_code: string | null;
  production_number: string;
  production_date: string | null;
  qty: number | null;
  unit: string | null;
  shelf_life_days: number | null;
  expiry_date: string | null;
  missing: string[];
  materials: TraceMaterial[];
  certificates: TraceCertificate[];
  company_certificates: TraceCertificate[];
  semi_finished: TraceSemiFinishedRow[];
}

/** One row of the I/II material tables, in the template's cell order. */
export interface TraceMaterialTableRow {
  index: number;
  name: string;
  manufacturer: string;
  received_date: string;
  quantity: string;
  manufacture_date: string;
  expiry_date: string;
  lot_code: string;
}

export type TraceSemiFinishedOverride = Partial<
  Pick<TraceSemiFinishedRow, "name" | "production_date" | "qty" | "remaining" | "lot_code">
>;

export interface TraceZipInput {
  xlsx: ArrayBuffer;
  pdf: ArrayBuffer;
  certificateFiles: { name: string; data: ArrayBuffer }[];
}

const MISSING_TEXT = "chưa có";
const FONT_NAME = "Times New Roman";

function textOrNull(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function dateParts(value: string | Date | null | undefined): [number, number, number] | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
  }

  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  let year: number;
  let month: number;
  let day: number;

  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (ymd) {
    year = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  } else {
    const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(raw);
    if (!dmy) return null;
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    return null;
  }

  return [year, month, day];
}

/**
 * Header dates are dd.mm.yyyy; table cells use yyyy-mm-dd like the template.
 * Missing / invalid dates become an empty string so callers can decide the
 * placeholder ('chưa có' inside the material table).
 */
export function formatTraceDate(
  value: string | Date | null | undefined,
  mode: "header" | "cell" = "cell",
): string {
  const parts = dateParts(value);
  if (parts === null) return "";
  const [year, month, day] = parts;
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return mode === "header" ? `${dd}.${mm}.${year}` : `${year}-${mm}-${dd}`;
}

/** '250kg', '600 cái', or 'chưa có' when the quantity is unknown. */
export function qtyWithUnit(value: number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return MISSING_TEXT;
  }
  const numberText = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(value));
  const cleanUnit = textOrNull(unit);
  if (cleanUnit === null) return numberText;
  const tight = /^(kg|g|l|ml|lít|lit|%)$/i.test(cleanUnit);
  return `${numberText}${tight ? "" : " "}${cleanUnit}`;
}

function joinedLots(
  lots: TraceLot[],
  pick: (lot: TraceLot) => string | null,
): string {
  if (lots.length === 0) return MISSING_TEXT;
  return lots.map((lot) => pick(lot) ?? MISSING_TEXT).join("; ");
}

function lotDate(value: string | null): string | null {
  const formatted = formatTraceDate(value, "cell");
  return formatted === "" ? null : formatted;
}

/**
 * One template row per material.  Multiple lots are joined with '; ' in the
 * date / quantity / NSX / HSD / lot cells; missing values show 'chưa có'.
 */
export function lotsToRows(material: TraceMaterial, index = 1): TraceMaterialTableRow {
  const lots = material.lots ?? [];
  return {
    index,
    name: textOrNull(material.name) ?? MISSING_TEXT,
    // The template column is the producer, not the supplier we bought from.
    manufacturer: joinedLots(lots, (lot) => textOrNull(lot.manufacturer_name)),
    received_date: joinedLots(lots, (lot) => lotDate(lot.received_date)),
    quantity: joinedLots(lots, (lot) => qtyWithUnit(lot.quantity, lot.unit)),
    // Packaging has no NSX/HSD in the template: leave those cells blank.
    manufacture_date: material.section === "raw"
      ? joinedLots(lots, (lot) => lotDate(lot.manufacture_date))
      : lots.map((lot) => lotDate(lot.manufacture_date) ?? "").filter(Boolean).join("; "),
    expiry_date: material.section === "raw"
      ? joinedLots(lots, (lot) => lotDate(lot.expiry_date))
      : lots.map((lot) => lotDate(lot.expiry_date) ?? "").filter(Boolean).join("; "),
    lot_code: joinedLots(
      lots,
      (lot) => textOrNull(lot.lot_code) ?? textOrNull(lot.manufacturer_lot),
    ),
  };
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FF000000" } },
  left: { style: "thin", color: { argb: "FF000000" } },
  bottom: { style: "thin", color: { argb: "FF000000" } },
  right: { style: "thin", color: { argb: "FF000000" } },
};

interface CellStyleOptions {
  bold?: boolean;
  size?: number;
  align?: "left" | "center";
  border?: boolean;
  wrapText?: boolean;
}

function writeCell(
  worksheet: ExcelJS.Worksheet,
  address: string,
  value: ExcelJS.CellValue,
  options: CellStyleOptions = {},
): void {
  const cell = worksheet.getCell(address);
  cell.value = value;
  cell.font = { name: FONT_NAME, size: options.size ?? 13, bold: options.bold ?? false };
  cell.alignment = {
    horizontal: options.align ?? "left",
    vertical: "middle",
    wrapText: options.wrapText ?? false,
  };
  if (options.border) cell.border = THIN_BORDER;
}

function writeHeaderRow(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  values: string[],
): void {
  values.forEach((value, index) => {
    const column = String.fromCharCode(65 + index);
    writeCell(worksheet, `${column}${rowNumber}`, value, {
      bold: true,
      align: "center",
      border: true,
      wrapText: true,
    });
  });
  worksheet.getRow(rowNumber).height = 29.25;
}

function writeTableRow(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  values: (string | number)[],
  boldColumns: number[] = [],
): void {
  values.forEach((value, index) => {
    const column = String.fromCharCode(65 + index);
    writeCell(worksheet, `${column}${rowNumber}`, value, {
      bold: boldColumns.includes(index),
      align: index === 0 || index >= 3 ? "center" : "left",
      border: true,
      wrapText: true,
    });
  });
  worksheet.getRow(rowNumber).height = 24;
}

/**
 * Reproduce the owner's 'BC truy xuat' template: B1 title, product/NSX/HSD
 * header rows 3-4, then I. Nguyên liệu, II. Bao bì and III. Bán thành phẩm.
 * Sections grow with their row count and are separated by one blank row.
 */
export async function buildTraceWorkbook(
  report: KhoTraceReport,
  semiFinishedOverrides: TraceSemiFinishedOverride[] = [],
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("BC truy xuat");

  const widths = [4.04, 31.34, 56.63, 14.26, 14.66, 18.83, 13.72, 21.25];
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });

  worksheet.getRow(1).height = 27;
  writeCell(worksheet, "B1", "BÁO CÁO TRUY XUẤT SẢN PHẨM", { bold: true, size: 16 });

  worksheet.getRow(3).height = 20.25;
  writeCell(worksheet, "B3", "TÊN SẢN PHẨM", { bold: true });
  writeCell(worksheet, "C3", report.product_name ?? "", { bold: true });
  writeCell(worksheet, "E3", "NSX: ", { align: "center" });
  writeCell(worksheet, "F3", formatTraceDate(report.production_date, "header"), { align: "center" });
  writeCell(worksheet, "G3", "HSD:", { align: "center" });
  writeCell(worksheet, "H3", formatTraceDate(report.expiry_date, "header"), { align: "center" });

  worksheet.getRow(4).height = 21;
  writeCell(worksheet, "B4", "Số lượng:");
  writeCell(worksheet, "C4", qtyWithUnit(report.qty, report.unit));

  const materials = report.materials ?? [];
  const rawRows = materials
    .filter((material) => material.section === "raw")
    .map((material, index) => lotsToRows(material, index + 1));
  const packagingRows = materials
    .filter((material) => material.section !== "raw")
    .map((material, index) => lotsToRows(material, index + 1));

  let cursor = 7;

  writeHeaderRow(worksheet, 6, [
    "I.",
    "Nguyên liệu",
    "Nhà sản xuất",
    "Ngày nhập",
    "Số lượng nhập (ĐVT)",
    "NSX",
    "HSD",
    "Mã lô NVL",
  ]);
  for (const row of rawRows) {
    writeTableRow(worksheet, cursor, [
      row.index,
      row.name,
      row.manufacturer,
      row.received_date,
      row.quantity,
      row.manufacture_date,
      row.expiry_date,
      row.lot_code,
    ], [0]);
    cursor += 1;
  }

  cursor += 1; // blank row between I and II
  const packagingHeaderRow = cursor;
  writeHeaderRow(worksheet, packagingHeaderRow, [
    "II.",
    "Bao bì",
    "Nhà sản xuất",
    "Ngày nhập",
    "Số lượng nhập",
    "NSX",
    "HSD",
    "Mã lô NVL",
  ]);
  cursor += 1;
  for (const row of packagingRows) {
    writeTableRow(worksheet, cursor, [
      row.index,
      row.name,
      row.manufacturer,
      row.received_date,
      row.quantity,
      row.manufacture_date,
      row.expiry_date,
      row.lot_code,
    ], [0]);
    cursor += 1;
  }

  cursor += 1; // blank row between II and III
  const semiHeaderRow = cursor;
  writeHeaderRow(worksheet, semiHeaderRow, [
    "III",
    "Bán thành phẩm",
    "Ngày sản xuất",
    "Số lượng SX",
    "Số lượng tồn ( sau giao )",
    "Mã lô",
  ]);
  cursor += 1;

  const semiRows = (report.semi_finished ?? []).map((row, index) => ({
    ...row,
    ...(semiFinishedOverrides[index] ?? {}),
  }));
  semiRows.forEach((row, index) => {
    writeTableRow(worksheet, cursor, [
      index + 1,
      row.name || MISSING_TEXT,
      formatTraceDate(row.production_date, "cell") || MISSING_TEXT,
      qtyWithUnit(row.qty, report.unit),
      qtyWithUnit(row.remaining, report.unit),
      textOrNull(row.lot_code) ?? MISSING_TEXT,
    ], [0]);
    cursor += 1;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  if (buffer instanceof ArrayBuffer) return buffer;
  const bytes = new Uint8Array(buffer as unknown as ArrayBuffer);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function registerUnicodeFont(doc: jsPDF): Promise<string> {
  try {
    // The repo already carries Vietnamese-capable TTFs for Edge Functions.
    // Vite resolves these asset URLs at build time; Node tests never call it.
    const regularUrl = new URL(
      "../../supabase/functions/_shared/fonts/NotoSans-Regular.ttf",
      import.meta.url,
    );
    const boldUrl = new URL(
      "../../supabase/functions/_shared/fonts/NotoSans-Bold.ttf",
      import.meta.url,
    );
    const [regularResponse, boldResponse] = await Promise.all([
      fetch(regularUrl),
      fetch(boldUrl),
    ]);
    if (!regularResponse.ok) throw new Error(`font_http_${regularResponse.status}`);
    if (!boldResponse.ok) throw new Error(`font_http_${boldResponse.status}`);

    doc.addFileToVFS(
      "NotoSans-Regular.ttf",
      arrayBufferToBase64(await regularResponse.arrayBuffer()),
    );
    doc.addFileToVFS(
      "NotoSans-Bold.ttf",
      arrayBufferToBase64(await boldResponse.arrayBuffer()),
    );
    doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
    doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
    return "NotoSans";
  } catch {
    return "helvetica";
  }
}

/**
 * A4 portrait PDF with the same three tables as the template.  Uses the repo
 * Noto Sans TTF for Vietnamese text when it loads; otherwise falls back to the
 * PDF built-in font (Vietnamese may not render, but the export still works).
 */
export async function buildTracePdf(report: KhoTraceReport): Promise<ArrayBuffer> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const fontName = await registerUnicodeFont(doc);

  doc.setFont(fontName, "normal");
  doc.setFontSize(16);
  doc.text("BÁO CÁO TRUY XUẤT SẢN PHẨM", 105, 15, { align: "center" });

  doc.setFontSize(10);
  doc.text(`TÊN SẢN PHẨM: ${report.product_name ?? ""}`, 12, 25);
  doc.text(`NSX: ${formatTraceDate(report.production_date, "header")}`, 132, 25);
  doc.text(`HSD: ${formatTraceDate(report.expiry_date, "header")}`, 165, 25);
  doc.text(`Số lượng: ${qtyWithUnit(report.qty, report.unit)}`, 12, 32);

  const rawRows = (report.materials ?? [])
    .filter((material) => material.section === "raw")
    .map((material, index) => lotsToRows(material, index + 1));
  const packagingRows = (report.materials ?? [])
    .filter((material) => material.section !== "raw")
    .map((material, index) => lotsToRows(material, index + 1));

  const head = [
    "STT",
    "Nguyên liệu",
    "Nhà sản xuất",
    "Ngày nhập",
    "Số lượng nhập",
    "NSX",
    "HSD",
    "Mã lô NVL",
  ];
  const body = (rows: TraceMaterialTableRow[]) => rows.map((row) => [
    String(row.index),
    row.name,
    row.manufacturer,
    row.received_date,
    row.quantity,
    row.manufacture_date,
    row.expiry_date,
    row.lot_code,
  ]);
  const tableStyles = {
    theme: "grid" as const,
    styles: { font: fontName, fontSize: 7, cellPadding: 1.1, overflow: "linebreak" as const },
    headStyles: {
      font: fontName,
      fontStyle: "bold" as const,
      fillColor: [230, 230, 230] as [number, number, number],
      textColor: 20 as const,
    },
    margin: { left: 8, right: 8 },
  };

  let cursorY = 38;
  doc.setFontSize(11);
  doc.text("I. Nguyên liệu", 12, cursorY);
  autoTable(doc, {
    ...tableStyles,
    startY: cursorY + 2,
    head: [head],
    body: body(rawRows),
  });
  cursorY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? cursorY) + 7;

  doc.text("II. Bao bì", 12, cursorY);
  autoTable(doc, {
    ...tableStyles,
    startY: cursorY + 2,
    head: [head.map((cell, index) => (index === 1 ? "Bao bì" : cell))],
    body: body(packagingRows),
  });
  cursorY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? cursorY) + 7;

  doc.text("III. Bán thành phẩm", 12, cursorY);
  const semiBody = (report.semi_finished ?? []).map((row, index) => [
    String(index + 1),
    row.name || MISSING_TEXT,
    formatTraceDate(row.production_date, "cell") || MISSING_TEXT,
    qtyWithUnit(row.qty, report.unit),
    qtyWithUnit(row.remaining, report.unit),
    textOrNull(row.lot_code) ?? MISSING_TEXT,
  ]);
  autoTable(doc, {
    ...tableStyles,
    startY: cursorY + 2,
    head: [["STT", "Bán thành phẩm", "Ngày sản xuất", "Số lượng SX", "Số lượng tồn ( sau giao )", "Mã lô"]],
    body: semiBody,
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 42 },
      2: { cellWidth: 30 },
      3: { cellWidth: 28 },
      4: { cellWidth: 42 },
      5: { cellWidth: 36 },
    },
  });

  return doc.output("arraybuffer");
}

/** ZIP: report.xlsx + report.pdf + every certificate file. */
export async function buildTraceZip(
  _report: KhoTraceReport,
  input: TraceZipInput,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("report.xlsx", input.xlsx);
  zip.file("report.pdf", input.pdf);
  for (const file of input.certificateFiles ?? []) {
    const name = textOrNull(file.name) ?? `certificate-${Date.now()}`;
    zip.file(name, file.data);
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: "application/zip" });
}
