import { supabase } from "@/integrations/supabase/client";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

type RpcError = { message?: string; code?: string; details?: string; hint?: string };
type RpcResponse<T> = Promise<{ data: T | null; error: RpcError | null }>;
type RpcClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): RpcResponse<T>;
};

const rpcClient = supabase as unknown as RpcClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCUREMENT_SOURCE_TABLES = ["purchase_order_items", "payment_request_items", "invoice_items"] as const;
const PROCUREMENT_LINE_KINDS = ["raw_material", "finished_good", "service_or_non_material", "unknown", "unknown_material_relevance"] as const;
const PROCUREMENT_LINE_STATUSES = ["created", "linked", "linked_unchanged", "unknown", "finished_good", "service_or_non_material", "pending_resolution", "resolution_pending", "no_material_required", "ready", "blocked", "updated"] as const;
const PO_STATUSES = ["draft", "sent", "in_transit", "completed", "cancelled"] as const;
const INVOICE_STATUSES = ["created", "draft"] as const;

export type ProcurementSourceTable = (typeof PROCUREMENT_SOURCE_TABLES)[number];
export type ProcurementLineKind = (typeof PROCUREMENT_LINE_KINDS)[number];
export type ProcurementLineStatus = (typeof PROCUREMENT_LINE_STATUSES)[number];
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

type UnknownRecord = Record<string, unknown>;

export interface ProcurementLineControllerResult {
  line_id: string;
  status: ProcurementLineStatus;
  line_kind: ProcurementLineKind;
  material_id: string | null;
  request_id: string | null;
  resolved_exact: boolean;
}

export interface PurchaseOrderStatusControllerResult {
  status: PurchaseOrderStatus;
  order: JsonRecord | null;
  receipt: JsonRecord | null;
  readiness: JsonRecord | null;
}

export interface PaymentRequestApprovalControllerResult {
  approved: boolean;
  readiness: JsonRecord | null;
  sku_processing_status: string;
}

export interface InvoiceControllerResult {
  status: "created" | "draft";
  invoice_id: string;
  items_count: number;
  copied: number;
  pending: number;
  readiness: JsonRecord | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requireUuid(value: unknown, fieldName: string): string {
  const id = asString(value);
  if (!id || !UUID_RE.test(id)) throw new Error(`Invalid controller response: ${fieldName}`);
  return id;
}

function optionalUuid(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireUuid(value, fieldName);
}

function requireEnum<T extends readonly string[]>(value: unknown, allowed: T, fieldName: string): T[number] {
  const text = asString(value);
  if (!text || !allowed.includes(text)) throw new Error(`Invalid controller response: ${fieldName}`);
  return text as T[number];
}

function asJsonRecord(value: unknown): JsonRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("Invalid controller response object");
  return value as JsonRecord;
}

function sanitizeJsonRecord(input: UnknownRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as JsonRecord;
}

async function callControllerRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpcClient.rpc<T>(fn, args);
  if (error) throw new Error(error.message || `RPC ${fn} failed`);
  if (data === null || data === undefined) throw new Error(`RPC ${fn} returned empty response`);
  return data;
}

export async function getCurrentActorId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.id) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  return data.user.id;
}

export async function createProcurementLineWithMaterialResolution(params: {
  sourceTable: ProcurementSourceTable;
  sourceType: "purchase_order" | "payment_request" | "invoice";
  parentId: string;
  item: UnknownRecord;
  actorId: string;
}): Promise<ProcurementLineControllerResult> {
  requireEnum(params.sourceTable, PROCUREMENT_SOURCE_TABLES, "source_table");
  requireUuid(params.parentId, "parent_id");
  const result = await callControllerRpc<unknown>("create_procurement_line_with_material_resolution", {
    p_source_table: params.sourceTable,
    p_parent_id: params.parentId,
    p_line: sanitizeJsonRecord(params.item),
    p_source_type: params.sourceType,
    p_actor_id: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid procurement line controller response");
  const nestedLine = isRecord(result.line) ? result.line : {};
  return {
    line_id: requireUuid(result.line_id, "line_id"),
    status: requireEnum(result.status, PROCUREMENT_LINE_STATUSES, "status"),
    line_kind: requireEnum(nestedLine.line_kind ?? result.line_kind ?? "unknown", PROCUREMENT_LINE_KINDS, "line_kind"),
    material_id: optionalUuid(result.material_id, "material_id"),
    request_id: optionalUuid(result.request_id, "request_id"),
    resolved_exact: nestedLine.resolved_exact === true || result.resolved_exact === true,
  };
}

export interface ProcurementDocumentEditResult {
  status: "updated";
  source_type: "purchase_order" | "payment_request" | "invoice";
  parent_id: string;
  parent_status: string;
  items_count: number;
  updated_items_count: number;
  created_items_count: number;
  deleted_items_count: number;
  evidence_items_count: number;
}

function requireNonnegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || value < 0 || !Number.isFinite(value)) {
    throw new Error(`Invalid controller response: ${fieldName}`);
  }
  return value;
}

export async function updateProcurementDocumentWithMaterialController(params: {
  sourceType: "purchase_order" | "payment_request" | "invoice";
  parentId: string;
  parentPatch: UnknownRecord;
  lines: UnknownRecord[];
  actorId: string;
}): Promise<ProcurementDocumentEditResult> {
  const result = await callControllerRpc<unknown>("update_procurement_document_with_material_controller", {
    p_source_type: params.sourceType,
    p_parent_id: requireUuid(params.parentId, "parent_id"),
    p_parent_patch: sanitizeJsonRecord(params.parentPatch),
    p_lines: params.lines.map(sanitizeJsonRecord),
    p_actor_id: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid procurement document edit response");
  return {
    status: requireEnum(result.status, ["updated"] as const, "status"),
    source_type: requireEnum(result.source_type, ["purchase_order", "payment_request", "invoice"] as const, "source_type"),
    parent_id: requireUuid(result.parent_id, "parent_id"),
    parent_status: asString(result.parent_status) || "",
    items_count: requireNonnegativeNumber(result.items_count, "items_count"),
    updated_items_count: requireNonnegativeNumber(result.updated_items_count, "updated_items_count"),
    created_items_count: requireNonnegativeNumber(result.created_items_count, "created_items_count"),
    deleted_items_count: requireNonnegativeNumber(result.deleted_items_count, "deleted_items_count"),
    evidence_items_count: requireNonnegativeNumber(result.evidence_items_count, "evidence_items_count"),
  };
}

export async function updatePurchaseOrderStatusWithMaterialController(params: {
  purchaseOrderId: string;
  status: PurchaseOrderStatus;
  actorId: string;
}): Promise<PurchaseOrderStatusControllerResult> {
  const result = await callControllerRpc<unknown>("update_purchase_order_status_with_material_controller", {
    p_purchase_order_id: requireUuid(params.purchaseOrderId, "purchase_order_id"),
    p_status: requireEnum(params.status, PO_STATUSES, "purchase_order_status"),
    p_actor_id: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid PO status controller response");
  const status = requireEnum(result.purchase_order_status, PO_STATUSES, "purchase_order_status");
  requireEnum(result.status, ["updated"] as const, "status");
  return {
    status,
    order: null,
    receipt: null,
    readiness: asJsonRecord(result.material_master),
  };
}

export async function approvePaymentRequestWithMaterialController(params: {
  paymentRequestId: string;
  paymentMethod: "bank_transfer" | "cash";
  actorId: string;
}): Promise<PaymentRequestApprovalControllerResult> {
  const result = await callControllerRpc<unknown>("approve_payment_request_with_material_controller", {
    p_payment_request_id: requireUuid(params.paymentRequestId, "payment_request_id"),
    p_payment_method: params.paymentMethod,
    p_actor_id: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid payment approval controller response");
  requireEnum(result.status, ["approved"] as const, "status");
  return {
    approved: true,
    readiness: asJsonRecord(result.material_master),
    sku_processing_status: "not_run",
  };
}

export interface InvoiceFromPaymentRequestResult {
  status: "created";
  invoice_id: string;
  items_count: number;
  copied_material_items_count: number;
  pending_material_items_count: number;
  readiness: JsonRecord | null;
}

export async function createInvoiceFromPaymentRequestWithMaterialController(params: {
  paymentRequestId: string;
  invoiceNumber: string;
  invoiceDate: string;
  vatAmount?: number;
  notes?: string | null;
  paymentSlipUrl?: string | null;
  actorId: string;
}): Promise<InvoiceFromPaymentRequestResult> {
  const result = await callControllerRpc<unknown>("create_invoice_from_payment_request", {
    p_payment_request_id: requireUuid(params.paymentRequestId, "payment_request_id"),
    p_invoice_number: params.invoiceNumber,
    p_invoice_date: params.invoiceDate,
    p_vat_amount: params.vatAmount ?? 0,
    p_notes: params.notes ?? null,
    p_payment_slip_url: params.paymentSlipUrl ?? null,
    p_created_by: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid PR invoice controller response");
  return {
    status: requireEnum(result.status, ["created"] as const, "status"),
    invoice_id: requireUuid(result.invoice_id, "invoice_id"),
    items_count: requireNonnegativeNumber(result.items_count, "items_count"),
    copied_material_items_count: requireNonnegativeNumber(result.copied_material_items_count, "copied_material_items_count"),
    pending_material_items_count: requireNonnegativeNumber(result.pending_material_items_count, "pending_material_items_count"),
    readiness: asJsonRecord(result.material_master),
  };
}

export async function createInvoiceWithMaterialController(params: {
  invoice: UnknownRecord;
  items: UnknownRecord[];
  actorId: string;
}): Promise<InvoiceControllerResult> {
  const result = await callControllerRpc<unknown>("create_invoice_with_material_controller", {
    p_parent: sanitizeJsonRecord(params.invoice),
    p_items: params.items.map(sanitizeJsonRecord),
    p_actor_id: requireUuid(params.actorId, "actor_id"),
  });
  if (!isRecord(result)) throw new Error("Invalid invoice controller response");
  return {
    status: requireEnum(result.status, INVOICE_STATUSES, "status"),
    invoice_id: requireUuid(result.invoice_id, "invoice_id"),
    items_count: typeof result.items_count === "number" && result.items_count >= 0 ? result.items_count : (() => { throw new Error("Invalid controller response: items_count"); })(),
    copied: 0,
    pending: 0,
    readiness: asJsonRecord(result.material_master),
  };
}
