/**
 * Pure helpers for the two-job warehouse game (Kho 2 việc).
 *
 * Server contract (apps/web/supabase/migrations/20261102500000_kho_two_jobs.sql):
 *   kho_get_items()  -> KhoItemsPayload
 *   kho_save_item()  -> KhoSaveResult
 *   kho_count_item() -> KhoCountResult
 *
 * Everything here is synchronous and UI-free so the game screen can filter and
 * explain errors without duplicating SQL.
 */

export type KhoLocation = "tan_tao" | "q7";

export interface KhoQtyByLocation {
  tan_tao: number | null;
  q7: number | null;
}

export interface KhoDateByLocation {
  tan_tao: string | null;
  q7: string | null;
}

export interface KhoItem {
  id: string;
  item_code: string | null;
  name: string;
  unit: string;
  active: boolean;
  item_class: string | null;
  in_q7: boolean;
  qty: KhoQtyByLocation;
  last_count_date: KhoDateByLocation;
  pending_count: KhoQtyByLocation;
  doc_lines: number;
}

export interface KhoItemsPayload {
  can_edit: boolean;
  can_count: {
    tan_tao: boolean;
    q7: boolean;
  };
  items: KhoItem[];
}

export interface KhoSavedItem {
  id: string;
  name: string;
  unit: string;
  active: boolean;
}

export type KhoSaveResult =
  | { status: "saved"; item: KhoSavedItem }
  | {
      status: "name_taken";
      other: { id: string; name: string; unit: string; active: boolean };
    }
  | { status: "unit_factor_needed"; from: string; to: string }
  | { status: "merged"; into: { id: string; name: string; unit: string } };

export interface KhoCountResult {
  status: "counted";
  location: KhoLocation;
  item_id: string;
  counted_qty: number;
  result: Record<string, unknown>;
}

interface UnitDefinition {
  base: "g" | "ml";
  toBase: number;
}

const STANDARD_UNITS: Record<string, UnitDefinition> = {
  g: { base: "g", toBase: 1 },
  kg: { base: "g", toBase: 1000 },
  mg: { base: "g", toBase: 0.001 },
  ml: { base: "ml", toBase: 1 },
  l: { base: "ml", toBase: 1000 },
};

function unitCode(unit: string | null | undefined): string {
  return (unit ?? "").toLowerCase().replace(/\s+/g, "");
}

/**
 * Mirror of public.q7_unit_factor for the shared standard units:
 * g / kg / mg and ml / l.  Returns null for a different kind or a game unit
 * such as bao, because those need an owner-approved factor.
 */
export function standardUnitFactor(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const fromUnit = STANDARD_UNITS[unitCode(from)];
  const toUnit = STANDARD_UNITS[unitCode(to)];
  if (!fromUnit || !toUnit || fromUnit.base !== toUnit.base) return null;
  const factor = fromUnit.toBase / toUnit.toBase;
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** Lowercase, strip Vietnamese accents (đ -> d), collapse spaces. */
export function searchKey(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

export interface KhoItemFilters {
  location?: KhoLocation;
  activeOnly?: boolean;
}

/**
 * Search by accent-insensitive name and optionally narrow to one warehouse.
 * Q7 uses the pastry_q7 flag; Tân Tạo uses an existing ledger, count or pending
 * line so a never-counted item does not silently disappear from its list.
 */
export function filterItems(
  items: KhoItem[],
  query: string,
  options: KhoItemFilters = {},
): KhoItem[] {
  const term = searchKey(query);
  return items.filter((item) => {
    if (options.activeOnly && !item.active) return false;

    if (options.location === "q7" && !item.in_q7) return false;
    if (options.location === "tan_tao") {
      const present =
        item.qty.tan_tao !== null ||
        item.pending_count.tan_tao !== null ||
        item.last_count_date.tan_tao !== null;
      if (!present) return false;
    }

    if (term === "") return true;
    return searchKey(item.name).includes(term);
  });
}

const ERROR_TEXT: Record<string, string> = {
  insufficient_privilege: "Anh/chị không có quyền thực hiện thao tác này.",
  pastry_forbidden: "Anh/chị không có quyền chuyển món sang kho khác.",
  rename_forbidden: "Anh/chị không có quyền đổi tên món.",
  unit_forbidden: "Anh/chị không có quyền đổi đơn vị món.",
  unit_label_invalid: "Tên đơn vị chỉ gồm chữ, dài từ 1 đến 16 ký tự.",
  unit_is_measure: "Đây là đơn vị đo khối lượng/thể tích, không thêm làm đơn vị đếm được.",
  unit_auto: "Đơn vị này tự quy đổi theo kg/g/l/ml nên không sửa hệ số.",
  invalid_name: "Tên món phải có từ 2 đến 120 ký tự.",
  item_not_found: "Không tìm thấy món này.",
  item_name_duplicate: "Tên món đã được dùng cho món khác.",
  invalid_factor: "Hệ số quy đổi phải lớn hơn 0.",
  unit_not_allowed: "Đơn vị này không được dùng trong kho.",
  invalid_quantity: "Số lượng đếm phải lớn hơn hoặc bằng 0.",
  item_inactive: "Món này đã tắt nên không đếm được.",
  item_not_in_location: "Món này không có trong kho đã chọn.",
  // discontinue_stock_item: a counted line on an open count sheet must be submitted first.
  item_in_open_count: "Món này đã được đếm trong phiếu kiểm kê đang mở. Nộp phiếu kiểm kê đó trước, rồi mới tắt được món.",
  item_merged: "Món này đã gộp vào món khác. Mở món mới để sửa.",
};

function errorFields(error: unknown): { message: string; code: string } {
  if (typeof error === "string") return { message: error, code: "" };
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : "";
    const code = typeof record.code === "string" ? record.code : "";
    return { message, code };
  }
  return { message: "", code: "" };
}

/** Short plain-Vietnamese message for every error the game RPCs can return. */
export function khoErrorText(error: unknown): string {
  const { message, code } = errorFields(error);
  const lower = message.toLowerCase();

  if (code === "57014" || lower.includes("statement timeout") || lower.includes("timeout")) {
    return "Máy chủ xử lý quá lâu, anh/chị thử lại giúp.";
  }

  for (const [key, text] of Object.entries(ERROR_TEXT)) {
    if (lower.includes(key)) return text;
  }

  return "Có lỗi xảy ra, anh/chị thử lại giúp.";
}
