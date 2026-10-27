/**
 * Pure data layer for the Kho audit feed (nhật ký kho).
 *
 * Server contract:
 *   kho_get_audit_log(date, date, uuid, uuid, text[], integer, timestamptz)
 *     -> { items: KhoAuditRow[], has_more: boolean }
 *
 * One row is a normalised event from the item catalog log, the Tân Tạo / Q7
 * ledgers, stock_transfers or stock_unit_events.  The parser is strict about
 * the documented shape and ignores unknown top-level fields; `details` stays an
 * object because each source carries different useful columns.
 */

export const KHO_AUDIT_KINDS = [
  "created",
  "renamed",
  "unit_changed",
  "class_changed",
  "note_changed",
  "activated",
  "deactivated",
  "places_changed",
  "merged",
  "code_changed",
  "edited",
  "receipt",
  "stock_count",
  "adjustment",
  "transfer",
  "production_use",
  "opening",
  "unit_added",
  "conversion_changed",
] as const;

export type KhoAuditKind = (typeof KHO_AUDIT_KINDS)[number];

export type KhoAuditLocation = "tan_tao" | "q7";

export interface KhoAuditRow {
  /** Stable row id; with occurred_at it is the paging cursor. */
  key: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  kind: KhoAuditKind;
  location: KhoAuditLocation | null;
  item_id: string | null;
  item_name: string | null;
  summary: string;
  details: Record<string, unknown>;
}

export interface KhoAuditPage {
  items: KhoAuditRow[];
  has_more: boolean;
}

/** Vietnamese label for every kind the server can emit. */
export const KHO_AUDIT_KIND_LABELS: Record<KhoAuditKind, string> = {
  created: "Tạo món",
  renamed: "Đổi tên",
  unit_changed: "Đổi đơn vị",
  class_changed: "Đổi loại món",
  note_changed: "Đổi ghi chú",
  activated: "Bật món",
  deactivated: "Tắt món",
  places_changed: "Đổi nơi lưu kho",
  merged: "Gộp món",
  code_changed: "Đổi mã món",
  edited: "Cập nhật món",
  receipt: "Nhập kho",
  stock_count: "Kiểm kê",
  adjustment: "Điều chỉnh",
  transfer: "Chuyển kho",
  production_use: "Dùng sản xuất",
  opening: "Tồn đầu kỳ",
  unit_added: "Thêm đơn vị",
  conversion_changed: "Đổi quy đổi",
};

export function khoAuditKindLabel(kind: KhoAuditKind): string {
  return KHO_AUDIT_KIND_LABELS[kind];
}

const KIND_SET = new Set<string>(KHO_AUDIT_KINDS);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asTimestamp(value: unknown, path: string): string {
  const text = asString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${path} must be an ISO timestamp`);
  }
  return text;
}

function asKind(value: unknown, path: string): KhoAuditKind {
  const kind = asString(value, path);
  if (!KIND_SET.has(kind)) throw new TypeError(`${path} is not a known audit kind`);
  return kind as KhoAuditKind;
}

function asLocation(value: unknown, path: string): KhoAuditLocation | null {
  if (value === null || value === undefined) return null;
  const location = asString(value, path);
  if (location !== "tan_tao" && location !== "q7") {
    throw new TypeError(`${path} must be tan_tao, q7 or null`);
  }
  return location;
}

function parseRow(raw: unknown, path: string): KhoAuditRow {
  const row = asRecord(raw, path);
  return {
    key: asString(row.key, `${path}.key`),
    occurred_at: asTimestamp(row.occurred_at, `${path}.occurred_at`),
    actor_id: asNullableString(row.actor_id, `${path}.actor_id`),
    actor_name: asNullableString(row.actor_name, `${path}.actor_name`),
    kind: asKind(row.kind, `${path}.kind`),
    location: asLocation(row.location, `${path}.location`),
    item_id: asNullableString(row.item_id, `${path}.item_id`),
    item_name: asNullableString(row.item_name, `${path}.item_name`),
    summary: asString(row.summary, `${path}.summary`),
    details: asRecord(row.details, `${path}.details`),
  };
}

/** Parse the jsonb payload returned by `kho_get_audit_log`. */
export function parseKhoAuditPage(raw: unknown): KhoAuditPage {
  const root = asRecord(raw, "khoAuditPage");
  return {
    items: asArray(root.items, "khoAuditPage.items").map((row, index) =>
      parseRow(row, `khoAuditPage.items[${index}]`),
    ),
    has_more: asBoolean(root.has_more, "khoAuditPage.has_more"),
  };
}
