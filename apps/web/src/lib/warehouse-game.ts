/**
 * Pure helpers for the "Kho 2D" warehouse game (2026-10-23).
 *
 * The parsers validate the JSON returned by
 *   public.get_warehouse_game_snapshot(text),
 *   public.rename_stock_item(uuid, text, uuid) and
 *   public.change_stock_item_unit(uuid, text, numeric, uuid).
 *
 * unitConversionFor mirrors public.stock_units: a weight / volume pair converts
 * by the to_base ratio (1 old unit = factor new units), every other pair is null
 * because a pack or count change needs an explicit factor from the operator.
 */

import {
  parseMaterialAliasBacklogReview,
  type MaterialAliasBacklogReviewRow,
} from "./material-alias.ts";
import { STOCK_ITEM_CLASSES } from "./stock-catalog.ts";
import { STOCK_UNITS, stockUnitCode } from "./stock-units.ts";

export type WarehouseGameLocation = "q7" | "tan_tao";

/** `null` item_class is shown as this group in the snapshot. */
export const WAREHOUSE_GAME_UNCLASSIFIED = "unclassified";

export interface WarehouseGameAlias {
  normalized_name: string;
  status: string;
  line_class: string;
  supplier_name: string | null;
}

export interface WarehouseGameItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  item_class: string;
  on_hand: number;
  last_count_date: string | null;
  aliases: WarehouseGameAlias[];
  /** Owner rule 2026-10-12: pastry raw materials received at Tân Tạo go to Q7. */
  pastry_q7: boolean;
}

/** One Tân Tạo -> Q7 stock transfer (automatic receipt or manual slip). */
export interface WarehouseGameTransfer {
  transfer_number: string;
  transfer_date: string;
  item_id: string;
  item_name: string;
  quantity: number;
  unit: string;
  receipt_number: string | null;
  /** 'auto_goods_receipt' | 'manual'; null on an older server payload. */
  source: string | null;
  /** Manual slip shared by every line of one call; null for an automatic row. */
  slip_id: string | null;
  /** Manual slip number CKP-YYYYMMDD-XXXXXX; null for an automatic row. */
  slip_number: string | null;
  note: string | null;
}

export interface WarehouseGameSku {
  id: string;
  sku_code: string;
  product_name: string;
  unit: string;
  on_hand: number;
}

export type WarehouseGamePendingRow = MaterialAliasBacklogReviewRow;

export interface WarehouseGameSnapshot {
  location: WarehouseGameLocation;
  cutover_date: string | null;
  items: WarehouseGameItem[];
  skus: WarehouseGameSku[];
  pending: WarehouseGamePendingRow[];
  transfers: WarehouseGameTransfer[];
  counts: Record<string, number>;
  can_edit: boolean;
}

export interface SetItemPastryQ7Result {
  item_id: string;
  pastry_q7: boolean;
}

export interface RenameStockItemResult {
  item_id: string;
  old_name: string;
  new_name: string;
}

export interface ChangeStockItemUnitResult {
  item_id: string;
  old_unit: string;
  new_unit: string;
  factor: number;
  merge_id: string | null;
}

/** One line of a manual Tân Tạo -> Q7 transfer slip. */
export interface ManualStockTransferLine {
  transfer_id: string;
  transfer_number: string;
  item_id: string;
  item_name: string;
  quantity: number;
  unit: string;
}

/** The jsonb result of public.create_manual_stock_transfer. */
export interface ManualStockTransferResult {
  slip_id: string;
  slip_number: string;
  transfer_date: string;
  lines: ManualStockTransferLine[];
}

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

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

/** Older payloads have no pastry_q7: treat a missing key as false. */
function asBooleanDefaultFalse(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false;
  return asBoolean(value, path);
}

function asLocation(value: unknown, path: string): WarehouseGameLocation {
  const location = asString(value, path);
  if (location !== "q7" && location !== "tan_tao") throw new TypeError(`${path} is invalid`);
  return location;
}

function asItemClass(value: unknown, path: string): string {
  const itemClass = asString(value, path);
  if (itemClass !== WAREHOUSE_GAME_UNCLASSIFIED && !(STOCK_ITEM_CLASSES as readonly string[]).includes(itemClass)) {
    throw new TypeError(`${path} is invalid`);
  }
  return itemClass;
}

function asAliasStatus(value: unknown, path: string): string {
  const status = asString(value, path);
  if (status !== "learning" && status !== "auto" && status !== "disabled") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function asLineClass(value: unknown, path: string): string {
  const lineClass = asString(value, path);
  if (lineClass !== "stock" && lineClass !== "non_stock") {
    throw new TypeError(`${path} is invalid`);
  }
  return lineClass;
}

/** Parse and validate one alias row of a snapshot item. */
function parseWarehouseGameAlias(raw: unknown, path: string): WarehouseGameAlias {
  const row = asRecord(raw, path);
  return {
    normalized_name: asString(row.normalized_name, `${path}.normalized_name`),
    status: asAliasStatus(row.status, `${path}.status`),
    line_class: asLineClass(row.line_class, `${path}.line_class`),
    supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
  };
}

/** Parse and validate one shared catalog item of the snapshot. */
function parseWarehouseGameItem(raw: unknown, path: string): WarehouseGameItem {
  const row = asRecord(raw, path);
  const rawAliases = row.aliases;
  if (!Array.isArray(rawAliases)) throw new TypeError(`${path}.aliases must be an array`);
  return {
    id: asString(row.id, `${path}.id`),
    code: asString(row.code, `${path}.code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    item_class: asItemClass(row.item_class, `${path}.item_class`),
    on_hand: asNumber(row.on_hand, `${path}.on_hand`),
    last_count_date: asNullableString(row.last_count_date, `${path}.last_count_date`),
    aliases: rawAliases.map((alias, index) =>
      parseWarehouseGameAlias(alias, `${path}.aliases[${index}]`),
    ),
    pastry_q7: asBooleanDefaultFalse(row.pastry_q7, `${path}.pastry_q7`),
  };
}

/** Parse and validate one Tân Tạo -> Q7 transfer row. */
function parseWarehouseGameTransfer(raw: unknown, path: string): WarehouseGameTransfer {
  const row = asRecord(raw, path);
  return {
    transfer_number: asString(row.transfer_number, `${path}.transfer_number`),
    transfer_date: asString(row.transfer_date, `${path}.transfer_date`),
    item_id: asString(row.item_id, `${path}.item_id`),
    item_name: asString(row.item_name, `${path}.item_name`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
    unit: asString(row.unit, `${path}.unit`),
    receipt_number: asNullableString(row.receipt_number, `${path}.receipt_number`),
    // Older payloads have no source / slip columns: a missing key is null.
    source: asNullableString(row.source, `${path}.source`),
    slip_id: asNullableString(row.slip_id, `${path}.slip_id`),
    slip_number: asNullableString(row.slip_number, `${path}.slip_number`),
    note: asNullableString(row.note, `${path}.note`),
  };
}

/**
 * Parse the jsonb array returned by `get_stock_transfers`. A missing / null
 * payload is an empty list so an older server keeps the UI usable.
 */
export function parseWarehouseGameTransfers(raw: unknown): WarehouseGameTransfer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TypeError("warehouseGameTransfers must be an array");
  return raw.map((transfer, index) =>
    parseWarehouseGameTransfer(transfer, `warehouseGameTransfers[${index}]`),
  );
}

/** Parse and validate one finished-goods SKU of the snapshot. */
function parseWarehouseGameSku(raw: unknown, path: string): WarehouseGameSku {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    sku_code: asString(row.sku_code, `${path}.sku_code`),
    product_name: asString(row.product_name, `${path}.product_name`),
    unit: asString(row.unit, `${path}.unit`),
    on_hand: asNumber(row.on_hand, `${path}.on_hand`),
  };
}

/** Parse and validate the JSON returned by `get_warehouse_game_snapshot`. */
export function parseWarehouseGameSnapshot(raw: unknown): WarehouseGameSnapshot {
  const root = asRecord(raw, "warehouseGameSnapshot");

  const rawItems = root.items;
  if (!Array.isArray(rawItems)) throw new TypeError("items must be an array");
  const items = rawItems.map((item, index) =>
    parseWarehouseGameItem(item, `items[${index}]`),
  );

  const rawSkus = root.skus;
  if (!Array.isArray(rawSkus)) throw new TypeError("skus must be an array");
  const skus = rawSkus.map((sku, index) => parseWarehouseGameSku(sku, `skus[${index}]`));

  const rawPending = root.pending;
  if (!Array.isArray(rawPending)) throw new TypeError("pending must be an array");
  const pending = parseMaterialAliasBacklogReview(rawPending);

  const transfers = parseWarehouseGameTransfers(root.transfers);

  const rawCounts = asRecord(root.counts, "counts");
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawCounts)) {
    counts[key] = asNumber(value, `counts.${key}`);
  }

  return {
    location: asLocation(root.location, "location"),
    cutover_date: asNullableString(root.cutover_date, "cutover_date"),
    items,
    skus,
    pending,
    transfers,
    counts,
    can_edit: asBoolean(root.can_edit, "can_edit"),
  };
}

/** Parse and validate the JSON returned by `set_item_pastry_q7`. */
export function parseSetItemPastryQ7Result(raw: unknown): SetItemPastryQ7Result {
  const root = asRecord(raw, "setItemPastryQ7Result");
  return {
    item_id: asString(root.item_id, "setItemPastryQ7Result.item_id"),
    pastry_q7: asBoolean(root.pastry_q7, "setItemPastryQ7Result.pastry_q7"),
  };
}

/** Parse and validate the JSON returned by `rename_stock_item`. */
export function parseRenameStockItemResult(raw: unknown): RenameStockItemResult {
  const root = asRecord(raw, "renameStockItemResult");
  return {
    item_id: asString(root.item_id, "renameStockItemResult.item_id"),
    old_name: asString(root.old_name, "renameStockItemResult.old_name"),
    new_name: asString(root.new_name, "renameStockItemResult.new_name"),
  };
}

/** Parse and validate the JSON returned by `change_stock_item_unit`. */
export function parseChangeStockItemUnitResult(raw: unknown): ChangeStockItemUnitResult {
  const root = asRecord(raw, "changeStockItemUnitResult");
  return {
    item_id: asString(root.item_id, "changeStockItemUnitResult.item_id"),
    old_unit: asString(root.old_unit, "changeStockItemUnitResult.old_unit"),
    new_unit: asString(root.new_unit, "changeStockItemUnitResult.new_unit"),
    factor: asNumber(root.factor, "changeStockItemUnitResult.factor"),
    merge_id: asNullableString(root.merge_id, "changeStockItemUnitResult.merge_id"),
  };
}

/** Parse and validate one line of a manual transfer slip. */
function parseManualTransferLine(raw: unknown, path: string): ManualStockTransferLine {
  const row = asRecord(raw, path);
  return {
    transfer_id: asString(row.transfer_id, `${path}.transfer_id`),
    transfer_number: asString(row.transfer_number, `${path}.transfer_number`),
    item_id: asString(row.item_id, `${path}.item_id`),
    item_name: asString(row.item_name, `${path}.item_name`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
    unit: asString(row.unit, `${path}.unit`),
  };
}

/**
 * Defensive parser for the jsonb returned by `create_manual_stock_transfer`.
 * Every slip field and every line field is required; a malformed payload throws.
 */
export function parseManualTransferResult(raw: unknown): ManualStockTransferResult {
  const root = asRecord(raw, "manualTransferResult");
  const rawLines = root.lines;
  if (!Array.isArray(rawLines)) {
    throw new TypeError("manualTransferResult.lines must be an array");
  }
  return {
    slip_id: asString(root.slip_id, "manualTransferResult.slip_id"),
    slip_number: asString(root.slip_number, "manualTransferResult.slip_number"),
    transfer_date: asString(root.transfer_date, "manualTransferResult.transfer_date"),
    lines: rawLines.map((line, index) =>
      parseManualTransferLine(line, `manualTransferResult.lines[${index}]`),
    ),
  };
}

const MANUAL_TRANSFER_ERROR_TEXT: Record<string, string> = {
  transfer_forbidden: "Tài khoản chưa có quyền chuyển kho Tân Tạo.",
  stock_insufficient: "Tồn kho Tân Tạo không đủ để chuyển.",
  ledger_not_started: "Sổ kho chưa bắt đầu, chưa thể chuyển kho.",
  quantity_invalid: "Số lượng chuyển phải là số lớn hơn 0.",
  duplicate_item: "Một mặt hàng bị lặp lại trong phiếu.",
  item_invalid: "Mặt hàng không hợp lệ, đã ngừng dùng hoặc đã gộp.",
  lines_required: "Phiếu chuyển phải có ít nhất 1 mặt hàng.",
  too_many_lines: "Phiếu chuyển chỉ được tối đa 30 mặt hàng.",
  date_invalid: "Ngày chuyển không được ở tương lai.",
};

const MANUAL_TRANSFER_FALLBACK = "Không chuyển kho được. Vui lòng thử lại.";

/** Vietnamese message for a create_manual_stock_transfer error code. */
export const manualTransferErrorText = (code: unknown): string => {
  const value = String(code ?? "").trim();
  if (value in MANUAL_TRANSFER_ERROR_TEXT) return MANUAL_TRANSFER_ERROR_TEXT[value];
  const hit = Object.keys(MANUAL_TRANSFER_ERROR_TEXT).find((key) => value.includes(key));
  return hit ? MANUAL_TRANSFER_ERROR_TEXT[hit] : MANUAL_TRANSFER_FALLBACK;
};

/**
 * 1 oldUnit = factor newUnit, for a weight / volume pair of public.stock_units.
 * Returns null when either spelling is unknown, the kinds differ or the pair is
 * a count / pack change (which needs an explicit factor from the operator).
 */
export function unitConversionFor(
  oldUnit: string | null | undefined,
  newUnit: string | null | undefined,
): number | null {
  const oldCode = stockUnitCode(oldUnit);
  const newCode = stockUnitCode(newUnit);
  if (oldCode === null || newCode === null) return null;
  const oldRow = STOCK_UNITS.find((unit) => unit.code === oldCode);
  const newRow = STOCK_UNITS.find((unit) => unit.code === newCode);
  if (!oldRow || !newRow) return null;
  if (oldRow.kind !== newRow.kind) return null;
  if (oldRow.kind !== "weight" && oldRow.kind !== "volume") return null;
  if (oldRow.baseCode !== newRow.baseCode) return null;
  return oldRow.toBase / newRow.toBase;
}
