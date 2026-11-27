/**
 * Hồ sơ HACCP bếp Quận 7: the shape of the consultant's workbook
 * (src/assets/haccp/haccp-q7-template.xlsx). One section per sheet, one field per column.
 * Pure data and progress maths; no UI and no network.
 */

export type HaccpSectionId = "suppliers" | "people" | "measure" | "machines" | "chemicals" | "process" | "layout";
export type HaccpTableId = "suppliers" | "team" | "staff" | "measure" | "machines" | "chemicals" | "process";

export interface HaccpField {
  key: string;
  /** Column header exactly as the workbook words it (shortened only where noted). */
  label: string;
  kind?: "text" | "long" | "number" | "yesno" | "phone";
  required?: boolean;
  placeholder?: string;
}

export interface HaccpTable {
  id: HaccpTableId;
  title: string;
  /** Word for one row, used on the add button: "Thêm nhà cung cấp". */
  one: string;
  fields: HaccpField[];
  /** The app already holds part of this table. */
  fromApp?: boolean;
  /** What to photograph or attach for a row of this table. */
  fileHint?: string;
}

export interface HaccpSection {
  id: HaccpSectionId;
  sheet: string;
  title: string;
  short: string;
  help: string;
  tables: HaccpTable[];
}

export const HACCP_SECTIONS: HaccpSection[] = [
  {
    id: "suppliers", sheet: "Thông tin NCC", title: "Nhà cung cấp", short: "Nhà cung cấp",
    help: "Nguyên liệu đầu vào, bao bì chứa, dịch vụ vận chuyển.",
    tables: [{
      id: "suppliers", title: "Nhà cung cấp nguyên vật liệu, dịch vụ", one: "nhà cung cấp", fromApp: true,
      fileHint: "Giấy phép, giấy ATTP, hợp đồng của nhà cung cấp",
      fields: [
        { key: "name", label: "Tên nhà cung cấp", required: true },
        { key: "items", label: "Mặt hàng cung cấp", kind: "long", required: true },
        { key: "phone", label: "Số điện thoại", kind: "phone", required: true },
        { key: "address", label: "Địa chỉ", kind: "long", required: true },
        { key: "contact", label: "Người liên hệ", required: true },
      ],
    }],
  },
  {
    id: "people", sheet: "ĐỘI HACCP", title: "Đội HACCP và nhân sự", short: "Đội HACCP",
    help: "Ai trong đội HACCP, và danh sách nhân sự đang làm.",
    tables: [
      {
        id: "team", title: "Đội HACCP", one: "thành viên đội",
        fields: [
          { key: "name", label: "Họ tên", required: true },
          { key: "job", label: "Chức danh công việc", required: true },
          { key: "role", label: "Vị trí trong đội HACCP", required: true, placeholder: "Ví dụ: Đội trưởng, thư ký, giám sát CCP" },
        ],
      },
      {
        id: "staff", title: "Danh sách nhân sự", one: "nhân sự", fromApp: true,
        fields: [
          { key: "name", label: "Họ tên", required: true },
          { key: "position", label: "Chức vụ", required: true },
          { key: "department", label: "Bộ phận", required: true },
        ],
      },
    ],
  },
  {
    id: "measure", sheet: "Danh sách thiết bị đo lường", title: "Thiết bị đo lường", short: "Đo lường",
    help: "Cân, nhiệt kế, súng bắn nhiệt… đang có tại bếp.",
    tables: [{
      id: "measure", title: "Dụng cụ đo lường", one: "dụng cụ đo", fileHint: "Ảnh tem và giấy hiệu chuẩn, kiểm định",
      fields: [
        { key: "name", label: "Tên dụng cụ đo lường", required: true, placeholder: "Ví dụ: Cân điện tử 30 kg" },
        { key: "code", label: "Mã số thiết bị", required: true },
        { key: "range", label: "Phạm vi đo", required: true, placeholder: "Ví dụ: 0 – 30 kg" },
        { key: "origin", label: "Xuất xứ", required: true },
        { key: "qty", label: "Số lượng", kind: "number", required: true },
        { key: "place", label: "Hiện ở đâu", required: true },
        { key: "calibrated", label: "Đã hiệu chuẩn/kiểm định?", kind: "yesno", required: true },
      ],
    }],
  },
  {
    id: "machines", sheet: "Danh mục máy móc thiết bị", title: "Máy móc, thiết bị sản xuất", short: "Máy móc",
    help: "Gồm cả thiết bị yêu cầu nghiêm ngặt như xe nâng, bình khí nén (nếu có).",
    tables: [{
      id: "machines", title: "Máy móc dùng trong sản xuất", one: "thiết bị", fileHint: "Ảnh máy và tem thông số",
      fields: [
        { key: "name", label: "Tên thiết bị", required: true },
        { key: "symbol", label: "Ký hiệu", required: true },
        { key: "qty", label: "Số lượng", kind: "number", required: true },
        { key: "origin", label: "Xuất xứ", required: true },
        { key: "spec", label: "Thông số kỹ thuật", kind: "long", required: true },
        { key: "year", label: "Năm sản xuất", kind: "number", required: true },
        { key: "maintenance", label: "Tháng dự kiến bảo dưỡng", required: true, placeholder: "Ví dụ: Tháng 6 và 12" },
        { key: "note", label: "Ghi chú", kind: "long" },
      ],
    }],
  },
  {
    id: "chemicals", sheet: "Danh muc hoa chat", title: "Hoá chất đang dùng", short: "Hoá chất",
    help: "Hoá chất vệ sinh thiết bị tiếp xúc thực phẩm, pha rửa, bôi trơn máy.",
    tables: [{
      id: "chemicals", title: "Danh mục hoá chất tại cơ sở", one: "hoá chất", fromApp: true,
      fileHint: "Ảnh nhãn chai, hướng dẫn pha, phiếu an toàn hoá chất",
      fields: [
        { key: "name", label: "Tên hoá chất", required: true },
        { key: "place", label: "Vị trí sử dụng", required: true },
        { key: "purpose", label: "Mục đích sử dụng", kind: "long", required: true },
        { key: "guide", label: "Có hướng dẫn pha?", kind: "yesno", required: true },
      ],
    }],
  },
  {
    id: "process", sheet: "Quy trình sản xuất", title: "Quy trình sản xuất", short: "Quy trình",
    help: "Từng bước theo thứ tự, kèm thông số đang kiểm soát (nhiệt độ, thời gian…).",
    tables: [{
      id: "process", title: "Các bước sản xuất", one: "bước", fileHint: "Ảnh sơ đồ, bảng hướng dẫn dán tại bếp",
      fields: [
        { key: "step", label: "Bước thực hiện", required: true, placeholder: "Ví dụ: Nướng bánh" },
        { key: "owner", label: "Trách nhiệm thực hiện", required: true },
        { key: "detail", label: "Mô tả chi tiết và thông số kiểm soát", kind: "long", required: true },
      ],
    }],
  },
  {
    id: "layout", sheet: "Layout nhà xưởng", title: "Sơ đồ nhà xưởng", short: "Layout",
    help: "Bản vẽ mặt bằng mới nhất của bếp (nếu có). Ảnh chụp bản vẽ cũng được.",
    tables: [],
  },
];

export interface HaccpFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  /** The browser object still waiting to be uploaded. */
  file?: File;
}

export interface HaccpRow {
  id: string;
  values: Record<string, string>;
  files: HaccpFile[];
  /** "app" when pulled from BMQ AI data, otherwise the name of who typed it. */
  by: string;
  /** Optimistic concurrency token; absent on a row that has never been saved. */
  version?: number;
}

export type HaccpData = Record<HaccpTableId, HaccpRow[]>;

export function haccpMissing(table: HaccpTable, row: HaccpRow): HaccpField[] {
  return table.fields.filter((f) => f.required && !String(row.values[f.key] ?? "").trim());
}

export interface HaccpProgress {
  pct: number;
  rows: number;
  missingCells: number;
  missingRows: number;
  state: "done" | "partial" | "empty";
}

export function haccpProgress(section: HaccpSection, data: HaccpData, layoutFiles: HaccpFile[]): HaccpProgress {
  if (section.id === "layout") {
    const has = layoutFiles.length > 0;
    return { pct: has ? 100 : 0, rows: layoutFiles.length, missingCells: has ? 0 : 1, missingRows: 0, state: has ? "done" : "empty" };
  }
  let total = 0;
  let missingCells = 0;
  let missingRows = 0;
  let rows = 0;
  let emptyTables = 0;
  for (const table of section.tables) {
    const list = data[table.id];
    const need = table.fields.filter((f) => f.required).length;
    rows += list.length;
    if (!list.length) {
      // An empty table still owes at least one full row.
      total += need;
      missingCells += need;
      emptyTables += 1;
      continue;
    }
    for (const row of list) {
      const gaps = haccpMissing(table, row).length;
      total += need;
      missingCells += gaps;
      if (gaps) missingRows += 1;
    }
  }
  const pct = total ? Math.floor(((total - missingCells) * 100) / total) : 0;
  const state = !rows ? "empty" : missingCells === 0 && !emptyTables ? "done" : "partial";
  return { pct, rows, missingCells, missingRows, state };
}
