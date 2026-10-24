import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  type AttpChecklist,
  type AttpProfile,
  type ScanFoodCertInput,
  type ScanFoodCertResult,
} from "@/lib/kho-attp";
import type {
  FoodCert,
  FoodCertOwnerKind,
  FoodCertTypeWithQuarantine,
} from "@/lib/kho-lots";
import { FOOD_CERTS_QUERY_KEY } from "./useKhoLots";

export const KHO_ATTP_QUERY_KEY = "kho-attp";

// The generated Database type predates these migrations.  Call RPCs inline on
// the client (never a detached `supabase.rpc`, which loses `this`).
function invalidateAttp(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_ATTP_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [FOOD_CERTS_QUERY_KEY] });
}

/** Supplier -> item -> requirement checklist for goods received in `days`. */
export function useAttpChecklist(days = 180) {
  const safeDays = Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 180;
  return useQuery({
    queryKey: [KHO_ATTP_QUERY_KEY, "checklist", safeDays],
    queryFn: async (): Promise<AttpChecklist> => {
      const { data, error } = await (supabase as any).rpc("kho_attp_checklist", {
        p_days: safeDays,
      });
      if (error) throw error;
      return data as AttpChecklist;
    },
  });
}

export interface SetAttpProfileInput {
  itemId: string;
  /** null resets the item to its derived default profile. */
  profile: AttpProfile | null;
}

export interface SetAttpProfileResult {
  item_id: string;
  attp_profile: AttpProfile | null;
  profile_source: "set" | "default";
  effective_profile: AttpProfile;
}

/** Set or reset one item's ATTP profile. */
export function useSetAttpProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetAttpProfileInput): Promise<SetAttpProfileResult> => {
      const { data, error } = await (supabase as any).rpc("kho_attp_set_profile", {
        p_item_id: input.itemId,
        p_profile: input.profile,
      });
      if (error) throw error;
      return data as SetAttpProfileResult;
    },
    onSuccess: () => invalidateAttp(queryClient),
  });
}

/** OCR one certificate photo/PDF; the user still confirms before it counts. */
export function useScanFoodCert() {
  return useMutation({
    mutationFn: async (input: ScanFoodCertInput): Promise<ScanFoodCertResult> => {
      const body = input.filePath
        ? { file_path: input.filePath }
        : { image_base64: input.imageBase64, mime_type: input.mimeType };
      const { data, error } = await supabase.functions.invoke("scan-food-cert", { body });
      if (error) throw error;
      if (data && typeof data === "object" && (data as { ok?: unknown }).ok === false) {
        throw data;
      }
      return data as ScanFoodCertResult;
    },
  });
}

export interface UploadPendingCertInput {
  certType: FoodCertTypeWithQuarantine;
  ownerKind: FoodCertOwnerKind;
  ownerId?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  filePath: string;
  fileName?: string | null;
  mimeType?: string | null;
  extracted?: Record<string, unknown> | null;
  itemIds?: string[] | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Insert an uploaded certificate as 'pending', with its item links. */
export function useUploadPendingCert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadPendingCertInput): Promise<FoodCert> => {
      const { data, error } = await (supabase as any).rpc("food_cert_upload_pending", {
        p_cert_type: input.certType,
        p_owner_kind: input.ownerKind,
        p_owner_id: input.ownerId ?? null,
        p_cert_no: input.certNo ?? null,
        p_issuer: input.issuer ?? null,
        p_issued_on: input.issuedOn ?? null,
        p_expires_on: input.expiresOn ?? null,
        p_file_path: input.filePath,
        p_file_name: input.fileName ?? null,
        p_mime_type: input.mimeType ?? null,
        p_extracted: input.extracted ?? null,
        p_item_ids: input.itemIds ?? null,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as FoodCert;
    },
    onSuccess: () => invalidateAttp(queryClient),
  });
}

export interface ConfirmFoodCertInput {
  certId: string;
  certType: FoodCertTypeWithQuarantine;
  ownerKind: FoodCertOwnerKind;
  ownerId?: string | null;
  certNo?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  itemIds?: string[] | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Confirm a pending certificate with the user's corrected values. */
export function useConfirmFoodCert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmFoodCertInput): Promise<FoodCert> => {
      const { data, error } = await (supabase as any).rpc("food_cert_confirm", {
        p_cert_id: input.certId,
        p_cert_type: input.certType,
        p_owner_kind: input.ownerKind,
        p_owner_id: input.ownerId ?? null,
        p_cert_no: input.certNo ?? null,
        p_issuer: input.issuer ?? null,
        p_issued_on: input.issuedOn ?? null,
        p_expires_on: input.expiresOn ?? null,
        p_item_ids: input.itemIds ?? null,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as FoodCert;
    },
    onSuccess: () => invalidateAttp(queryClient),
  });
}

export interface LinkCertItemsInput {
  certId: string;
  itemIds: string[] | null;
}

/** Replace the item links of one certificate. */
export function useLinkCertItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkCertItemsInput): Promise<FoodCert> => {
      const { data, error } = await (supabase as any).rpc("food_cert_link_items", {
        p_cert_id: input.certId,
        p_item_ids: input.itemIds,
      });
      if (error) throw error;
      return data as FoodCert;
    },
    onSuccess: () => invalidateAttp(queryClient),
  });
}
