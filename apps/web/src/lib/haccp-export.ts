/**
 * Hồ sơ HACCP — fill the consultant's workbook and pack the evidence files.
 *
 * Pure functions: the caller supplies the exact template bytes and the dossier
 * data. The template keeps its sheet names, titles, merged cells, column widths,
 * borders and fonts; only the data rows are cleared and rewritten. When a table
 * outgrows the template, the last styled row is duplicated so the new rows keep
 * the same look.
 */

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { HACCP_SECTIONS, type HaccpData, type HaccpFile, type HaccpSectionId, type HaccpTableId } from "./haccp-schema.ts";

export const HACCP_EXCEL_FILE_NAME = "Thong-tin-HACCP-Q7.xlsx";

export interface HaccpAttachment {
  section: HaccpSectionId;
  name: string;
  bytes: Uint8Array;
}

export const HACCP_ZIP_FOLDERS: Record<HaccpSectionId, string> = {
  suppliers: "01-Nha-cung-cap",
  people: "02-Doi-HACCP",
  measure: "03-Thiet-bi-do-luong",
  machines: "04-May-moc",
  chemicals: "05-Hoa-chat",
  process: "06-Quy-trinh",
  layout: "07-Layout",
};

type ColumnMap = Record<string, number>;

interface TableLayout {
  columns: ColumnMap;
  sttColumn: number;
  firstDataRow: number;
  lastTemplateRow: number;
  /** How many side-by-side data rows the template already styles. */
  templateCapacity?: number;
}

const SUPPLIERS: TableLayout = {
  columns: { name: 2, phone: 3, address: 4, contact: 5, items: 6 },
  sttColumn: 1,
  firstDataRow: 3,
  lastTemplateRow: 25,
};

const TEAM: TableLayout = {
  columns: { name: 2, job: 3, role: 4 },
  sttColumn: 1,
  firstDataRow: 8,
  lastTemplateRow: 10,
  templateCapacity: 10,
};

const STAFF: TableLayout = {
  columns: { name: 7, position: 8, department: 9 },
  sttColumn: 6,
  firstDataRow: 8,
  lastTemplateRow: 17,
  templateCapacity: 10,
};

const MEASURE: TableLayout = {
  columns: { name: 2, code: 3, range: 4, origin: 5, qty: 6, place: 7, calibrated: 8 },
  sttColumn: 1,
  firstDataRow: 3,
  lastTemplateRow: 6,
};

const MACHINES: TableLayout = {
  columns: { name: 2, symbol: 3, qty: 4, origin: 5, spec: 6, year: 7, maintenance: 8, note: 9 },
  sttColumn: 1,
  firstDataRow: 3,
  lastTemplateRow: 40,
};

const CHEMICALS: TableLayout = {
  columns: { name: 2, place: 3, purpose: 4, guide: 5 },
  sttColumn: 1,
  firstDataRow: 5,
  lastTemplateRow: 16,
};

const PROCESS: TableLayout = {
  columns: { owner: 2, step: 3, detail: 4 },
  sttColumn: 1,
  firstDataRow: 5,
  lastTemplateRow: 11,
};

const LAYOUTS: Record<HaccpTableId, TableLayout> = {
  suppliers: SUPPLIERS, team: TEAM, staff: STAFF, measure: MEASURE,
  machines: MACHINES, chemicals: CHEMICALS, process: PROCESS,
};

/** Columns of one table exactly as the exported sheet orders them (1 = A). */
export function haccpSheetColumns(table: HaccpTableId): { sttColumn: number; firstDataRow: number; columns: { key: string; column: number }[] } {
  const layout = LAYOUTS[table];
  return {
    sttColumn: layout.sttColumn,
    firstDataRow: layout.firstDataRow,
    columns: Object.entries(layout.columns).map(([key, column]) => ({ key, column })).sort((a, b) => a.column - b.column),
  };
}

const LAYOUT_ROW = 4;
const LAYOUT_COLUMN = 5;

// eslint-disable-next-line no-control-regex -- strip characters a spreadsheet rejects
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Keep the user's text byte-for-byte (apart from control characters), including
 * a leading "=". ExcelJS writes a plain JavaScript string as a shared-string
 * cell, not a formula; prefixing an apostrophe would show it to the consultant.
 */
export function sanitizeCellValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .slice(0, 2000);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const rich = value as { richText?: { text?: string }[]; text?: string };
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text ?? "").join("");
    if (typeof rich.text === "string") return rich.text;
  }
  return String(value);
}

function copyStyle(source: ExcelJS.Cell, target: ExcelJS.Cell): void {
  target.font = { ...(source.font ?? {}) };
  target.border = JSON.parse(JSON.stringify(source.border ?? {}));
  target.fill = JSON.parse(JSON.stringify(source.fill ?? {}));
  target.alignment = { ...(source.alignment ?? {}) };
  target.numFmt = source.numFmt;
  target.protection = { ...(source.protection ?? {}) };
}

function clearRow(row: ExcelJS.Row, from: number, to: number): void {
  for (let col = from; col <= to; col += 1) {
    row.getCell(col).value = null;
  }
}

function ensureRows(ws: ExcelJS.Worksheet, layout: TableLayout, needed: number): number {
  const capacity = layout.templateCapacity ?? (layout.lastTemplateRow - layout.firstDataRow + 1);
  if (needed <= capacity) return capacity;
  ws.duplicateRow(layout.lastTemplateRow, needed - capacity, true);
  return needed;
}

function styleSideRows(
  ws: ExcelJS.Worksheet,
  layout: TableLayout,
  columns: number[],
  needed: number,
): void {
  const styleRow = layout.lastTemplateRow;
  for (let index = layout.templateCapacity ?? (layout.lastTemplateRow - layout.firstDataRow + 1); index < needed; index += 1) {
    const targetRow = layout.firstDataRow + index;
    for (const col of columns) {
      const source = ws.getRow(styleRow).getCell(col);
      const target = ws.getRow(targetRow).getCell(col);
      const rowHeight = ws.getRow(styleRow).height;
      if (rowHeight) ws.getRow(targetRow).height = rowHeight;
      copyStyle(source, target);
    }
  }
}

function writeText(cell: ExcelJS.Cell, value: unknown): void {
  const text = sanitizeCellValue(value);
  cell.value = text === "" ? null : text;
}

function writeTable(
  ws: ExcelJS.Worksheet,
  layout: TableLayout,
  rows: { values: Record<string, string> }[],
): void {
  const capacity = layout.templateCapacity ?? (layout.lastTemplateRow - layout.firstDataRow + 1);
  const needed = Math.max(rows.length, capacity);
  ensureRows(ws, layout, needed);

  for (let index = 0; index < needed; index += 1) {
    const rowNumber = layout.firstDataRow + index;
    const row = ws.getRow(rowNumber);
    clearRow(row, layout.sttColumn, Math.max(...Object.values(layout.columns)));
    if (index >= rows.length) continue;
    row.getCell(layout.sttColumn).value = index + 1;
    const values = rows[index]?.values ?? {};
    for (const [key, col] of Object.entries(layout.columns)) {
      writeText(row.getCell(col), values[key]);
    }
  }
}

function writeSideTables(
  ws: ExcelJS.Worksheet,
  left: { layout: TableLayout; rows: { values: Record<string, string> }[] },
  right: { layout: TableLayout; rows: { values: Record<string, string> }[] },
): void {
  const capacity = Math.max(
    left.layout.templateCapacity ?? 1,
    right.layout.templateCapacity ?? 1,
  );
  const needed = Math.max(capacity, left.rows.length, right.rows.length);

  // Both tables share rows 8..17. Extra rows are cloned from row 17 so the
  // right table keeps its border; the left columns are then copied from row 10.
  if (needed > capacity) {
    ws.duplicateRow(right.layout.lastTemplateRow, needed - capacity, true);
  }

  const leftCols = Object.values(left.layout.columns);
  const rightCols = Object.values(right.layout.columns);
  const allCols = [left.layout.sttColumn, ...leftCols, right.layout.sttColumn, ...rightCols];
  const leftStyledRows = (left.layout.lastTemplateRow - left.layout.firstDataRow + 1);

  for (let index = 0; index < needed; index += 1) {
    const row = ws.getRow(left.layout.firstDataRow + index);
    if (index >= leftStyledRows) {
      const sourceRow = ws.getRow(left.layout.lastTemplateRow);
      if (!row.height) row.height = sourceRow.height;
      for (const col of [left.layout.sttColumn, ...leftCols]) {
        copyStyle(sourceRow.getCell(col), row.getCell(col));
      }
    }
    clearRow(row, Math.min(...allCols), Math.max(...allCols));
    if (index < left.rows.length) {
      row.getCell(left.layout.sttColumn).value = index + 1;
      const leftValues = left.rows[index]?.values ?? {};
      for (const [key, col] of Object.entries(left.layout.columns)) {
        writeText(row.getCell(col), leftValues[key]);
      }
    }
    if (index < right.rows.length) {
      row.getCell(right.layout.sttColumn).value = index + 1;
      const rightValues = right.rows[index]?.values ?? {};
      for (const [key, col] of Object.entries(right.layout.columns)) {
        writeText(row.getCell(col), rightValues[key]);
      }
    }
  }
}

function writeLayout(ws: ExcelJS.Worksheet, files: HaccpFile[]): void {
  // The template has only the title at E3; there is no styled data row to copy.
  for (let index = 0; index < files.length; index += 1) {
    writeText(ws.getRow(LAYOUT_ROW + index).getCell(LAYOUT_COLUMN), files[index]?.name);
  }
}

function sheetFor(wb: ExcelJS.Workbook, index: number, name: string): ExcelJS.Worksheet {
  const exact = wb.getWorksheet(name);
  if (exact) return exact;
  const worksheet = wb.worksheets[index];
  if (!worksheet) throw new Error(`missing_sheet:${name}`);
  return worksheet;
}

/** Fill a copy of the workbook. The template ArrayBuffer is never mutated. */
export async function buildHaccpWorkbook(
  template: ArrayBuffer,
  data: HaccpData,
  layoutFiles: HaccpFile[] = [],
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS may keep a reference to the input; a copy keeps repeat exports safe.
  await wb.xlsx.load(template.slice(0) as never);

  writeTable(sheetFor(wb, 0, HACCP_SECTIONS[0].sheet), SUPPLIERS, data.suppliers);
  writeSideTables(
    sheetFor(wb, 1, HACCP_SECTIONS[1].sheet),
    { layout: TEAM, rows: data.team },
    { layout: STAFF, rows: data.staff },
  );
  writeTable(sheetFor(wb, 2, HACCP_SECTIONS[2].sheet), MEASURE, data.measure);
  writeTable(sheetFor(wb, 3, HACCP_SECTIONS[3].sheet), MACHINES, data.machines);
  writeTable(sheetFor(wb, 4, HACCP_SECTIONS[4].sheet), CHEMICALS, data.chemicals);
  writeTable(sheetFor(wb, 5, HACCP_SECTIONS[5].sheet), PROCESS, data.process);
  writeLayout(sheetFor(wb, 6, HACCP_SECTIONS[6].sheet), layoutFiles);

  const output = await wb.xlsx.writeBuffer();
  return new Uint8Array(output);
}

function ascii(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** Safe, readable, unique file name inside a ZIP folder. */
export function safeZipName(raw: string, used: Set<string>): string {
  const source = ascii(String(raw ?? ""))
    .replace(CONTROL_CHARS, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "");
  const extensionMatch = /\.([A-Za-z0-9]{1,10})$/.exec(source);
  const extension = extensionMatch ? `.${extensionMatch[1]}` : "";
  const stem = (extensionMatch ? source.slice(0, -extension.length) : source)
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 90) || "tep";
  let candidate = `${stem}${extension}`;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem} (${index})${extension}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Excel plus every attachment, grouped into one folder per dossier section. */
export async function buildHaccpZip(
  template: ArrayBuffer,
  data: HaccpData,
  layoutFiles: HaccpFile[] = [],
  attachments: HaccpAttachment[] = [],
): Promise<Uint8Array> {
  const workbook = await buildHaccpWorkbook(template, data, layoutFiles);
  const zip = new JSZip();
  zip.file(HACCP_EXCEL_FILE_NAME, workbook);

  const used = new Map<HaccpSectionId, Set<string>>();
  for (const attachment of attachments) {
    if (!attachment || attachment.bytes.byteLength === 0) continue;
    const folder = zip.folder(HACCP_ZIP_FOLDERS[attachment.section]);
    if (!folder) continue;
    const names = used.get(attachment.section) ?? new Set<string>();
    used.set(attachment.section, names);
    folder.file(safeZipName(attachment.name, names), attachment.bytes);
  }

  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

/** Read back a cell's visible text, including rich text headers. */
export function haccpCellText(value: unknown): string {
  return cellText(value);
}

/** Internal: key map used by tests to assert the template's column order. */
export const HACCP_EXPORT_COLUMNS: Record<HaccpTableId, ColumnMap> = {
  suppliers: SUPPLIERS.columns,
  team: TEAM.columns,
  staff: STAFF.columns,
  measure: MEASURE.columns,
  machines: MACHINES.columns,
  chemicals: CHEMICALS.columns,
  process: PROCESS.columns,
};
