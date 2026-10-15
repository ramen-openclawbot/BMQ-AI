/**
 * Pure helpers for linking Q7 kitchen items to the Material Master
 * (2026-10-31).
 *
 * The parsers validate the jsonb returned by
 *   public.get_q7_material_link_review(),
 *   public.link_q7_item_material(uuid, uuid, boolean, uuid, numeric) and
 *   public.link_q7_exact_materials(uuid).
 *
 * The server is authoritative: these parsers only reject malformed payloads so a
 * broken RPC response can never be rendered as a successful link.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Q7MaterialLinkMaterial {
  id: string;
  material_code: string;
  canonical_name: string;
  default_unit: string;
}

/** How the item unit relates to the material default unit. */
export type Q7UnitStatus = "same" | "auto" | "needs_factor";

export interface Q7MaterialLinkCandidate extends Q7MaterialLinkMaterial {
  score: number;
  unit_status: Q7UnitStatus;
}

export interface Q7MaterialLinkReviewItem {
  item_id: string;
  item_code: string | null;
  name: string;
  unit: string;
  exact_material: Q7MaterialLinkMaterial | null;
  /** default_unit of the exact material, null when there is no exact match. */
  material_unit: string | null;
  /** null when there is no exact material. */
  unit_status: Q7UnitStatus | null;
  /** Standard weight/volume factor for an auto pair, else null. */
  auto_factor: number | null;
  /** Factor suggestion parsed from the item name for a needs_factor pair, else null. */
  factor_suggestion: number | null;
  candidates: Q7MaterialLinkCandidate[];
}

export interface Q7MaterialLinkReviewCounts {
  /** Eligible unlinked items in `items`. */
  total: number;
  /** Items with exactly one exact normalized-name match. */
  exact: number;
  /** Exact items whose unit is a standard weight/volume pair (auto). */
  auto: number;
  /** Exact items whose unit pair needs an owner-supplied factor. */
  needs_factor: number;
  /** Eligible items that already have a canonical material. */
  linked_total: number;
}

export interface Q7MaterialLinkReview {
  items: Q7MaterialLinkReviewItem[];
  counts: Q7MaterialLinkReviewCounts;
}

export interface Q7MaterialLinkResult {
  item_id: string;
  material_id: string;
  material_code: string;
  canonical_name: string;
  created_material: boolean;
  request_id: string | null;
}

export interface Q7ExactLinkFailure {
  item_id: string;
  name: string;
  error: string;
}

/** An exact item the bulk left unlinked because its unit pair needs a factor. */
export interface Q7ExactLinkNeedsFactor {
  item_id: string;
  name: string;
  unit: string;
  material_unit: string;
  factor_suggestion: number | null;
}

export interface Q7ExactLinkBatch {
  linked: number;
  needs_factor: Q7ExactLinkNeedsFactor[];
  failed: Q7ExactLinkFailure[];
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

const Q7_UNIT_STATUSES: readonly Q7UnitStatus[] = ["same", "auto", "needs_factor"];

function parseUnitStatus(value: unknown, path: string): Q7UnitStatus {
  if (value === "same" || value === "auto" || value === "needs_factor") return value;
  throw new TypeError(`${path} must be one of ${Q7_UNIT_STATUSES.join(", ")}`);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseMaterial(value: unknown, path: string): Q7MaterialLinkMaterial {
  const row = asRecord(value, path);
  return {
    id: asString(row.id, `${path}.id`),
    material_code: asString(row.material_code, `${path}.material_code`),
    canonical_name: asString(row.canonical_name, `${path}.canonical_name`),
    default_unit: asString(row.default_unit, `${path}.default_unit`),
  };
}

function parseCandidate(value: unknown, path: string): Q7MaterialLinkCandidate {
  const row = asRecord(value, path);
  return {
    ...parseMaterial(row, path),
    score: asNumber(row.score, `${path}.score`),
    unit_status: parseUnitStatus(row.unit_status, `${path}.unit_status`),
  };
}

function parseReviewItem(value: unknown, path: string): Q7MaterialLinkReviewItem {
  const row = asRecord(value, path);
  const unitStatus = row.unit_status;
  return {
    item_id: asString(row.item_id, `${path}.item_id`),
    item_code: asNullableString(row.item_code, `${path}.item_code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    exact_material:
      row.exact_material === null || row.exact_material === undefined
        ? null
        : parseMaterial(row.exact_material, `${path}.exact_material`),
    material_unit: asNullableString(row.material_unit, `${path}.material_unit`),
    unit_status:
      unitStatus === null || unitStatus === undefined
        ? null
        : parseUnitStatus(unitStatus, `${path}.unit_status`),
    auto_factor: asNullableNumber(row.auto_factor, `${path}.auto_factor`),
    factor_suggestion: asNullableNumber(
      row.factor_suggestion,
      `${path}.factor_suggestion`,
    ),
    candidates: asArray(row.candidates, `${path}.candidates`).map((candidate, index) =>
      parseCandidate(candidate, `${path}.candidates[${index}]`),
    ),
  };
}

/** Parse and validate the jsonb returned by get_q7_material_link_review. */
export function parseQ7MaterialLinkReview(raw: unknown): Q7MaterialLinkReview {
  const root = asRecord(raw, "q7MaterialLinkReview");
  const counts = asRecord(root.counts, "q7MaterialLinkReview.counts");
  return {
    items: asArray(root.items, "q7MaterialLinkReview.items").map((item, index) =>
      parseReviewItem(item, `q7MaterialLinkReview.items[${index}]`),
    ),
    counts: {
      total: asNumber(counts.total, "q7MaterialLinkReview.counts.total"),
      exact: asNumber(counts.exact, "q7MaterialLinkReview.counts.exact"),
      auto: asNumber(counts.auto, "q7MaterialLinkReview.counts.auto"),
      needs_factor: asNumber(counts.needs_factor, "q7MaterialLinkReview.counts.needs_factor"),
      linked_total: asNumber(counts.linked_total, "q7MaterialLinkReview.counts.linked_total"),
    },
  };
}

/** Parse and validate one write result (link_q7_item_material). */
export function parseQ7MaterialLinkResult(raw: unknown): Q7MaterialLinkResult {
  const row = asRecord(raw, "q7MaterialLinkResult");
  return {
    item_id: asString(row.item_id, "q7MaterialLinkResult.item_id"),
    material_id: asString(row.material_id, "q7MaterialLinkResult.material_id"),
    material_code: asString(row.material_code, "q7MaterialLinkResult.material_code"),
    canonical_name: asString(row.canonical_name, "q7MaterialLinkResult.canonical_name"),
    created_material: asBoolean(row.created_material, "q7MaterialLinkResult.created_material"),
    request_id: asNullableString(row.request_id, "q7MaterialLinkResult.request_id"),
  };
}

function parseExactLinkFailure(value: unknown, path: string): Q7ExactLinkFailure {
  const row = asRecord(value, path);
  return {
    item_id: asString(row.item_id, `${path}.item_id`),
    name: asString(row.name, `${path}.name`),
    error: asString(row.error, `${path}.error`),
  };
}

function parseExactLinkNeedsFactor(value: unknown, path: string): Q7ExactLinkNeedsFactor {
  const row = asRecord(value, path);
  return {
    item_id: asString(row.item_id, `${path}.item_id`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    material_unit: asString(row.material_unit, `${path}.material_unit`),
    factor_suggestion: asNullableNumber(
      row.factor_suggestion,
      `${path}.factor_suggestion`,
    ),
  };
}

/** Parse and validate the batch result (link_q7_exact_materials). */
export function parseQ7ExactLinkBatch(raw: unknown): Q7ExactLinkBatch {
  const root = asRecord(raw, "q7ExactLinkBatch");
  return {
    linked: asNumber(root.linked, "q7ExactLinkBatch.linked"),
    needs_factor: asArray(root.needs_factor, "q7ExactLinkBatch.needs_factor").map(
      (needs, index) => parseExactLinkNeedsFactor(needs, `q7ExactLinkBatch.needs_factor[${index}]`),
    ),
    failed: asArray(root.failed, "q7ExactLinkBatch.failed").map((failure, index) =>
      parseExactLinkFailure(failure, `q7ExactLinkBatch.failed[${index}]`),
    ),
  };
}

// ---------------------------------------------------------------------------
// Vietnamese error text
// ---------------------------------------------------------------------------

export const Q7_MATERIAL_LINK_ERROR_CODES = [
  "insufficient_privilege",
  "item_already_linked",
  "item_not_eligible",
  "item_skipped",
  "invalid_location",
  "material_inactive",
  "material_not_found",
  "material_name_conflict",
  "material_alias_conflict",
  "material_create_failed",
  "item_required",
  "item_name_required",
  "item_not_linked",
  "invalid_factor",
  "request_id_required",
  "request_id_conflict",
  "unit_factor_required",
  "q7_material_link_failed",
] as const;

export type Q7MaterialLinkErrorCode = (typeof Q7_MATERIAL_LINK_ERROR_CODES)[number];

const Q7_MATERIAL_LINK_ERROR_TEXT: Record<Q7MaterialLinkErrorCode, string> = {
  insufficient_privilege: "Không có quyền liên kết NVL với Material Master.",
  item_already_linked: "Món này vừa được người khác gắn mã chuẩn. Danh sách đã được làm mới.",
  item_not_eligible: "Món này vừa được người khác gắn mã hoặc đã ngưng dùng. Danh sách đã được làm mới.",
  item_skipped: "NVL này đã được đánh dấu bỏ qua, không cần gắn mã.",
  invalid_location: "Kho không hợp lệ (chỉ Q7 hoặc Tân Tạo).",
  material_inactive: "Nguyên liệu chuẩn đang ngừng hoạt động.",
  material_not_found: "Không tìm thấy nguyên liệu chuẩn.",
  material_name_conflict: "Tên NVL trùng với một nguyên liệu chuẩn khác.",
  material_alias_conflict: "Tên NVL đã gắn với một nguyên liệu chuẩn khác.",
  material_create_failed: "Không tạo được nguyên liệu chuẩn từ tên NVL.",
  item_required: "Thiếu NVL cần liên kết.",
  item_name_required: "NVL chưa có tên để tạo nguyên liệu chuẩn.",
  item_not_linked: "Món chưa gắn mã chuẩn",
  invalid_factor: "Số quy đổi phải lớn hơn 0",
  request_id_required: "Thiếu mã yêu cầu liên kết.",
  request_id_conflict: "Mã yêu cầu đã dùng cho NVL khác.",
  unit_factor_required: "Cần nhập hệ số quy đổi từ đơn vị kho sang đơn vị chuẩn.",
  q7_material_link_failed: "Liên kết NVL thất bại. Vui lòng thử lại.",
};

const Q7_MATERIAL_LINK_FALLBACK_TEXT = "Không liên kết được NVL. Vui lòng thử lại.";

/** Vietnamese message for a link error code; unknown codes get a generic message. */
export function q7MaterialLinkErrorText(code: unknown): string {
  const key = String(code ?? "").trim() as Q7MaterialLinkErrorCode;
  return Q7_MATERIAL_LINK_ERROR_TEXT[key] ?? Q7_MATERIAL_LINK_FALLBACK_TEXT;
}

/** Extract a known server error code from a raw RPC/Error message, else null. */
/** Another person linked (or stopped) the item first: the server refused, so the deck must refresh. */
export function isStaleLinkError(error: unknown): boolean {
  const code = q7MaterialLinkErrorCode(error);
  return code === "item_already_linked" || code === "item_not_eligible";
}

export function q7MaterialLinkErrorCode(error: unknown): Q7MaterialLinkErrorCode | null {
  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : String(error ?? "");
  for (const code of Q7_MATERIAL_LINK_ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return null;
}
