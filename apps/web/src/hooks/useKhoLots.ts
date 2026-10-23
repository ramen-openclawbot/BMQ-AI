import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  ExpiryOverviewRow,
  FoodCert,
  FoodCertListParams,
  FoodCertUploadResult,
  FoodManufacturer,
  ManufacturerSuggestion,
  ReceiptLineLot,
  ScanLotLabelResult,
} from "@/lib/kho-lots";
import { KHO_ITEMS_QUERY_KEY } from "./useKhoItems";

export const KHO_LOTS_QUERY_KEY = "kho-lots";
export const FOOD_CERTS_QUERY_KEY = "food-certs";
export const FOOD_MANUFACTURERS_QUERY_KEY = "food-manufacturers";

/**
 * The generated Database type predates these migrations.  Keep the new RPCs
 * locally typed.  Bind to the client: a detached `supabase.rpc` loses `this`.
 */
const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

function invalidateExpiry(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_LOTS_QUERY_KEY, "expiry"] });
}

export interface SetReceiptLineLotInput {
  receiptItemId: string;
  manufactureDate: string | null;
  expiryDate: string | null;
  lot: string | null;
  manufacturerName: string | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Save NSX / HSD / lot / manufacturer on one receipt line and its batches. */
export function useSetReceiptLineLot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetReceiptLineLotInput): Promise<ReceiptLineLot> => {
      const { data, error } = await rpc("kho_set_receipt_line_lot", {
        p_receipt_item_id: input.receiptItemId,
        p_manufacture_date: input.manufactureDate,
        p_expiry_date: input.expiryDate,
        p_lot: input.lot,
        p_manufacturer_name: input.manufacturerName,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as ReceiptLineLot;
    },
    onSuccess: () => {
      invalidateExpiry(queryClient);
      void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [FOOD_MANUFACTURERS_QUERY_KEY] });
    },
  });
}

/** Suggest the manufacturer saved on the linked item or the latest same-name line. */
export function useManufacturerSuggest(receiptItemId: string | null | undefined) {
  const id = String(receiptItemId ?? "").trim();
  return useQuery({
    queryKey: [KHO_LOTS_QUERY_KEY, "manufacturer-suggest", id],
    enabled: id !== "",
    queryFn: async (): Promise<ManufacturerSuggestion> => {
      const { data, error } = await rpc("kho_manufacturer_suggest", {
        p_receipt_item_id: id,
      });
      if (error) throw error;
      return data as ManufacturerSuggestion;
    },
  });
}

/** Lots expiring within `days` (default 30), newest expiry first. */
export function useExpiryOverview(days = 30) {
  const safeDays = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 30;
  return useQuery({
    queryKey: [KHO_LOTS_QUERY_KEY, "expiry", safeDays],
    queryFn: async (): Promise<ExpiryOverviewRow[]> => {
      const { data, error } = await rpc("kho_expiry_overview", { p_days: safeDays });
      if (error) throw error;
      return (data ?? []) as ExpiryOverviewRow[];
    },
  });
}

export interface ScanLotLabelInput {
  imagePath?: string | null;
  imageBase64?: string | null;
  mimeType?: string | null;
}

/** Read NSX / HSD / lot / manufacturer from one package-label photo. */
export function useScanLotLabel() {
  return useMutation({
    mutationFn: async (input: ScanLotLabelInput): Promise<ScanLotLabelResult> => {
      const body = input.imagePath
        ? { image_path: input.imagePath }
        : { image_base64: input.imageBase64, mime_type: input.mimeType };
      const { data, error } = await supabase.functions.invoke("scan-lot-label", { body });
      if (error) throw error;
      if (data && typeof data === "object" && (data as { ok?: unknown }).ok === false) {
        throw data;
      }
      return data as ScanLotLabelResult;
    },
  });
}

export interface SetSkuShelfLifeInput {
  skuId: string;
  days: number | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

export interface SkuShelfLifeResult {
  sku_id: string;
  shelf_life_days: number | null;
  replayed: boolean;
}

/** Set or clear the shelf life (days) of one finished-goods SKU. */
export function useSetSkuShelfLife() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetSkuShelfLifeInput): Promise<SkuShelfLifeResult> => {
      const { data, error } = await rpc("sku_set_shelf_life", {
        p_sku_id: input.skuId,
        p_days: input.days,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as SkuShelfLifeResult;
    },
    onSuccess: () => {
      invalidateExpiry(queryClient);
    },
  });
}

/** Certificate vault list, newest first; archived certificates are excluded. */
export function useFoodCerts(params: FoodCertListParams = {}) {
  const ownerKind = params.ownerKind ?? null;
  const ownerId = params.ownerId ?? null;
  const expiringDays = params.expiringDays ?? null;
  return useQuery({
    queryKey: [FOOD_CERTS_QUERY_KEY, ownerKind, ownerId, expiringDays],
    queryFn: async (): Promise<FoodCert[]> => {
      const { data, error } = await rpc("food_cert_list", {
        p_owner_kind: ownerKind,
        p_owner_id: ownerId,
        p_expiring_days: expiringDays,
      });
      if (error) throw error;
      return (data ?? []) as FoodCert[];
    },
  });
}

export interface UpsertFoodCertInput {
  id?: string | null;
  ownerKind: "manufacturer" | "item" | "supplier" | "company";
  ownerId?: string | null;
  certType: "attp_facility" | "coa" | "product_declaration" | "other";
  certNo?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  filePath: string;
  fileName?: string | null;
  mimeType?: string | null;
  note?: string | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Create or update one certificate row.  The file is uploaded separately. */
export function useUpsertFoodCert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertFoodCertInput): Promise<FoodCert> => {
      const { data, error } = await rpc("food_cert_upsert", {
        p_id: input.id ?? null,
        p_owner_kind: input.ownerKind,
        p_owner_id: input.ownerId ?? null,
        p_cert_type: input.certType,
        p_cert_no: input.certNo ?? null,
        p_issuer: input.issuer ?? null,
        p_issued_on: input.issuedOn ?? null,
        p_expires_on: input.expiresOn ?? null,
        p_file_path: input.filePath,
        p_file_name: input.fileName ?? null,
        p_mime_type: input.mimeType ?? null,
        p_note: input.note ?? null,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as FoodCert;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [FOOD_CERTS_QUERY_KEY] });
    },
  });
}

export interface ArchiveFoodCertInput {
  id: string;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Archive (soft-delete) one certificate; the file stays in the private bucket. */
export function useArchiveFoodCert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ArchiveFoodCertInput): Promise<FoodCert> => {
      const { data, error } = await rpc("food_cert_archive", {
        p_id: input.id,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as FoodCert;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [FOOD_CERTS_QUERY_KEY] });
    },
  });
}

/** Manufacturer picker list; an empty query returns every manufacturer. */
export function useFoodManufacturers(query = "") {
  const trimmed = query.trim();
  return useQuery({
    queryKey: [FOOD_MANUFACTURERS_QUERY_KEY, trimmed],
    queryFn: async (): Promise<FoodManufacturer[]> => {
      const { data, error } = await rpc("food_manufacturer_list", {
        p_query: trimmed === "" ? null : trimmed,
      });
      if (error) throw error;
      return (data ?? []) as FoodManufacturer[];
    },
  });
}

const MAX_FILE_NAME = 160;

function safeFileName(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-MAX_FILE_NAME);
  return cleaned === "" ? "certificate" : cleaned;
}

/**
 * Upload one certificate file to the private bucket under
 * `certs/<uuid>/<filename>` and return the storage path the RPC stores.
 */
export async function uploadFoodCertFile(file: File): Promise<FoodCertUploadResult> {
  const fileName = safeFileName(file.name);
  const filePath = `certs/${crypto.randomUUID()}/${fileName}`;
  const { error } = await supabase.storage
    .from("food-safety-docs")
    .upload(filePath, file, {
      contentType: file.type || undefined,
      upsert: false,
    });
  if (error) throw error;
  return {
    file_path: filePath,
    file_name: fileName,
    mime_type: file.type || null,
  };
}
