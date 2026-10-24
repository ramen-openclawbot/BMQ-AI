/**
 * Pure data layer for the kho ATTP (food-safety) checklist.
 *
 * Server contract:
 *   kho_attp_checklist(int) -> { generated_at, days, totals, suppliers, items_by_item }
 *   kho_attp_set_profile(uuid, text)
 *   food_cert_upload_pending(...), food_cert_confirm(...), food_cert_link_items(...)
 *   edge function scan-food-cert
 *
 * The required-kind table below is mirrored by public.kho_attp_required_kinds
 * in migration 20261102990000; scripts/test_kho_attp_contract.py asserts both
 * stay identical.  Nothing here writes stock or the ledger.
 */

export type AttpProfile =
  | "packaged_food"
  | "fresh_meat"
  | "fresh_produce"
  | "food_contact_packaging"
  | "none";

export type AttpKind =
  | "attp_facility"
  | "product_declaration"
  | "coa"
  | "quarantine";

export type AttpRequirementState = "ok" | "warn" | "wait" | "miss" | "na";

export type AttpStateFilter = "miss" | "wait" | "warn" | "all";

export type AttpProfileSource = "set" | "default";

/** Mirror of public.kho_attp_required_kinds(); order is significant. */
export const ATTP_REQUIRED_KINDS: Record<AttpProfile, readonly AttpKind[]> = {
  packaged_food: ["attp_facility", "product_declaration", "coa"],
  fresh_meat: ["attp_facility", "quarantine"],
  fresh_produce: ["attp_facility"],
  food_contact_packaging: ["product_declaration", "coa"],
  none: [],
};

export const ATTP_PROFILE_LABELS: Record<AttpProfile, string> = {
  packaged_food: "Thực phẩm đóng gói",
  fresh_meat: "Thịt tươi",
  fresh_produce: "Rau củ tươi",
  food_contact_packaging: "Bao bì tiếp xúc thực phẩm",
  none: "Không cần hồ sơ",
};

export const ATTP_KIND_LABELS: Record<AttpKind, string> = {
  attp_facility: "Giấy chứng nhận cơ sở ATTP",
  product_declaration: "Bản công bố sản phẩm",
  coa: "Phiếu kiểm nghiệm",
  quarantine: "Giấy kiểm dịch",
};

export const ATTP_STATE_LABELS: Record<AttpRequirementState, string> = {
  ok: "Đủ",
  warn: "Sắp hết hạn",
  wait: "Chờ kiểm tra",
  miss: "Thiếu",
  na: "Không cần",
};

export interface AttpTotals {
  ok: number;
  warn: number;
  wait: number;
  miss: number;
  total: number;
  done: number;
  pct: number;
}

export interface AttpExpiredCert {
  cert_id: string;
  cert_no: string | null;
  expires_on: string;
}

export interface AttpRequirement {
  kind: AttpKind;
  state: AttpRequirementState;
  cert_id: string | null;
  cert_no: string | null;
  expires_on: string | null;
  days_left: number | null;
  shared_count: number;
  /** Only present for state 'wait': the OCR extract awaiting confirmation. */
  extracted: Record<string, unknown> | null;
  /** Only present for state 'miss' when an expired confirmed cert exists. */
  expired_cert: AttpExpiredCert | null;
}

export interface AttpChecklistItem {
  item_id: string;
  item_code: string | null;
  name: string;
  profile: AttpProfile;
  profile_source: AttpProfileSource;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  supplier_id?: string;
  supplier_name?: string;
  requirements: AttpRequirement[];
  totals: AttpTotals;
}

export interface AttpSupplier {
  supplier_id: string;
  name: string;
  totals: AttpTotals;
  items: AttpChecklistItem[];
}

export interface AttpChecklist {
  generated_at: string;
  days: number;
  totals: AttpTotals;
  suppliers: AttpSupplier[];
  /** One entry per item, de-duplicated across suppliers. */
  items_by_item: AttpChecklistItem[];
}

export interface AttpCountable {
  state: AttpRequirementState;
}

// ---------------------------------------------------------------------------
// scan-food-cert edge function
// ---------------------------------------------------------------------------

export type ScanFoodCertType = AttpKind | "other";

export interface ScanFoodCertEvidence {
  holder: string | null;
  cert_no: string | null;
  expires: string | null;
}

export interface ScanFoodCertMatch {
  kind: "manufacturer" | "supplier";
  id: string;
  name: string;
  score: number;
}

export interface ScanFoodCertResult {
  ok: true;
  cert_type: ScanFoodCertType;
  holder_name: string | null;
  cert_no: string | null;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  validity_years: number | null;
  expires_computed: boolean;
  product_name: string | null;
  evidence: ScanFoodCertEvidence;
  ocr_engine: "indra" | "deepseek";
  ocr_fallback_reason: string | null;
  match: ScanFoodCertMatch | null;
  suggested_item_ids: string[];
}

export interface ScanFoodCertInput {
  imageBase64?: string | null;
  mimeType?: string | null;
  /** Path inside the private food-safety-docs bucket, e.g. certs/<id>/a.pdf. */
  filePath?: string | null;
}

function emptyTotals(): AttpTotals {
  return { ok: 0, warn: 0, wait: 0, miss: 0, total: 0, done: 0, pct: 100 };
}

/** Count requirement states, excluding 'na' from every denominator. */
export function stateCounts(requirements: readonly AttpCountable[]): AttpTotals {
  const totals = emptyTotals();
  for (const requirement of requirements) {
    switch (requirement.state) {
      case "ok":
        totals.ok += 1;
        break;
      case "warn":
        totals.warn += 1;
        break;
      case "wait":
        totals.wait += 1;
        break;
      case "miss":
        totals.miss += 1;
        break;
      default:
        break;
    }
  }
  totals.total = totals.ok + totals.warn + totals.wait + totals.miss;
  totals.done = totals.ok + totals.warn;
  totals.pct = totals.total === 0
    ? 100
    : Math.round((totals.done * 100) / totals.total);
  return totals;
}

function withItemTotals(item: AttpChecklistItem): AttpChecklistItem {
  return { ...item, totals: stateCounts(item.requirements) };
}

/**
 * Keep only suppliers/items that still have at least one requirement in the
 * requested state, and recompute every total from the retained rows.  'all'
 * returns the checklist unchanged.
 */
export function filterByState(
  checklist: AttpChecklist,
  state: AttpStateFilter,
): AttpChecklist {
  if (state === "all") return checklist;

  const suppliers: AttpSupplier[] = [];
  for (const supplier of checklist.suppliers) {
    const items: AttpChecklistItem[] = [];
    for (const item of supplier.items) {
      const requirements = item.requirements.filter((requirement) => requirement.state === state);
      if (requirements.length === 0) continue;
      items.push(withItemTotals({ ...item, requirements }));
    }
    if (items.length === 0) continue;
    suppliers.push({
      ...supplier,
      items,
      totals: stateCounts(items.flatMap((item) => item.requirements)),
    });
  }

  const itemsByItem: AttpChecklistItem[] = [];
  for (const item of checklist.items_by_item ?? []) {
    const requirements = item.requirements.filter((requirement) => requirement.state === state);
    if (requirements.length === 0) continue;
    itemsByItem.push(withItemTotals({ ...item, requirements }));
  }

  return {
    ...checklist,
    suppliers,
    items_by_item: itemsByItem,
    totals: stateCounts(suppliers.flatMap((supplier) => supplier.items.flatMap((item) => item.requirements))),
  };
}

/** "Theo món kho": one row per item, even when two suppliers sold it. */
export function flattenByItem(checklist: AttpChecklist): AttpChecklistItem[] {
  if (checklist.items_by_item?.length) return checklist.items_by_item;

  const seen = new Map<string, AttpChecklistItem>();
  for (const supplier of checklist.suppliers) {
    for (const item of supplier.items) {
      if (!seen.has(item.item_id)) seen.set(item.item_id, item);
    }
  }
  return [...seen.values()];
}
