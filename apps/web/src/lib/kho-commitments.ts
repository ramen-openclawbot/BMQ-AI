/**
 * Pure data layer for what open orders already hold in Kho.
 *
 * Server contract (apps/web/supabase/migrations/20261102580000_kho_commitments.sql):
 *   kho_get_commitments() -> KhoCommitments
 *
 * The RPC is read-only.  Ingredient commitments are future-dated production
 * usage rows; finished-SKU commitments are reserved Tân Tạo outbound orders and
 * Q7 production-order lines whose production date has not arrived yet.
 */

export type KhoCommitmentLocation = "tan_tao" | "q7";

export interface KhoItemCommitmentSource {
  kind: "pxk";
  /** PXK issue number when it resolves, otherwise the ledger source. */
  ref: string;
  date: string;
  qty: number;
}

export interface KhoItemCommitment {
  kitchen_inventory_item_id: string;
  location: KhoCommitmentLocation;
  committed_qty: number;
  unit: string;
  next_date: string | null;
  sources: KhoItemCommitmentSource[];
}

export interface KhoSkuCommitment {
  location: KhoCommitmentLocation;
  sku_id: string;
  sku_code: string;
  name: string;
  unit: string;
  on_hand: number;
  /** Expected the same days: open supplier orders (Tân Tạo) or planned production (Q7). */
  incoming_qty: number;
  committed_qty: number;
  overdue_qty: number;
  available: number;
  orders: number;
  next_date: string | null;
}

export interface KhoCommitmentGaps {
  pxk_lines_unposted: number;
  pxk_unposted_issues: string[];
}

export interface KhoCommitments {
  as_of: string;
  items: KhoItemCommitment[];
  skus: KhoSkuCommitment[];
  gaps: KhoCommitmentGaps;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function asDate(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new TypeError(`${path} must be an ISO date`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${path} must be a real date`);
  }
  return value;
}

function asNullableDate(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return asDate(value, path);
}

function asLocation(value: unknown, path: string): KhoCommitmentLocation {
  const location = asString(value, path);
  if (location !== "tan_tao" && location !== "q7") {
    throw new TypeError(`${path} is invalid`);
  }
  return location;
}

function parseSource(raw: unknown, path: string): KhoItemCommitmentSource {
  const row = asRecord(raw, path);
  const kind = asString(row.kind, `${path}.kind`);
  if (kind !== "pxk") throw new TypeError(`${path}.kind is invalid`);
  return {
    kind,
    ref: asString(row.ref, `${path}.ref`),
    date: asDate(row.date, `${path}.date`),
    qty: asNumber(row.qty, `${path}.qty`),
  };
}

function parseItem(raw: unknown, path: string): KhoItemCommitment {
  const row = asRecord(raw, path);
  return {
    kitchen_inventory_item_id: asString(
      row.kitchen_inventory_item_id,
      `${path}.kitchen_inventory_item_id`,
    ),
    location: asLocation(row.location, `${path}.location`),
    committed_qty: asNumber(row.committed_qty, `${path}.committed_qty`),
    unit: asString(row.unit, `${path}.unit`),
    next_date: asNullableDate(row.next_date, `${path}.next_date`),
    sources: asArray(row.sources, `${path}.sources`).map((source, index) =>
      parseSource(source, `${path}.sources[${index}]`),
    ),
  };
}

function parseSku(raw: unknown, path: string): KhoSkuCommitment {
  const row = asRecord(raw, path);
  return {
    location: asLocation(row.location, `${path}.location`),
    sku_id: asString(row.sku_id, `${path}.sku_id`),
    sku_code: asString(row.sku_code, `${path}.sku_code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    on_hand: asNumber(row.on_hand, `${path}.on_hand`),
    incoming_qty: asNumber(row.incoming_qty, `${path}.incoming_qty`),
    committed_qty: asNumber(row.committed_qty, `${path}.committed_qty`),
    overdue_qty: asNumber(row.overdue_qty, `${path}.overdue_qty`),
    available: asNumber(row.available, `${path}.available`),
    orders: asNumber(row.orders, `${path}.orders`),
    next_date: asNullableDate(row.next_date, `${path}.next_date`),
  };
}

function parseGaps(raw: unknown, path: string): KhoCommitmentGaps {
  const row = asRecord(raw, path);
  return {
    pxk_lines_unposted: asNumber(row.pxk_lines_unposted, `${path}.pxk_lines_unposted`),
    pxk_unposted_issues: asArray(row.pxk_unposted_issues, `${path}.pxk_unposted_issues`).map(
      (issue, index) => asString(issue, `${path}.pxk_unposted_issues[${index}]`),
    ),
  };
}

/** Parse the jsonb object returned by `kho_get_commitments`. */
export function parseKhoCommitments(raw: unknown): KhoCommitments {
  const root = asRecord(raw, "khoCommitments");
  return {
    as_of: asDate(root.as_of, "khoCommitments.as_of"),
    items: asArray(root.items, "khoCommitments.items").map((item, index) =>
      parseItem(item, `khoCommitments.items[${index}]`),
    ),
    skus: asArray(root.skus, "khoCommitments.skus").map((sku, index) =>
      parseSku(sku, `khoCommitments.skus[${index}]`),
    ),
    gaps: parseGaps(root.gaps, "khoCommitments.gaps"),
  };
}

/** Map keyed `${location}:${kitchen_inventory_item_id}`. */
export function commitmentByItem(c: KhoCommitments): Map<string, KhoItemCommitment> {
  return new Map(
    c.items.map((item) => [
      `${item.location}:${item.kitchen_inventory_item_id}`,
      item,
    ]),
  );
}

/** Map keyed `${location}:${sku_code}`. */
export function commitmentBySku(c: KhoCommitments): Map<string, KhoSkuCommitment> {
  return new Map(
    c.skus.map((sku) => [`${sku.location}:${sku.sku_code}`, sku]),
  );
}

function utcDay(value: string): number {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${value} must be an ISO date`);
  return parsed.getTime();
}

/** 'hôm nay' / 'ngày mai' / 'dd/mm'; null has no date to label. */
export function dayLabel(asOf: string, date: string | null | undefined): string {
  if (date === null || date === undefined || date === "") return "—";
  const today = utcDay(asOf);
  const target = utcDay(date);
  if (target === today) return "hôm nay";
  if (target === today + 24 * 60 * 60 * 1000) return "ngày mai";
  const parsed = new Date(target);
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}
