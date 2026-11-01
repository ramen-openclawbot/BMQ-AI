// KFM minimum order: the sum of all KFM POs delivered on one day, counted in pieces (cái).
export const KFM_DAILY_MOQ_PIECES = 1500;
// KFM does not take an order under 600 packages (gói/hộp/cái as ordered) per delivery day (owner 01/11).
export const KFM_DAILY_MIN_PACKS = 600;

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

// Pieces per ordered unit: BÁNH CUA PHÔ MAI is a box of 3; CROFFLE/CROISSANT 160G are boxes of 4.
export const kfmPiecesPerUnit = (productName: string) => {
  const name = fold(productName || "");
  if (name.includes("cua pho mai")) return 3;
  if ((name.includes("croffle") || name.includes("croissant")) && name.includes("160g")) return 4;
  return 1;
};

export const kfmMoqPieces = (items: Array<{ product_name: string; qty: number }>) =>
  items.reduce((sum, item) => sum + Number(item.qty || 0) * kfmPiecesPerUnit(item.product_name), 0);

export type KfmProductionPreflightOrder = {
  id: string;
  productionNumber: string;
  poNumber: string;
  packs: number;
  cancellable: boolean;
};

export type KfmProductionPreflight = {
  isKfm: boolean;
  deliveryDate: string | null;
  minPacks: number;
  newPacks: number;
  existing: KfmProductionPreflightOrder[];
  otherPacks: number;
  totalPacks: number;
  belowMin: boolean;
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  return String(value);
};

const asNullableText = (value: unknown): string | null => {
  const text = asText(value).trim();
  return text === "" ? null : text;
};

const asNumber = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value).trim().replace(/\s/g, "");
  if (text === "") return fallback;
  const normalized =
    text.includes(",") && !text.includes(".")
      ? text.replace(",", ".")
      : text.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return fallback;
};

export const kfmShortPacks = (total: number, min = KFM_DAILY_MIN_PACKS): number => {
  const value = Number(total);
  if (!Number.isFinite(value)) return min;
  return Math.max(0, min - value);
};

/**
 * Defensive parser for the kfm_production_preflight RPC. PostgREST may return
 * numerics as strings, and older/newer payloads may omit optional fields.
 */
export const parseKfmProductionPreflight = (
  payload: unknown,
): KfmProductionPreflight => {
  const root = asRecord(payload);
  const isKfm = asBoolean(root.is_kfm ?? root.isKfm, false);
  const minPacks = asNumber(root.min_packs ?? root.minPacks, KFM_DAILY_MIN_PACKS);
  const newPacks = asNumber(root.new_packs ?? root.newPacks, 0);
  const otherPacks = asNumber(root.other_packs ?? root.otherPacks, 0);
  const totalRaw = root.total_packs ?? root.totalPacks;
  const totalPacks =
    totalRaw === null || totalRaw === undefined || totalRaw === ""
      ? otherPacks + newPacks
      : asNumber(totalRaw, otherPacks + newPacks);
  const belowRaw = root.below_min ?? root.belowMin;
  const belowMin =
    belowRaw === null || belowRaw === undefined
      ? isKfm && totalPacks < minPacks
      : asBoolean(belowRaw, false);
  const existingRaw = Array.isArray(root.existing) ? root.existing : [];

  return {
    isKfm,
    deliveryDate: asNullableText(root.delivery_date ?? root.deliveryDate),
    minPacks,
    newPacks,
    existing: existingRaw.map((entry) => {
      const row = asRecord(entry);
      return {
        id: asText(row.id),
        productionNumber: asText(
          row.production_number ?? row.productionNumber,
        ),
        poNumber: asText(row.po_number ?? row.poNumber),
        packs: asNumber(row.packs, 0),
        cancellable: asBoolean(row.cancellable, false),
      };
    }),
    otherPacks,
    totalPacks,
    belowMin,
  };
};
