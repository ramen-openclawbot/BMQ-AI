import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { shapeMaterialName } from "@/lib/material-name";
import { parseMaterialLearningSuggestion } from "@/lib/material-learning-contract";
export type { MaterialLearningCandidate, MaterialLearningSuggestion } from "@/lib/material-learning-contract";

export interface CanonicalMaterial {
  id: string;
  material_code: string | null;
  canonical_name: string | null;
  normalized_name: string | null;
  default_unit: string | null;
  ingredient_sku_id: string | null;
  active: boolean | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  category: string | null;
  brand: string | null;
  specification: string | null;
  updated_by: string | null;
  version: number | null;
}

export interface MaterialAlias {
  id: string;
  material_id: string | null;
  alias_name: string | null;
  normalized_alias: string | null;
  source?: string | null;
  supplier_id?: string | null;
  source_type?: string | null;
  approved?: boolean | null;
  active: boolean | null;
  metadata?: Record<string, unknown> | null;
  created_by?: string | null;
  created_at: string | null;
}

export interface SupplierProduct {
  id: string;
  material_id: string | null;
  supplier_id: string | null;
  supplier_product_code: string | null;
  supplier_product_name: string | null;
  purchase_unit: string | null;
  base_unit: string | null;
  approved: boolean | null;
  active: boolean | null;
  created_at: string | null;
}

export interface MaterialPriceHistory {
  id: string;
  material_id: string | null;
  supplier_product_id: string | null;
  price_type: string | null;
  price: number | null;
  price_unit: string | null;
  normalized_base_unit_price: number | null;
  effective_from: string | null;
  effective_to: string | null;
  approved: boolean | null;
  created_at: string | null;
}

export interface MaterialUnitConversion {
  id: string;
  material_id: string | null;
  from_unit: string | null;
  to_unit: string | null;
  factor: number | null;
  effective_from: string | null;
  effective_to: string | null;
  approved: boolean | null;
  active: boolean | null;
  created_at: string | null;
}

export interface ResolutionRequest {
  id: string;
  source_type: string | null;
  source_table: string | null;
  source_id: string | null;
  supplier_id: string | null;
  raw_name: string | null;
  raw_code: string | null;
  raw_unit: string | null;
  status: string | null;
  candidate_status: string | null;
  resolved_material_id: string | null;
  reviewer_reason: string | null;
  safe_payload: Record<string, unknown> | null;
  created_at: string | null;
}

export interface MaterialAuditLog {
  id: string;
  material_id: string | null;
  action: string | null;
  reason: string | null;
  actor_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  safe_payload: Record<string, unknown> | null;
  created_at: string | null;
}

export interface SupplierLite {
  id: string;
  name: string | null;
}

export interface Q7Mapping {
  id: string;
  name?: string | null;
  item_code?: string | null;
  product_name?: string | null;
  sku_code?: string | null;
  unit?: string | null;
  canonical_material_id: string | null;
}

export interface FinishedSkuLite {
  id: string;
  sku_code: string | null;
  product_name: string | null;
  unit: string | null;
  sku_type: string | null;
}

export interface CogsMaterialLink {
  id: string;
  sku_id: string | null;
  canonical_material_id: string | null;
  dosage_qty: number | null;
  unit: string | null;
  product_skus: { sku_code: string | null; product_name: string | null; sku_type: string | null } | null;
}

export interface MaterialPaymentRequestLink {
  payment_request_item_id: string;
  payment_request_id: string;
  request_number: string | null;
  request_status: string | null;
  request_created_at: string | null;
  supplier_id: string | null;
  vendor_display_name: string | null;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
  link_state: "linked" | "candidate";
  candidate_source: "linked" | "approved_supplier_product" | "legacy_raw_sku_exact" | null;
  canonical_material_id: string | null;
}

export interface MaterialSupplierSuggestion {
  supplier_id: string;
  supplier_display_name: string | null;
  product_sku_id: string | null;
  supplier_product_id: string | null;
  product_name: string;
  product_code: string | null;
  purchase_unit: string;
  candidate_source: "confirmed_supplier_product" | "supplier_delivery_note_scan" | "cogs_product_sku_exact" | "payment_history_sku_exact" | "payment_history_name_unit" | "payment_history_name_contains";
  evidence_count: number;
  latest_request_at: string | null;
  confirmed: boolean;
  payment_candidate_count: number;
  scan_evidence_id: string | null;
  source_reference: string | null;
  package_quantity: number | null;
  package_unit: string | null;
  suggested_base_quantity: number | null;
  suggested_base_unit: string | null;
}

export interface MaterialUnresolvedSourceName {
  normalized_name: string;
  display_name: string;
  variants: string[];
  source_labels: string[];
  supplier_labels: string[];
  occurrence_count: number;
  total_value: number;
  latest_at: string | null;
}

export interface MaterialCoverageSection {
  key: string;
  loaded: number;
  complete: boolean;
}

export interface MaterialCoverage {
  sections: MaterialCoverageSection[];
  complete: boolean;
  truncated: boolean;
  /** Active canonical materials actually used as a finished-good formulation root. */
  materials_total: number;
  /** Every canonical material row loaded from the catalog, rooted or not. */
  materials_catalog_total: number;
  formulations_total: number;
  /** Formulation rows whose canonical id is null or no longer exists in the catalog. */
  formulations_missing_canonical: number;
  /** Formulation rows with no canonical id at all. */
  formulations_null_root: number;
  /** Formulation rows pointing at a canonical id absent from the loaded catalog. */
  formulations_orphan_root: number;
  approved_scoped_aliases: number;
  approved_supplier_products: number;
  unresolved_total: number;
  unresolved: MaterialUnresolvedSourceName[];
}

export interface MaterialMasterData {
  materials: CanonicalMaterial[];
  aliases: MaterialAlias[];
  scopedAliases: MaterialAlias[];
  supplierProducts: SupplierProduct[];
  prices: MaterialPriceHistory[];
  conversions: MaterialUnitConversion[];
  resolutionRequests: ResolutionRequest[];
  auditLogs: MaterialAuditLog[];
  suppliers: SupplierLite[];
  kitchenMappings: Q7Mapping[];
  finishedSkus: FinishedSkuLite[];
  cogsLinks: CogsMaterialLink[];
  sectionErrors: Record<string, string>;
  coverage: MaterialCoverage;
}

export interface MaterialMasterRolloutDashboardRow {
  source_type: string | null;
  mode: string | null;
  queue_total_count: number | null;
  queue_pending_count: number | null;
  queue_resolved_count: number | null;
  queue_blocked_count: number | null;
  oldest_queue_created_at: string | null;
  latest_queue_created_at: string | null;
  ready_for_enforcement: boolean | null;
  blockers: string[] | Record<string, unknown> | string | null;
  mode_updated_at?: string | null;
}

export type MaterialMasterEnforcementMode = "shadow" | "enforced" | "disabled";

export interface SetMaterialMasterEnforcementModePayload {
  source_type: string;
  expected_mode: string;
  new_mode: MaterialMasterEnforcementMode;
  reason: string;
  readiness_snapshot: Record<string, unknown>;
}

type QueryResult<T> = { data: T[] | null; error: Error | null };
type RpcResult<T> = Promise<{ data: T | null; error: Error | null }>;
type QueryBuilder<T> = {
  select: (columns: string) => QueryBuilder<T>;
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  range: (from: number, to: number) => QueryBuilder<T>;
  eq: (column: string, value: string) => QueryBuilder<T>;
  is: (column: string, value: null) => QueryBuilder<T>;
  then: Promise<QueryResult<T>>["then"];
};
type MaterialMasterDb = {
  from: <T>(table: string) => QueryBuilder<T>;
  rpc: <T>(fn: string, args: Record<string, unknown>) => RpcResult<T>;
};

type FunctionInvokeResult<T> = { data: T | null; error: Error | null };
type MaterialLearningFunctionsClient = {
  functions: {
    invoke: <T>(name: string, options: { body: unknown; signal?: AbortSignal }) => Promise<FunctionInvokeResult<T>>;
  };
};

interface UnresolvedSourceItem {
  id: string;
  payment_request_id?: string | null;
  invoice_id?: string | null;
  product_name: string | null;
  raw_product_name: string | null;
  unit: string | null;
  line_total: number | string | null;
  created_at: string | null;
}

interface SupplierOwnerLite {
  id: string;
  supplier_id: string | null;
}

const db = supabase as unknown as MaterialMasterDb;
const functionsDb = supabase as unknown as MaterialLearningFunctionsClient;

const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const COVERAGE_SECTION_KEYS = [
  "materials",
  "aliases",
  "scopedAliases",
  "supplierProducts",
  "prices",
  "conversions",
  "resolutionRequests",
  "auditLogs",
  "suppliers",
  "kitchenMappings",
  "finishedSkus",
  "cogsLinks",
] as const;
const UNRESOLVED_SHOWN = 50;

const nonEmptyReason = (reason: string) => {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("Vui lòng nhập lý do tiếng Việt trước khi ghi thay đổi.");
  return trimmed;
};

const trimOrNull = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const materialSelect = "id, material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active, created_by, created_at, updated_at, category, brand, specification, updated_by, version";
const aliasSelect = "id, material_id, alias_name, normalized_alias, source, active, created_by, created_at";
const scopedAliasSelect = "id, material_id, supplier_id, source_type, alias_name, normalized_alias, approved, active, metadata, created_at";
const supplierProductSelect = "id, material_id, supplier_id, supplier_product_code, supplier_product_name, purchase_unit, base_unit, approved, active, created_at";
const priceSelect = "id, material_id, supplier_product_id, price_type, price, price_unit, normalized_base_unit_price, effective_from, effective_to, approved, created_at";
const conversionSelect = "id, material_id, from_unit, to_unit, factor, effective_from, effective_to, approved, active, created_at";
const requestSelect = "id, source_type, source_table, source_id, supplier_id, raw_name, raw_code, raw_unit, status, candidate_status, resolved_material_id, reviewer_reason, safe_payload, created_at";
const auditSelect = "id, material_id, action, reason, actor_id, old_values, new_values, safe_payload, created_at";
const supplierSelect = "id, name";
const unresolvedPaymentItemSelect = "id, payment_request_id, product_name, raw_product_name, unit, line_total, created_at";
const unresolvedInvoiceItemSelect = "id, invoice_id, product_name, raw_product_name, unit, line_total, created_at";
const paymentRequestSupplierSelect = "id, supplier_id";
const invoiceSupplierSelect = "id, supplier_id";

async function readAllTable<T>(
  table: string,
  columns: string,
  order: string,
  filters: Array<{ column: string; value: string }>,
  pageSize = PAGE_SIZE,
  nullColumns: string[] = [],
): Promise<QueryResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = db.from<T>(table).select(columns).order(order, { ascending: true }).order("id", { ascending: true }).range(offset, offset + pageSize - 1);
    for (const filter of filters) query = query.eq(filter.column, filter.value);
    for (const column of nullColumns) query = query.is(column, null);
    const { data, error } = await query;
    if (error) throw error;
    const pageRows = (data || []) as T[];
    // A short page is not proof of completeness when the server enforces a lower
    // row cap than `pageSize`, so keep paging until an explicit empty page and
    // advance by the rows actually returned instead of the requested page size.
    if (pageRows.length === 0) return { data: rows, error: null };
    for (const row of pageRows) {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) {
        if (seen.has(id)) throw new Error(`DUPLICATE: bảng "${table}" trả lại dòng đã đọc (${id}); chưa thể xác nhận độ phủ đầy đủ.`);
        seen.add(id);
      }
      rows.push(row);
    }
    offset += pageRows.length;
  }
  // Never silently drop the tail: an incomplete section is reported as an explicit
  // coverage error instead of a short list that looks complete.
  throw new Error(`TRUNCATED: bảng "${table}" vượt quá ${MAX_PAGES} trang an toàn.`);
}

function toValue(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildUnresolvedSourceNames(
  paymentItems: UnresolvedSourceItem[],
  invoiceItems: UnresolvedSourceItem[],
  requestSupplier: Map<string, string | null>,
  invoiceSupplier: Map<string, string | null>,
  supplierNames: Map<string, string>,
): MaterialUnresolvedSourceName[] {
  type Group = MaterialUnresolvedSourceName & { sourceSet: Set<string>; supplierSet: Set<string>; variantSet: Set<string> };
  const groups = new Map<string, Group>();
  const supplierLabel = (supplierId: string | null) => supplierId
    ? (supplierNames.get(supplierId) || `NCC ${supplierId.slice(0, 8)}…`)
    : "Chưa rõ Nhà cung cấp";
  const add = (rows: UnresolvedSourceItem[], label: string, parentId: (row: UnresolvedSourceItem) => string | null, supplierOf: (row: UnresolvedSourceItem) => string | null) => {
    for (const row of rows) {
      const display = (row.raw_product_name || row.product_name || "").trim();
      if (!display) continue;
      // Shape key + source + supplier keeps BỘ/BƠ and different suppliers/sources
      // apart instead of folding every spelling into one review row.
      const shape = shapeMaterialName(display);
      if (!shape) continue;
      const supplierId = supplierOf(row) ?? null;
      const keyId = parentId(row) || "";
      const key = `${shape}|${label}|${supplierId ?? ""}|${keyId}`;
      const current = groups.get(key) || {
        normalized_name: shape,
        display_name: display,
        variants: [],
        source_labels: [],
        supplier_labels: [],
        occurrence_count: 0,
        total_value: 0,
        latest_at: null,
        sourceSet: new Set<string>(),
        supplierSet: new Set<string>(),
        variantSet: new Set<string>(),
      };
      current.occurrence_count += 1;
      current.total_value += toValue(row.line_total);
      current.sourceSet.add(label);
      current.supplierSet.add(supplierLabel(supplierId));
      current.variantSet.add(display);
      if (row.created_at && (!current.latest_at || row.created_at > current.latest_at)) current.latest_at = row.created_at;
      groups.set(key, current);
    }
  };
  add(paymentItems, "Duyệt chi", (row) => row.payment_request_id ?? null, (row) => requestSupplier.get(row.payment_request_id || "") ?? null);
  add(invoiceItems, "Hoá đơn", (row) => row.invoice_id ?? null, (row) => invoiceSupplier.get(row.invoice_id || "") ?? null);
  return Array.from(groups.values())
    .map((group) => ({
      normalized_name: group.normalized_name,
      display_name: group.display_name,
      variants: Array.from(group.variantSet).sort(),
      source_labels: Array.from(group.sourceSet).sort(),
      supplier_labels: Array.from(group.supplierSet).sort(),
      occurrence_count: group.occurrence_count,
      total_value: group.total_value,
      latest_at: group.latest_at,
    }))
    .sort((left, right) => right.total_value - left.total_value
      || right.occurrence_count - left.occurrence_count
      || left.display_name.localeCompare(right.display_name));
}

function buildCoverage(
  reads: PromiseSettledResult<QueryResult<unknown>>[],
  materials: CanonicalMaterial[],
  formulations: CogsMaterialLink[],
  scopedAliases: MaterialAlias[],
  supplierProducts: SupplierProduct[],
  unresolved: MaterialUnresolvedSourceName[],
): MaterialCoverage {
  const sections: MaterialCoverageSection[] = COVERAGE_SECTION_KEYS.map((key, index) => {
    const result = reads[index];
    return {
      key,
      loaded: result.status === "fulfilled" ? ((result.value.data as unknown[] | null) || []).length : 0,
      complete: result.status === "fulfilled",
    };
  });
  // Completeness is derived from every settled read, not from whichever `valueAt`
  // calls happened to run before this point, so a failed alias/audit/request read
  // can never be reported as complete coverage.
  const failed = reads.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const catalogIds = new Set(materials.map((row) => row.id));
  const rootedIds = new Set(
    formulations
      .filter((row) => row.product_skus?.sku_type === "finished_good")
      .map((row) => row.canonical_material_id)
      .filter((id): id is string => Boolean(id)),
  );
  const nullRoot = formulations.filter((row) => !row.canonical_material_id).length;
  const orphanRoot = formulations.filter((row) => Boolean(row.canonical_material_id) && !catalogIds.has(row.canonical_material_id as string)).length;
  return {
    sections,
    complete: failed.length === 0,
    truncated: failed.some((result) => result.reason instanceof Error && result.reason.message.startsWith("TRUNCATED:")),
    // Only active materials that are actually used by a finished-good formulation
    // count as COGS roots; the full catalog size is reported separately.
    materials_total: materials.filter((row) => row.active === true && rootedIds.has(row.id)).length,
    materials_catalog_total: materials.length,
    formulations_total: formulations.length,
    formulations_missing_canonical: nullRoot + orphanRoot,
    formulations_null_root: nullRoot,
    formulations_orphan_root: orphanRoot,
    approved_scoped_aliases: scopedAliases.filter((row) => row.approved === true && row.active === true).length,
    approved_supplier_products: supplierProducts.length,
    unresolved_total: unresolved.length,
    unresolved: unresolved.slice(0, UNRESOLVED_SHOWN),
  };
}

function validateRpcResponse(data: unknown, allowedStatuses: string[], requiredStringKeys: string[] = []) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("RPC không trả object xác nhận.");
  const record = data as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : null;
  if (!status || !allowedStatuses.includes(status)) throw new Error(`RPC trả trạng thái không hợp lệ: ${status || "missing"}`);
  for (const key of requiredStringKeys) {
    if (typeof record[key] !== "string" || !String(record[key]).trim()) throw new Error(`RPC thiếu ID hợp lệ: ${key}`);
  }
  return record;
}

export function useMaterialMaster() {
  return useQuery({
    queryKey: ["material-master", "admin"],
    queryFn: async (): Promise<MaterialMasterData> => {
      const reads = await Promise.allSettled([
        readAllTable<CanonicalMaterial>("sku_cogs_materials", materialSelect, "canonical_name", []),
        readAllTable<MaterialAlias>("sku_cogs_material_aliases", aliasSelect, "created_at", []),
        readAllTable<MaterialAlias>("material_scoped_aliases", scopedAliasSelect, "created_at", []),
        readAllTable<SupplierProduct>("material_supplier_products", supplierProductSelect, "created_at", [{ column: "active", value: "true" }, { column: "approved", value: "true" }]),
        readAllTable<MaterialPriceHistory>("material_price_history", priceSelect, "effective_from", []),
        readAllTable<MaterialUnitConversion>("material_unit_conversions", conversionSelect, "created_at", []),
        readAllTable<ResolutionRequest>("material_resolution_requests", requestSelect, "created_at", []),
        readAllTable<MaterialAuditLog>("material_master_audit_logs", auditSelect, "created_at", []),
        readAllTable<SupplierLite>("suppliers", supplierSelect, "name", []),
        readAllTable<Q7Mapping>("kitchen_inventory_items", "id, item_code, name, unit, canonical_material_id", "name", []),
        readAllTable<FinishedSkuLite>("product_skus", "id, sku_code, product_name, unit, sku_type", "product_name", [{ column: "sku_type", value: "finished_good" }]),
        readAllTable<CogsMaterialLink>("sku_formulations", "id, sku_id, canonical_material_id, dosage_qty, unit, product_skus!sku_formulations_sku_id_fkey(sku_code, product_name, sku_type)", "created_at", [{ column: "product_skus.sku_type", value: "finished_good" }]),
        readAllTable<UnresolvedSourceItem>("payment_request_items", unresolvedPaymentItemSelect, "created_at", [], PAGE_SIZE, ["canonical_material_id"]),
        readAllTable<UnresolvedSourceItem>("invoice_items", unresolvedInvoiceItemSelect, "created_at", [], PAGE_SIZE, ["canonical_material_id"]),
        // Coverage must not inherit the finished-good filter: every formulation row is
        // loaded so a formulation pointing at a non-finished SKU is still counted.
        readAllTable<CogsMaterialLink>("sku_formulations", "id, sku_id, canonical_material_id, dosage_qty, unit, product_skus!sku_formulations_sku_id_fkey(sku_code, product_name, sku_type)", "created_at", []),
        // Supplier context for the unresolved source names (owning request/invoice).
        readAllTable<SupplierOwnerLite>("payment_requests", paymentRequestSupplierSelect, "id", []),
        readAllTable<SupplierOwnerLite>("invoices", invoiceSupplierSelect, "id", []),
      ]);

      const names = [...COVERAGE_SECTION_KEYS, "unresolvedPaymentItems", "unresolvedInvoiceItems", "allFormulations", "paymentRequestSuppliers", "invoiceSuppliers"] as const;
      const sectionErrors: Record<string, string> = {};
      const valueAt = <T,>(index: number): T[] => {
        const result = reads[index];
        if (result.status === "fulfilled") return (result.value.data || []) as T[];
        sectionErrors[names[index]] = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [];
      };

      if (reads[0].status === "rejected") throw reads[0].reason;

      // Collect every section/context read before evaluating coverage so a failure in
      // any of them is reflected in `coverage.complete` instead of being hidden by the
      // order in which `valueAt` happens to run.
      const materials = valueAt<CanonicalMaterial>(0);
      const aliases = valueAt<MaterialAlias>(1);
      const scopedAliases = valueAt<MaterialAlias>(2);
      const supplierProducts = valueAt<SupplierProduct>(3);
      const prices = valueAt<MaterialPriceHistory>(4);
      const conversions = valueAt<MaterialUnitConversion>(5);
      const resolutionRequests = valueAt<ResolutionRequest>(6);
      const auditLogs = valueAt<MaterialAuditLog>(7);
      const suppliers = valueAt<SupplierLite>(8);
      const kitchenMappings = valueAt<Q7Mapping>(9);
      const finishedSkus = valueAt<FinishedSkuLite>(10).filter((sku) => sku.sku_type === "finished_good");
      const cogsLinks = valueAt<CogsMaterialLink>(11).filter((link) => link.product_skus?.sku_type === "finished_good");
      const unresolvedPaymentItems = valueAt<UnresolvedSourceItem>(12);
      const unresolvedInvoiceItems = valueAt<UnresolvedSourceItem>(13);
      const allFormulations = valueAt<CogsMaterialLink>(14);
      const requestSupplier = new Map(valueAt<SupplierOwnerLite>(15).map((row) => [row.id, row.supplier_id]));
      const invoiceSupplier = new Map(valueAt<SupplierOwnerLite>(16).map((row) => [row.id, row.supplier_id]));
      const supplierNames = new Map(suppliers.map((supplier) => [supplier.id, supplier.name || "NCC chưa tên"]));
      const unresolved = buildUnresolvedSourceNames(unresolvedPaymentItems, unresolvedInvoiceItems, requestSupplier, invoiceSupplier, supplierNames);
      const coverage = buildCoverage(reads, materials, allFormulations, scopedAliases, supplierProducts, unresolved);

      return {
        materials,
        aliases,
        scopedAliases,
        supplierProducts,
        prices,
        conversions,
        resolutionRequests,
        auditLogs,
        suppliers,
        kitchenMappings,
        finishedSkus,
        cogsLinks,
        sectionErrors,
        coverage,
      };
    },
  });
}

export function useMaterialPaymentRequestLinks(materialId: string | null) {
  return useQuery({
    queryKey: ["material-master", "payment-request-links", materialId],
    enabled: Boolean(materialId),
    queryFn: async (): Promise<MaterialPaymentRequestLink[]> => {
      if (!materialId) return [];
      const { data, error } = await db.rpc<MaterialPaymentRequestLink[]>("get_material_payment_request_links", {
        p_material_id: materialId,
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("RPC Duyệt chi không trả danh sách hợp lệ.");
      return data;
    },
  });
}

export function useMaterialSupplierSuggestions(materialId: string | null) {
  return useQuery({
    queryKey: ["material-master", "supplier-suggestions", materialId],
    enabled: Boolean(materialId),
    queryFn: async (): Promise<MaterialSupplierSuggestion[]> => {
      if (!materialId) return [];
      const { data, error } = await db.rpc<MaterialSupplierSuggestion[]>("get_material_supplier_suggestions", {
        p_material_id: materialId,
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("RPC gợi ý Nhà cung cấp không trả danh sách hợp lệ.");
      return data;
    },
  });
}

export function useMaterialResolutionRequest(requestId: string | null) {
  return useQuery({
    queryKey: ["material-master", "resolution-request", requestId],
    enabled: Boolean(requestId),
    queryFn: async (): Promise<ResolutionRequest | null> => {
      if (!requestId) return null;
      const { data, error } = await db.from<ResolutionRequest>("material_resolution_requests").select(requestSelect).eq("id", requestId).limit(1);
      if (error) throw error;
      return ((data || [])[0] as ResolutionRequest | undefined) || null;
    },
  });
}

// Request-bound, read-only suggestion. The endpoint never writes and never
// auto-selects; the shared contract parser validates the candidate ids/fields and
// the returned candidate list is offered only for explicit human review.
export function useMaterialLearningSuggestion() {
  return useMutation({
    mutationFn: async (payload: { requestId: string }) => {
      const requestId = payload.requestId?.trim();
      if (!requestId) throw new Error("Cần chọn một dòng cần xác nhận trước khi xin gợi ý.");
      const { data, error } = await functionsDb.functions.invoke<unknown>("material-learning-suggest", {
        body: { request_id: requestId },
      });
      if (error) throw new Error(error.message || "Không gọi được gợi ý NVL.");
      return parseMaterialLearningSuggestion(data, requestId);
    },
  });
}

export function useConfirmMaterialSupplierProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      materialId: string;
      expectedVersion: number;
      supplierId: string;
      productSkuId: string | null;
      productName: string;
      purchaseUnit: string;
      scanEvidenceId?: string | null;
      confirmedBaseQuantity?: number | null;
      confirmedBaseUnit?: string | null;
      reason: string;
    }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại phiên bản NVL trước khi xác nhận Nhà cung cấp.");
      const { data, error } = await db.rpc("confirm_material_supplier_product", {
        p_material_id: payload.materialId,
        p_expected_version: payload.expectedVersion,
        p_supplier_id: payload.supplierId,
        p_product_sku_id: payload.productSkuId,
        p_supplier_product_name: payload.productName.trim(),
        p_purchase_unit: payload.purchaseUnit.trim(),
        p_scan_evidence_id: payload.scanEvidenceId || null,
        p_confirmed_base_quantity: payload.confirmedBaseQuantity || null,
        p_confirmed_base_unit: payload.confirmedBaseUnit?.trim() || null,
        p_reason: nonEmptyReason(payload.reason),
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["supplier_product_confirmed", "supplier_product_unchanged"], ["material_id", "supplier_id", "supplier_product_id"]);
      if (result.material_id !== payload.materialId || result.supplier_id !== payload.supplierId) throw new Error("RPC trả sai sản phẩm Nhà cung cấp đã chọn.");
      return result;
    },
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: ["material-master"] });
      queryClient.invalidateQueries({ queryKey: ["material-master", "supplier-suggestions", payload.materialId] });
      queryClient.invalidateQueries({ queryKey: ["material-master", "payment-request-links", payload.materialId] });
    },
  });
}

export function useSyncMaterialSupplierPaymentRequests() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { materialId: string; expectedVersion: number; supplierProductId: string; reason: string }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại phiên bản NVL trước khi đồng bộ Duyệt chi.");
      const { data, error } = await db.rpc("sync_material_supplier_payment_requests", {
        p_material_id: payload.materialId,
        p_expected_version: payload.expectedVersion,
        p_supplier_product_id: payload.supplierProductId,
        p_reason: nonEmptyReason(payload.reason),
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["payment_requests_synced", "payment_requests_sync_unchanged"], ["material_id", "supplier_product_id"]);
      if (result.material_id !== payload.materialId || result.supplier_product_id !== payload.supplierProductId) throw new Error("RPC trả sai phạm vi đồng bộ Duyệt chi.");
      return result;
    },
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: ["material-master"] });
      queryClient.invalidateQueries({ queryKey: ["material-master", "supplier-suggestions", payload.materialId] });
      queryClient.invalidateQueries({ queryKey: ["material-master", "payment-request-links", payload.materialId] });
    },
  });
}

export function useMaterialMasterRolloutDashboard() {
  return useQuery({
    queryKey: ["material-master", "rollout-dashboard"],
    queryFn: async (): Promise<MaterialMasterRolloutDashboardRow[]> => {
      const { data, error } = await db.rpc("get_material_master_rollout_dashboard", {});
      if (error) throw error;
      return (data || []) as MaterialMasterRolloutDashboardRow[];
    },
  });
}

export function useSetMaterialMasterEnforcementMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: SetMaterialMasterEnforcementModePayload) => {
      const source = payload.source_type.trim();
      if (!source) throw new Error("Thiếu source_type để đổi chế độ controller.");
      const { data, error } = await db.rpc("set_material_master_enforcement_mode", {
        p_source_type: source,
        p_expected_mode: payload.expected_mode,
        p_new_mode: payload.new_mode,
        p_reason: nonEmptyReason(payload.reason),
        p_readiness_snapshot: payload.readiness_snapshot,
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["updated", "mode_changed", "ok"], ["source_type"]);
      if (result.source_type !== source) throw new Error("RPC trả sai source_type sau khi đổi chế độ.");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["material-master", "rollout-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["material-master"] });
    },
  });
}

export function useCreateCanonicalMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { material_code?: string; canonical_name: string; default_unit: string; category?: string; brand?: string; specification?: string; reason: string; request_id?: string | null }) => {
      const { data, error } = await db.rpc("create_canonical_material", {
        p_material_code: trimOrNull(payload.material_code),
        p_canonical_name: payload.canonical_name.trim(),
        p_default_unit: payload.default_unit.trim(),
        p_category: trimOrNull(payload.category),
        p_brand: trimOrNull(payload.brand),
        p_specification: trimOrNull(payload.specification),
        p_reason: nonEmptyReason(payload.reason),
        p_request_id: payload.request_id || null,
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["created"], ["material_id"]);
      if (typeof result.version !== "number" || !Number.isInteger(result.version) || result.version <= 0) throw new Error("RPC không trả version hợp lệ.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["material-master"] }),
  });
}

export function useUpdateCanonicalMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { material_id: string; expectedVersion: number; patch: Partial<Pick<CanonicalMaterial, "canonical_name" | "default_unit" | "active" | "category" | "brand" | "specification">>; reason: string; request_id?: string | null }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại để có version hợp lệ trước khi cập nhật.");
      const patch = Object.fromEntries(Object.entries(payload.patch).filter(([, value]) => value !== undefined));
      if (Object.keys(patch).length === 0) throw new Error("Không có thay đổi được hỗ trợ để cập nhật.");
      const { data, error } = await db.rpc("update_canonical_material", {
        p_material_id: payload.material_id,
        p_expected_version: payload.expectedVersion,
        p_patch: patch,
        p_reason: nonEmptyReason(payload.reason),
        p_request_id: payload.request_id || null,
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["updated"], ["material_id"]);
      if (typeof result.version !== "number" || !Number.isInteger(result.version) || result.version <= payload.expectedVersion) throw new Error("RPC không tăng version như yêu cầu.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["material-master"] }),
  });
}

export type ConfirmResolutionPayload =
  | { request_id: string; action: "reject"; reason: string }
  | { request_id: string; action: "resolve_existing"; material_id: string; raw_alias?: string | null; reason: string }
  | { request_id: string; action: "create_new"; raw_alias?: string | null; create_payload: { material_code?: string; canonical_name: string; default_unit: string; category?: string; brand?: string; specification?: string }; reason: string };

async function readDurableResolution(requestId: string): Promise<ResolutionRequest> {
  const { data, error } = await db.from<ResolutionRequest>("material_resolution_requests").select(requestSelect).eq("id", requestId).limit(1);
  if (error) throw error;
  const row = (data || [])[0] as ResolutionRequest | undefined;
  if (!row) throw new Error("Không tìm thấy dòng xác nhận đã lưu.");
  return row;
}

interface CreatedCanonicalMaterial {
  id: string;
  material_code: string | null;
  canonical_name: string | null;
  default_unit: string | null;
}

const sameCanonicalField = (left: string | null | undefined, right: string | null | undefined) => (left ?? "").trim() === (right ?? "").trim();

// For an unchanged `create_new` the RPC only guarantees a terminal id. Reading the
// actual canonical row lets us confirm it really matches the payload that was
// submitted instead of reporting another reviewer's different material as success.
async function readCreatedCanonicalMaterial(materialId: string): Promise<CreatedCanonicalMaterial | null> {
  const { data, error } = await db.from<CreatedCanonicalMaterial>("sku_cogs_materials")
    .select("id, material_code, canonical_name, default_unit")
    .eq("id", materialId)
    .limit(1);
  if (error) throw error;
  return ((data || [])[0] as CreatedCanonicalMaterial | undefined) || null;
}

function createdPayloadMatches(
  material: CreatedCanonicalMaterial,
  payload: { material_code?: string; canonical_name: string; default_unit: string },
): boolean {
  if (!sameCanonicalField(material.canonical_name, payload.canonical_name)) return false;
  if (!sameCanonicalField(material.default_unit, payload.default_unit)) return false;
  const code = trimOrNull(payload.material_code);
  if (code && !sameCanonicalField(material.material_code, code)) return false;
  return true;
}

export function useConfirmMaterialResolution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ConfirmResolutionPayload) => {
      const reason = nonEmptyReason(payload.reason);
      const base = {
        p_request_id: payload.request_id,
        p_reason: reason,
        p_supplier_product_payload: {},
      };
      const args = payload.action === "reject"
        ? { ...base, p_action: "reject", p_material_id: null, p_create_payload: {}, p_alias_payload: {} }
        : payload.action === "resolve_existing"
          ? {
              ...base,
              p_action: "resolve_existing",
              p_material_id: payload.material_id,
              p_create_payload: {},
              p_alias_payload: {
                alias_name: trimOrNull(payload.raw_alias),
                candidate_source: "manual_selection",
                confidence: "confirmed",
                field_name: "material_master_admin",
              },
            }
          : {
              ...base,
              p_action: "create_new",
              p_material_id: null,
              p_create_payload: {
                material_code: trimOrNull(payload.create_payload.material_code),
                canonical_name: payload.create_payload.canonical_name.trim(),
                default_unit: payload.create_payload.default_unit.trim(),
                category: trimOrNull(payload.create_payload.category),
                brand: trimOrNull(payload.create_payload.brand),
                specification: trimOrNull(payload.create_payload.specification),
              },
              p_alias_payload: {
                alias_name: trimOrNull(payload.raw_alias),
                candidate_source: "manual_selection",
                confidence: "confirmed",
                field_name: "material_master_admin",
              },
            };
      const { data, error } = await db.rpc("confirm_material_resolution", args);
      if (error) throw error;
      const expectedStatus = payload.action === "create_new"
        ? "created_new"
        : payload.action === "resolve_existing"
          ? "resolved_existing"
          : "rejected";
      const result = validateRpcResponse(data, [expectedStatus, "resolution_unchanged"], ["request_id"]);
      if (result.request_id !== payload.request_id) throw new Error("RPC trả sai request ID.");
      if (result.status === "resolution_unchanged") {
        // The RPC already had a terminal row. Compare the durable outcome against the
        // exact intended action/material instead of trusting a generic "unchanged".
        let durable: ResolutionRequest;
        try {
          durable = await readDurableResolution(payload.request_id);
        } catch (readError) {
          throw new Error(`Chưa đọc lại được kết quả đã lưu (${readError instanceof Error ? readError.message : "lỗi đọc"}). Hệ thống không lặp lại thao tác cho tới khi đọc đúng dòng yêu cầu.`);
        }
        const expectedDurableStatus = payload.action === "reject" ? "rejected" : payload.action === "resolve_existing" ? "resolved_existing" : "created_new";
        if (durable.status !== expectedDurableStatus) {
          throw new Error(`Kết quả đã lưu xung đột với thao tác dự kiến (đang là ${durable.status || "không rõ"}). Hệ thống không ghi đè.`);
        }
        if (payload.action === "reject") {
          if (durable.resolved_material_id != null) throw new Error("Kết quả đã lưu là từ chối nhưng vẫn có material ID.");
        } else if (typeof durable.resolved_material_id !== "string" || !durable.resolved_material_id) {
          throw new Error("Kết quả đã lưu thiếu material ID.");
        }
        if (payload.action === "resolve_existing" && durable.resolved_material_id !== payload.material_id) {
          throw new Error("Kết quả đã lưu trỏ về material khác với lựa chọn.");
        }
        if (payload.action === "create_new" && durable.resolved_material_id) {
          // A terminal created_new id alone is not proof of the same intent: another
          // reviewer may have created a different name/unit. Require the actual
          // canonical fields to match the submitted payload before reporting success.
          let existing: CreatedCanonicalMaterial | null;
          try {
            existing = await readCreatedCanonicalMaterial(durable.resolved_material_id);
          } catch (readError) {
            throw new Error(`Chưa đọc lại được NVL đã tạo (${readError instanceof Error ? readError.message : "lỗi đọc"}). Kết quả đã lưu cần rà soát; hệ thống không ghi đè.`);
          }
          if (!existing || !createdPayloadMatches(existing, payload.create_payload)) {
            throw new Error("Kết quả đã lưu là một NVL tạo trước đó nhưng không khớp tên/đơn vị vừa gửi. Kết quả đã lưu cần rà soát; hệ thống không ghi đè.");
          }
        }
        return { ...result, status: durable.status, material_id: durable.resolved_material_id };
      }
      if (payload.action === "reject") {
        if (result.material_id != null) throw new Error("Request từ chối nhưng RPC trả material ID.");
      } else if (typeof result.material_id !== "string" || !result.material_id) {
        throw new Error("RPC không trả material ID sau khi xác nhận.");
      }
      if (payload.action === "resolve_existing" && result.material_id !== payload.material_id) throw new Error("RPC trả sai material đã chọn.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["material-master"] }),
  });
}

export function useLinkMaterialSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { materialId: string; expectedVersion: number; supplierId: string; reason: string }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại phiên bản NVL trước khi liên kết Nhà cung cấp.");
      const { data, error } = await db.rpc("link_material_supplier", {
        p_material_id: payload.materialId,
        p_expected_version: payload.expectedVersion,
        p_supplier_id: payload.supplierId,
        p_reason: nonEmptyReason(payload.reason),
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["supplier_linked", "supplier_link_unchanged"], ["material_id", "supplier_id", "supplier_product_id"]);
      if (result.material_id !== payload.materialId || result.supplier_id !== payload.supplierId) throw new Error("RPC trả sai liên kết Nhà cung cấp đã chọn.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["material-master"] }),
  });
}

export function useLinkMaterialToSkuCogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      materialId: string;
      expectedVersion: number;
      skuId: string;
      dosageQty: number;
      wastagePercent: number;
      standardUnitPrice: number | null;
      effectiveFrom: string;
      reason: string;
    }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại phiên bản NVL trước khi liên kết Giá vốn.");
      if (!Number.isFinite(payload.dosageQty) || payload.dosageQty <= 0) throw new Error("Định lượng NVL phải lớn hơn 0.");
      if (!Number.isFinite(payload.wastagePercent) || payload.wastagePercent < 0 || payload.wastagePercent > 100) throw new Error("Hao hụt phải từ 0% đến 100%.");
      const { data, error } = await db.rpc("link_material_to_sku_cogs", {
        p_material_id: payload.materialId,
        p_expected_version: payload.expectedVersion,
        p_sku_id: payload.skuId,
        p_dosage_qty: payload.dosageQty,
        p_wastage_percent: payload.wastagePercent,
        p_standard_unit_price: payload.standardUnitPrice,
        p_effective_from: payload.effectiveFrom,
        p_reason: nonEmptyReason(payload.reason),
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["cogs_linked", "cogs_link_unchanged"], ["material_id", "sku_id", "formulation_id"]);
      if (result.material_id !== payload.materialId || result.sku_id !== payload.skuId) throw new Error("RPC trả sai liên kết SKU Giá vốn đã chọn.");
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["material-master"] }),
  });
}

export function useLinkMaterialPaymentRequestItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { materialId: string; expectedVersion: number; paymentRequestItemId: string; reason: string }) => {
      if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion <= 0) throw new Error("Cần tải lại phiên bản NVL trước khi liên kết Duyệt chi.");
      const { data, error } = await db.rpc("link_material_payment_request_item", {
        p_material_id: payload.materialId,
        p_expected_material_version: payload.expectedVersion,
        p_payment_request_item_id: payload.paymentRequestItemId,
        p_reason: nonEmptyReason(payload.reason),
      });
      if (error) throw error;
      const result = validateRpcResponse(data, ["payment_request_linked", "payment_request_link_unchanged"], ["material_id", "payment_request_item_id", "request_id"]);
      if (result.material_id !== payload.materialId || result.payment_request_item_id !== payload.paymentRequestItemId) throw new Error("RPC trả sai dòng Duyệt chi đã chọn.");
      return result;
    },
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: ["material-master"] });
      queryClient.invalidateQueries({ queryKey: ["material-master", "payment-request-links", payload.materialId] });
    },
  });
}
