import { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";

export type MaterialResolutionStatus =
  | "resolved_exact"
  | "confirmation_needed"
  | "ambiguous"
  | "not_found"
  | "inactive"
  | "unit_unmapped"
  | "supplier_unmapped"
  | "controller_error";

export interface MaterialControllerLineInput {
  source_type: "match_delivery_note" | "goods_receipt" | "purchase_order" | "payment_request" | "invoice" | "create_invoice_from_pr" | "sku_cogs";
  source_table: "goods_receipt_items" | "purchase_order_items" | "payment_request_items" | "invoice_items" | "sku_formulations";
  source_id?: string | null;
  source_line_id?: string | null;
  supplier_id?: string | null;
  raw_name: string;
  raw_code?: string | null;
  raw_unit?: string | null;
  effective_date?: string | null;
  payload?: Record<string, unknown>;
  applyExactToGoodsReceiptItem?: boolean;
  applyExactToProcurementLine?: boolean;
}

export interface MaterialControllerResult {
  canonical_material_id: string | null;
  canonical_material_code: string | null;
  canonical_material_name: string | null;
  canonical_default_unit: string | null;
  material_resolution_status: MaterialResolutionStatus;
  material_resolution_request_id: string | null;
  resolved_exact: boolean;
  blockers: string[];
  candidate_material_ids: string[];
  candidate_names: string[];
  match_source: string | null;
}

type JsonRecord = Record<string, unknown>;
type RpcResult<T> = { data: T | null; error: { message?: string; code?: string } | null };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function booleanField(value: JsonRecord, key: string): boolean {
  return value[key] === true;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function controllerError(blocker: string, requestId: string | null = null): MaterialControllerResult {
  return {
    canonical_material_id: null,
    canonical_material_code: null,
    canonical_material_name: null,
    canonical_default_unit: null,
    material_resolution_status: "controller_error",
    material_resolution_request_id: requestId,
    resolved_exact: false,
    blockers: [blocker],
    candidate_material_ids: [],
    candidate_names: [],
    match_source: null,
  };
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`${label} timed out`));
    }, ms);
  });
  return Promise.race([promise, timeout]);
}

export async function resolveCanonicalMaterialForLine(
  supabase: SupabaseClient,
  input: MaterialControllerLineInput,
): Promise<MaterialControllerResult> {
  const rawName = (input.raw_name || "").trim();
  const rawCode = input.raw_code?.trim() || null;
  const rawUnit = input.raw_unit?.trim() || null;

  if (!rawName) {
    return {
      canonical_material_id: null,
      canonical_material_code: null,
      canonical_material_name: null,
      canonical_default_unit: null,
      material_resolution_status: "not_found",
      material_resolution_request_id: null,
      resolved_exact: false,
      blockers: ["raw_name_required"],
      candidate_material_ids: [],
      candidate_names: [],
      match_source: null,
    };
  }

  try {
    const { data: resolvedData, error: resolveError } = await withTimeout<RpcResult<unknown>>(
      supabase.rpc("resolve_canonical_material", {
        p_raw_name: rawName,
        p_raw_code: rawCode,
        p_raw_unit: rawUnit,
        p_supplier_id: input.supplier_id || null,
        p_source_type: input.source_type,
        p_effective_date: input.effective_date || new Date().toISOString().slice(0, 10),
        p_required_capabilities: input.source_type === "sku_cogs" ? ["unit", "standard_cost"] : (input.supplier_id ? ["unit", "supplier_product"] : ["unit"]),
      }),
      8000,
      "resolve_canonical_material",
    );
    if (resolveError || !isRecord(resolvedData)) return controllerError("material_controller_resolve_failed");

    const resolved = resolvedData;
    const status = (stringField(resolved, "status") || "not_found") as MaterialResolutionStatus;
    const resolvedExact = booleanField(resolved, "resolved_exact");
    const materialId = stringField(resolved, "material_id");
    const blockers = asStringArray(resolved.blockers);
    const candidateIds = asStringArray(resolved.candidates);

    let requestId: string | null = null;
    if (!resolvedExact && (input.source_line_id || input.source_type === "sku_cogs")) {
      const { data: requestData, error: requestError } = await withTimeout<RpcResult<unknown>>(
        supabase.rpc("request_material_resolution", {
          p_source_type: input.source_type,
          p_source_table: input.source_table,
          p_source_id: input.source_id || null,
          p_source_line_id: input.source_line_id || null,
          p_raw_name: rawName,
          p_raw_code: rawCode,
          p_raw_unit: rawUnit,
          p_supplier_id: input.supplier_id || null,
          p_payload: {
            candidate_source: "delivery_note_ocr",
            confidence: "pending",
            field_name: "goods_receipt_item_material",
            ...(input.payload || {}),
          },
        }),
        8000,
        "request_material_resolution",
      );
      if (requestError || !isRecord(requestData)) return controllerError("material_controller_request_failed");
      requestId = stringField(requestData, "request_id");
      const requestStatus = stringField(requestData, "status");
      if (!requestId || !["request_created", "request_existing", "already_resolved"].includes(requestStatus || "")) {
        return controllerError("material_controller_request_failed");
      }
    }

    if (resolvedExact && input.applyExactToGoodsReceiptItem && input.source_line_id && materialId) {
      const { data: applyData, error: applyError } = await withTimeout<RpcResult<unknown>>(
        supabase.rpc("apply_goods_receipt_item_material_resolution", {
          p_goods_receipt_item_id: input.source_line_id,
          p_expected_material_id: materialId,
          p_raw_name: rawName,
          p_raw_code: rawCode,
          p_raw_unit: rawUnit,
          p_supplier_id: input.supplier_id || null,
          p_source_type: input.source_type,
          p_reason: "delivery note OCR exact approved canonical material",
        }),
        8000,
        "apply_goods_receipt_item_material_resolution",
      );
      if (applyError || !isRecord(applyData)) return controllerError("material_controller_apply_failed", requestId);
      const applyStatus = stringField(applyData, "status");
      const applySourceId = stringField(applyData, "source_id");
      const applyMaterialId = stringField(applyData, "material_id");
      const applyRequestId = stringField(applyData, "request_id");
      if (
        !["linked", "linked_unchanged"].includes(applyStatus || "") ||
        applySourceId !== input.source_line_id ||
        applyMaterialId !== materialId ||
        !applyRequestId
      ) {
        return controllerError("material_controller_apply_failed", requestId);
      }
      requestId = applyRequestId;
    }

    if (resolvedExact && input.applyExactToProcurementLine && input.source_line_id && materialId) {
      const { data: applyData, error: applyError } = await withTimeout<RpcResult<unknown>>(
        supabase.rpc("apply_procurement_line_material_resolution", {
          p_source_table: input.source_table,
          p_source_line_id: input.source_line_id || null,
          p_raw_name: rawName,
          p_raw_code: rawCode,
          p_raw_unit: rawUnit,
          p_supplier_id: input.supplier_id || null,
          p_source_type: input.source_type,
          p_reason: "procurement exact approved canonical material",
        }),
        8000,
        "apply_procurement_line_material_resolution",
      );
      if (applyError || !isRecord(applyData)) return controllerError("material_controller_procurement_apply_failed", requestId);
      const applyStatus = stringField(applyData, "status");
      const applySourceId = stringField(applyData, "source_id");
      const applyMaterialId = stringField(applyData, "material_id");
      const applyRequestId = stringField(applyData, "request_id");
      if (
        !["linked", "linked_unchanged"].includes(applyStatus || "") ||
        applySourceId !== input.source_line_id ||
        applyMaterialId !== materialId ||
        !applyRequestId
      ) {
        return controllerError("material_controller_procurement_apply_failed", requestId);
      }
      requestId = applyRequestId;
    }

    const requestedApplySucceeded =
      !resolvedExact ||
      !input.source_line_id ||
      (((!input.applyExactToGoodsReceiptItem) || !!requestId) &&
        ((!input.applyExactToProcurementLine) || !!requestId));

    return {
      canonical_material_id: resolvedExact && requestedApplySucceeded ? materialId : null,
      canonical_material_code: resolvedExact ? stringField(resolved, "material_code") : null,
      canonical_material_name: resolvedExact ? stringField(resolved, "canonical_name") : null,
      canonical_default_unit: resolvedExact ? stringField(resolved, "default_unit") : null,
      material_resolution_status: status,
      material_resolution_request_id: requestId,
      resolved_exact: resolvedExact && requestedApplySucceeded,
      blockers: requestedApplySucceeded ? blockers : [...blockers, "material_controller_apply_incomplete"],
      candidate_material_ids: candidateIds,
      candidate_names: [],
      match_source: stringField(resolved, "match_source"),
    };
  } catch (_error) {
    return controllerError("material_controller_unavailable");
  }
}
