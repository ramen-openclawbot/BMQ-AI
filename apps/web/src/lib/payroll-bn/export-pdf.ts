// PDF export of the Bếp BN draft payroll.
//
// The rows come from buildPayrollExportRows (export.ts): a title, a subtitle,
// the column header, then employee / group / total rows. Group and total rows
// are printed in bold, and every number is shown in vi-VN format.
//
// The Vietnamese font is loaded from src/lib/pdf-fonts.ts. When that fetch
// fails the document still renders with the built-in font.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { loadRobotoFont, loadRobotoBoldFont } from "../pdf-fonts.ts";
import { PAYROLL_EXPORT_HEADER } from "./export.ts";

/** 1.234.567,5 — numbers from the export rows, strings left as is. */
export function formatPdfCell(value: string | number): string {
  if (typeof value === "number") {
    return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);
  }
  return value;
}

function isSummaryRow(row: (string | number)[]): boolean {
  const label = row[1];
  return typeof label === "string" && (label === "Tổng cộng" || label.startsWith("Nhóm "));
}

async function registerRoboto(doc: jsPDF): Promise<string> {
  try {
    const [regular, bold] = await Promise.all([loadRobotoFont(), loadRobotoBoldFont()]);
    doc.addFileToVFS("Roboto-Regular.ttf", regular);
    doc.addFileToVFS("Roboto-Bold.ttf", bold);
    doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
    doc.addFont("Roboto-Bold.ttf", "Roboto", "bold");
    return "Roboto";
  } catch {
    // Offline / blocked font: fall back to the built-in font.
    return "helvetica";
  }
}

/**
 * Build a landscape A4 PDF from the rows produced by buildPayrollExportRows.
 * The caller decides how to download or display the blob.
 */
export async function buildPayrollPdf(rows: (string | number)[][]): Promise<Blob> {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const fontName = await registerRoboto(doc);

  const headerIndex = rows.findIndex((row) => row[0] === PAYROLL_EXPORT_HEADER[0]);
  const titleRows = headerIndex >= 0 ? rows.slice(0, headerIndex) : rows;
  const header = headerIndex >= 0 ? rows[headerIndex] : [];
  const bodyRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : [];

  doc.setFont(fontName);
  let cursorY = 10;
  titleRows.forEach((row, index) => {
    const text = row.map((cell) => formatPdfCell(cell)).filter((cell) => cell !== "").join("  ");
    if (text === "") return;
    doc.setFontSize(index === 0 ? 12 : 8.5);
    doc.text(text, 8, cursorY);
    cursorY += index === 0 ? 6 : 5;
  });

  const summaryFlags: boolean[] = bodyRows.map((row) => isSummaryRow(row));
  const body = bodyRows.map((row) => row.map((cell) => formatPdfCell(cell)));

  autoTable(doc, {
    startY: cursorY + 1,
    head: [header.map((cell) => formatPdfCell(cell))],
    body,
    theme: "grid",
    styles: { font: fontName, fontSize: 6.5, cellPadding: 1.2, overflow: "linebreak" },
    headStyles: { font: fontName, fontStyle: "bold", fillColor: [230, 230, 230], textColor: 20 },
    columnStyles: {
      0: { cellWidth: 16 },
      1: { cellWidth: 30 },
      14: { cellWidth: 40 },
    },
    margin: { left: 8, right: 8 },
    didParseCell: (data) => {
      if (data.section === "body" && summaryFlags[data.row.index]) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
}
