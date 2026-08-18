import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
  candidate_source: "confirmed_supplier_product" | "cogs_product_sku_exact" | "payment_history_sku_exact" | "payment_history_name_unit";
  evidence_count: number;
  latest_request_at: string | null;
  confirmed: boolean;
  payment_candidate_count: number;
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
  then: Promise<QueryResult<T>>["then"];
};
type MaterialMasterDb = {
  from: <T>(table: string) => QueryBuilder<T>;
  rpc: <T>(fn: string, args: Record<string, unknown>) => RpcResult<T>;
};

const db = supabase as unknown as MaterialMasterDb;

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

async function readTable<T>(table: string, columns: string, order = "created_at", limit = 500): Promise<QueryResult<T>> {
  const { data, error } = await db.from<T>(table).select(columns).order(order, { ascending: false }).limit(limit);
  if (error) throw error;
  return { data, error };
}

async function readAllTable<T>(
  table: string,
  columns: string,
  order: string,
  filters: Array<{ column: string; value: string }>,
  pageSize = 500,
): Promise<QueryResult<T>> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let query = db.from<T>(table).select(columns).order(order, { ascending: true }).order("id", { ascending: true }).range(from, from + pageSize - 1);
    for (const filter of filters) query = query.eq(filter.column, filter.value);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { data: rows, error: null };
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
        readTable<MaterialAlias>("sku_cogs_material_aliases", aliasSelect, "created_at"),
        readTable<MaterialAlias>("material_scoped_aliases", scopedAliasSelect, "created_at"),
        readAllTable<SupplierProduct>("material_supplier_products", supplierProductSelect, "created_at", [{ column: "active", value: "true" }, { column: "approved", value: "true" }]),
        readAllTable<MaterialPriceHistory>("material_price_history", priceSelect, "effective_from", []),
        readTable<MaterialUnitConversion>("material_unit_conversions", conversionSelect, "created_at"),
        readTable<ResolutionRequest>("material_resolution_requests", requestSelect, "created_at"),
        readTable<MaterialAuditLog>("material_master_audit_logs", auditSelect, "created_at"),
        readAllTable<SupplierLite>("suppliers", supplierSelect, "name", []),
        readTable<Q7Mapping>("kitchen_inventory_items", "id, item_code, name, unit, canonical_material_id", "name"),
        readAllTable<FinishedSkuLite>("product_skus", "id, sku_code, product_name, unit, sku_type", "product_name", [{ column: "sku_type", value: "finished_good" }]),
        readAllTable<CogsMaterialLink>("sku_formulations", "id, sku_id, canonical_material_id, dosage_qty, unit, product_skus!inner(sku_code, product_name, sku_type)", "created_at", [{ column: "product_skus.sku_type", value: "finished_good" }]),
      ]);

      const names = ["materials", "aliases", "scopedAliases", "supplierProducts", "prices", "conversions", "resolutionRequests", "auditLogs", "suppliers", "kitchenMappings", "finishedSkus", "cogsLinks"] as const;
      const sectionErrors: Record<string, string> = {};
      const valueAt = <T,>(index: number): T[] => {
        const result = reads[index];
        if (result.status === "fulfilled") return (result.value.data || []) as T[];
        sectionErrors[names[index]] = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return [];
      };

      if (reads[0].status === "rejected") throw reads[0].reason;

      return {
        materials: valueAt<CanonicalMaterial>(0),
        aliases: valueAt<MaterialAlias>(1),
        scopedAliases: valueAt<MaterialAlias>(2),
        supplierProducts: valueAt<SupplierProduct>(3),
        prices: valueAt<MaterialPriceHistory>(4),
        conversions: valueAt<MaterialUnitConversion>(5),
        resolutionRequests: valueAt<ResolutionRequest>(6),
        auditLogs: valueAt<MaterialAuditLog>(7),
        suppliers: valueAt<SupplierLite>(8),
        kitchenMappings: valueAt<Q7Mapping>(9),
        finishedSkus: valueAt<FinishedSkuLite>(10).filter((sku) => sku.sku_type === "finished_good"),
        cogsLinks: valueAt<CogsMaterialLink>(11).filter((link) => link.product_skus?.sku_type === "finished_good"),
        sectionErrors,
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
