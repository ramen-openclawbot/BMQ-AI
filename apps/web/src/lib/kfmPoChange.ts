/**
 * Typed data layer for KFM PO quantity changes detected by the intake scan.
 *
 * No visual components. The parser accepts the Edge response defensively and
 * drops any element that does not have the complete, safe shape; the UI can
 * render the result without re-validating it.
 */

export type KfmPoChangeLine = {
  sku: string;
  productName: string;
  unit: string;
  oldQty: number;
  newQty: number;
};

export type KfmPoChange = {
  orderId: number;
  code: string;
  inboxId: string;
  deliveryDate: string;
  revision: string;
  lines: KfmPoChangeLine[];
  oldTotalQty: number;
  newTotalQty: number;
  productionOrders: Array<{ id: string; productionNumber: string; status: string }>;
  blocked: boolean;
};

export type KfmPoChangeSummary = {
  increased: number;
  decreased: number;
  added: number;
  removed: number;
  deltaTotal: number;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asQuantity(value: unknown): number | null {
  const quantity = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : NaN;
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : null;
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function parseLine(value: unknown): KfmPoChangeLine | null {
  const row = asRecord(value);
  if (!row) return null;
  const sku = asText(row.sku);
  const productName = typeof row.productName === "string" ? row.productName : null;
  const unit = typeof row.unit === "string" ? row.unit : null;
  const oldQty = asQuantity(row.oldQty);
  const newQty = asQuantity(row.newQty);
  if (!sku || productName === null || unit === null || oldQty === null || newQty === null) return null;
  return { sku, productName, unit, oldQty, newQty };
}

function parseProductionOrder(value: unknown): KfmPoChange["productionOrders"][number] | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = asText(row.id);
  const productionNumber = asText(row.productionNumber);
  const status = asText(row.status);
  if (!id || !productionNumber || !status) return null;
  return { id, productionNumber, status };
}

function parseChange(value: unknown): KfmPoChange | null {
  const row = asRecord(value);
  if (!row) return null;

  const orderId = typeof row.orderId === "number" ? row.orderId : NaN;
  const code = asText(row.code);
  const inboxId = asText(row.inboxId);
  const deliveryDate = asText(row.deliveryDate);
  const revision = asText(row.revision);
  const oldTotalQty = asQuantity(row.oldTotalQty);
  const newTotalQty = asQuantity(row.newTotalQty);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) return null;
  if (!code || !inboxId || !isIsoDay(deliveryDate)) return null;
  if (!/^[0-9a-f]{64}$/i.test(revision)) return null;
  if (oldTotalQty === null || newTotalQty === null) return null;
  if (typeof row.blocked !== "boolean") return null;

  if (!Array.isArray(row.lines) || !Array.isArray(row.productionOrders)) return null;
  const lines: KfmPoChangeLine[] = [];
  for (const item of row.lines) {
    const line = parseLine(item);
    if (!line) return null;
    lines.push(line);
  }
  const productionOrders: KfmPoChange["productionOrders"] = [];
  for (const item of row.productionOrders) {
    const order = parseProductionOrder(item);
    if (!order) return null;
    productionOrders.push(order);
  }

  return {
    orderId,
    code,
    inboxId,
    deliveryDate,
    revision,
    lines,
    oldTotalQty,
    newTotalQty,
    productionOrders,
    blocked: row.blocked,
  };
}

/** Keep only complete, safe change objects; malformed elements are discarded. */
export function parseKfmPoChanges(value: unknown): KfmPoChange[] {
  if (!Array.isArray(value)) return [];
  const changes: KfmPoChange[] = [];
  for (const item of value) {
    const change = parseChange(item);
    if (change) changes.push(change);
  }
  return changes;
}

const roundQuantity = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Counts describe lines: a line that appears (old 0) is "added" and a line
 * that disappears (new 0) is "removed", rather than an increase/decrease.
 */
export function summarizeKfmPoChange(change: KfmPoChange): KfmPoChangeSummary {
  let increased = 0;
  let decreased = 0;
  let added = 0;
  let removed = 0;
  for (const line of change.lines) {
    if (line.newQty > line.oldQty) {
      if (line.oldQty === 0) added += 1;
      else increased += 1;
    } else if (line.newQty < line.oldQty) {
      if (line.newQty === 0) removed += 1;
      else decreased += 1;
    }
  }
  return {
    increased,
    decreased,
    added,
    removed,
    deltaTotal: roundQuantity(change.newTotalQty - change.oldTotalQty),
  };
}
