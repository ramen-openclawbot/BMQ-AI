/**
 * Pure helpers for the two-job warehouse game (Kho 2 việc).
 *
 * Server contract:
 *   kho_get_items()         -> KhoItemsPayload   (20261102500000, expanded by
 *                                                20261102620000 with in_tan_tao)
 *   kho_save_item()         -> KhoSaveResult
 *   kho_count_item()        -> KhoCountResult
 *   set_item_kho_locations() -> SetItemKhoLocationsResult (20261102620000)
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
  /** Editor note (<= 500 characters); null when none. */
  note?: string | null;
  /** Up to five previous item codes, newest first. */
  old_codes?: string[];
  /** Has a place at Kho Q7. */
  in_q7: boolean;
  /** Has a place at Kho Tân Tạo. A two-kho item has both flags true. */
  in_tan_tao: boolean;
  qty: KhoQtyByLocation;
  last_count_date: KhoDateByLocation;
  pending_count: KhoQtyByLocation;
  doc_lines: number;
}

export interface SetItemKhoLocationsResult {
  item_id: string;
  in_tan_tao: boolean;
  in_q7: boolean;
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

export interface KhoCreateItemInput {
  name: string;
  unit: string | null;
  itemClass: "raw_material" | "packaging_supply" | null;
  inTanTao: boolean | null;
  inQ7: boolean | null;
  note: string | null;
  copyFrom: string | null;
  /** At least one: the item is linked to its suppliers (and to their traceability papers) from creation. */
  supplierIds: string[];
  requestId: string;
}

export interface KhoCreateItemResult {
  status: "created";
  item_id: string;
  item_code: string;
  name: string;
  unit: string;
  in_tan_tao: boolean;
  in_q7: boolean;
  copied_from: string | null;
}

export interface KhoCountResult {
  status: "counted";
  location: KhoLocation;
  item_id: string;
  counted_qty: number;
  result: Record<string, unknown>;
}

/** Membership flags needed by the Tân Tạo fallback. */
export interface KhoMembershipFlags {
  in_q7: boolean;
  in_tan_tao?: boolean | null;
}

/**
 * The server now returns in_tan_tao. Cached / older payloads without it keep
 * the previous single-kho meaning: anything not at Q7 belonged to Tân Tạo.
 */
export function hasTanTaoPlace(item: KhoMembershipFlags): boolean {
  return item.in_tan_tao ?? !item.in_q7;
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
 * An item may belong to both warehouses. Q7 follows in_q7; Tân Tạo follows
 * in_tan_tao, with a non-zero Tân Tạo balance also keeping legacy stock visible.
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
      const present = hasTanTaoPlace(item) || (item.qty.tan_tao ?? 0) !== 0;
      if (!present) return false;
    }

    if (term === "") return true;
    // Name, current code, older codes (labels printed before the renumber) and the note.
    return [item.name, item.item_code, item.note, ...(item.old_codes ?? [])].some((v) => searchKey(v).includes(term));
  });
}

const ERROR_TEXT: Record<string, string> = {
  insufficient_privilege: "Anh/chị không có quyền thực hiện thao tác này.",
  invalid_note: "Ghi chú tối đa 500 ký tự.",
  pastry_forbidden: "Anh/chị không có quyền chuyển món sang kho khác.",
  rename_forbidden: "Anh/chị không có quyền đổi tên món.",
  unit_forbidden: "Anh/chị không có quyền đổi đơn vị món.",
  unit_label_invalid: "Tên đơn vị chỉ gồm chữ, dài từ 1 đến 16 ký tự.",
  unit_is_measure: "Đây là đơn vị đo khối lượng/thể tích, không thêm làm đơn vị đếm được.",
  unit_auto: "Đơn vị này tự quy đổi theo kg/g/l/ml nên không sửa hệ số.",
  invalid_name: "Tên món phải có từ 2 đến 120 ký tự.",
  item_not_found: "Không tìm thấy món này.",
  item_inactive_place: "Món này đang tắt (có thể vừa có người tắt). Tải lại, bật món rồi chọn kho.",
  item_name_duplicate: "Tên món đã được dùng cho món khác.",
  invalid_class: "Chọn loại hàng: Nguyên liệu hoặc Bao bì & vật tư.",
  kho_location_required: "Chọn ít nhất một kho cho món.",
  supplier_required: "Chọn ít nhất một nhà cung cấp cho món.",
  supplier_not_found: "Nhà cung cấp đã chọn không còn trong danh sách. Tải lại rồi chọn lại.",
  invalid_factor: "Hệ số quy đổi phải lớn hơn 0.",
  unit_not_allowed: "Đơn vị này không được dùng trong kho.",
  invalid_quantity: "Số lượng đếm phải lớn hơn hoặc bằng 0.",
  item_inactive: "Món này đã tắt nên không đếm được.",
  item_not_in_location: "Món này không có trong kho đã chọn.",
  // discontinue_stock_item: a counted line on an open count sheet must be submitted first.
  item_in_open_count: "Món này đã được đếm trong phiếu kiểm kê đang mở. Nộp phiếu kiểm kê đó trước, rồi mới tắt được món.",
  item_merged: "Món này đã gộp vào món khác. Mở món mới để sửa.",
  merge_source_was_target: "Món này từng nhận món gộp, chưa gộp tiếp được. Nhắn VNAgent giúp.",
  merge_target_already_merged: "Món đích đã được gộp vào món khác.",
  merge_item_type_mismatch: "Hai món khác loại (nguyên liệu / vật tư), không gộp được.",
  merge_source_inactive: "Món này đã tắt hoặc đã gộp.",
  merge_target_inactive: "Món đích đang tắt.",
  merge_factor_invalid: "Hệ số quy đổi phải lớn hơn 0.",
  // record_q7_inventory_adjustment needs one approved Q7 mapping from the item to its own canonical material.
  q7_mapping_identity_mismatch: "Món này chưa nối đúng mã nguyên liệu Kho Q7 nên chưa ghi được số đếm. Nhắn VNAgent giúp.",
  q7_mapping_required: "Món này chưa nối mã nguyên liệu Kho Q7 nên chưa ghi được số đếm. Nhắn VNAgent giúp.",
  q7_canonical_link_required: "Món này chưa gắn mã nguyên liệu nên chưa ghi được số đếm. Nhắn VNAgent giúp.",
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

  // Server messages carry detail after a colon: "merge_factor_invalid: ...".
  for (const [key, text] of Object.entries(ERROR_TEXT)) {
    if (lower === key || lower.startsWith(`${key}:`)) return text;
  }

  for (const [key, text] of Object.entries(ERROR_TEXT)) {
    if (lower.includes(key)) return text;
  }

  return "Có lỗi xảy ra, anh/chị thử lại giúp.";
}
