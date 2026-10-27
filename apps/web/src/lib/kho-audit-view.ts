import type { KhoAuditKind, KhoAuditRow } from "./kho-audit.ts";

/**
 * View helpers for the Nhật ký kho page: Vietnam day / time of an event, the kind filter groups,
 * and the readable "what changed" lines of one row. Pure, so the page stays thin.
 */

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
const timeFmt = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });

/** yyyy-mm-dd of the event in Vietnam time. */
export const vnDay = (iso: string): string => dayFmt.format(new Date(iso));
/** hh:mm of the event in Vietnam time. */
export const vnTime = (iso: string): string => timeFmt.format(new Date(iso));
const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

/** "Hôm nay · 27/10", "Hôm qua · 26/10", else "26/10/2026". */
export function dayHeading(day: string, today: string): string {
  const [y, m, d] = day.split("-");
  const short = `${d}/${m}`;
  if (day === today) return `Hôm nay · ${short}`;
  const yesterday = dayFmt.format(new Date(new Date(`${today}T12:00:00+07:00`).getTime() - 86_400_000));
  if (day === yesterday) return `Hôm qua · ${short}`;
  return `${short}/${y}`;
}

export interface KhoAuditDay { day: string; rows: KhoAuditRow[] }

/** Group newest-first rows by Vietnam day, keeping order. */
export function groupByDay(rows: KhoAuditRow[]): KhoAuditDay[] {
  const out: KhoAuditDay[] = [];
  for (const row of rows) {
    const day = vnDay(row.occurred_at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else out.push({ day, rows: [row] });
  }
  return out;
}

export type KhoAuditGroupId = "all" | "item" | "stock" | "unit";

/** The filter chips: what each one sends as `p_kinds` (null = everything). */
export const KHO_AUDIT_GROUPS: ReadonlyArray<{ id: KhoAuditGroupId; label: string; kinds: KhoAuditKind[] | null }> = [
  { id: "all", label: "Tất cả", kinds: null },
  { id: "item", label: "Sửa món", kinds: ["created", "renamed", "unit_changed", "class_changed", "note_changed", "activated", "deactivated", "places_changed", "merged", "code_changed", "edited"] },
  { id: "stock", label: "Tồn kho", kinds: ["receipt", "stock_count", "adjustment", "transfer", "production_use", "opening"] },
  { id: "unit", label: "Đơn vị", kinds: ["unit_added", "conversion_changed"] },
];

export interface KhoAuditLine { label: string; text: string }

const FIELD_LABEL: Record<string, string> = {
  name: "Tên",
  unit: "Đơn vị",
  active: "Trạng thái",
  item_class: "Loại hàng",
  note: "Ghi chú",
  in_tan_tao: "Có ở Kho Tân Tạo",
  pastry_q7: "Bánh ngọt sang Q7",
  merged_into_id: "Gộp vào món khác",
  item_code: "Mã món",
};
const CLASS_LABEL: Record<string, string> = { raw_material: "Nguyên liệu", packaging_supply: "Bao bì & vật tư", non_stock: "Vật tư", finished_goods: "Thành phẩm" };
const KHO_NAME: Record<string, string> = { tan_tao: "Tân Tạo", q7: "Q7" };

function value(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "active") return v ? "Bật" : "Tắt";
  if (typeof v === "boolean") return v ? "Có" : "Không";
  if (field === "item_class") return CLASS_LABEL[String(v)] ?? String(v);
  if (field === "merged_into_id") return "đã gộp";
  return String(v);
}

const isChange = (v: unknown): v is { old: unknown; new: unknown } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "new" in v && "old" in v;

const qty = (n: unknown) => (typeof n === "number" ? String(Math.round(n * 1000) / 1000).replace(".", ",") : String(n));

/** Readable lines of one row: before → after for item edits, the numbers for ledger rows. */
export function auditLines(row: KhoAuditRow): KhoAuditLine[] {
  const d = row.details;
  const lines: KhoAuditLine[] = [];
  const fields = Object.keys(FIELD_LABEL).filter((f) => isChange(d[f]));
  if (fields.length) {
    const created = row.kind === "created";
    for (const f of fields) {
      const c = d[f] as { old: unknown; new: unknown };
      if (created) {
        if (c.new !== null && c.new !== undefined && c.new !== "") lines.push({ label: FIELD_LABEL[f], text: value(f, c.new) });
      } else {
        lines.push({ label: FIELD_LABEL[f], text: `${value(f, c.old)} → ${value(f, c.new)}` });
      }
    }
    return lines;
  }
  if (d.quantity !== undefined) lines.push({ label: "Số lượng", text: `${qty(d.quantity)} ${d.unit ?? ""}`.trim() });
  if (d.from_location || d.to_location) lines.push({ label: "Chiều chuyển", text: `${KHO_NAME[String(d.from_location)] ?? d.from_location} → ${KHO_NAME[String(d.to_location)] ?? d.to_location}` });
  const slip = d.slip_number ?? d.transfer_number;
  if (slip) lines.push({ label: "Phiếu", text: String(slip) });
  const date = d.movement_date ?? d.transfer_date;
  if (typeof date === "string") lines.push({ label: "Ngày ghi sổ", text: dmy(date) });
  if (typeof d.unit === "string" && d.quantity === undefined) lines.push({ label: "Đơn vị", text: d.unit });
  if (typeof d.note === "string" && d.note.trim()) lines.push({ label: "Ghi chú", text: d.note });
  return lines;
}
