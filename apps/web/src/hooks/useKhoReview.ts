import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  KhoReviewFactorHint,
  KhoReviewJevFeedbackResult,
  KhoReviewJevVerdict,
  KhoReviewLineRead,
  KhoReviewLinkResult,
  KhoReviewList,
} from "@/lib/kho-review";
import { KHO_ITEMS_QUERY_KEY } from "./useKhoItems";

export const KHO_REVIEW_QUERY_KEY = "kho-review";

/**
 * The generated Database type predates this migration; keep the calls typed
 * here instead of widening every RPC in the client (same wrapper as
 * useWarehouseGame.ts for set_item_kho_locations).
 */
const rpc = supabase as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

function invalidateKhoReview(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
}

/** The whole review list in one RPC: item gaps and material gaps with candidates. */
export function useKhoReviewList() {
  return useQuery({
    queryKey: [KHO_REVIEW_QUERY_KEY],
    queryFn: async (): Promise<KhoReviewList> => {
      const { data, error } = await rpc.rpc("kho_review_list");
      if (error) throw error;
      return data as KhoReviewList;
    },
  });
}

export interface KhoReviewReadLineInput {
  receiptItemId: string;
}

/**
 * Ask the server to read one candidate line's photo.  The edge function calls
 * kho_review_line_context as the caller and never links or creates anything.
 */
export function useKhoReviewReadLine() {
  return useMutation({
    mutationFn: async (input: KhoReviewReadLineInput): Promise<KhoReviewLineRead> => {
      const { data, error } = await supabase.functions.invoke("kho-review-read-line", {
        body: { receipt_item_id: input.receiptItemId },
      });
      if (error) throw error;
      if (data && typeof data === "object" && (data as { ok?: unknown }).ok === false) {
        throw data;
      }
      return data as KhoReviewLineRead;
    },
  });
}

export interface KhoReviewFixLineUnitInput {
  receiptItemId: string;
  newUnit: string;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

export interface KhoReviewLineUnitFixResult {
  status: "fixed" | "unchanged";
  fix_id?: string;
  receipt_item_id: string;
  old_unit: string | null;
  new_unit: string;
  request_id?: string | null;
  replayed?: boolean;
}

/** Correct the stored document unit on an unposted, unlinked receipt line. */
export function useKhoReviewFixLineUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: KhoReviewFixLineUnitInput,
    ): Promise<KhoReviewLineUnitFixResult> => {
      const { data, error } = await rpc.rpc("kho_review_fix_line_unit", {
        p_receipt_item_id: input.receiptItemId,
        p_new_unit: input.newUnit,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewLineUnitFixResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewUndoUnitFixInput {
  fixId: string;
}

export interface KhoReviewUndoUnitFixResult {
  status: "undone" | "already_undone";
  fix_id: string;
  receipt_item_id: string;
  unit: string | null;
}

/** Undo one unit fix while the line is still unposted/unlinked. */
export function useKhoReviewUndoUnitFix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: KhoReviewUndoUnitFixInput,
    ): Promise<KhoReviewUndoUnitFixResult> => {
      const { data, error } = await rpc.rpc("kho_review_undo_unit_fix", {
        p_fix_id: input.fixId,
      });
      if (error) throw error;
      return data as KhoReviewUndoUnitFixResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewFactorHintInput {
  receiptItemId: string;
  itemId?: string | null;
  docUnit?: string | null;
  /** Defaults to true; false keeps the query idle until a line is chosen. */
  enabled?: boolean;
}

/** Server-proven conversion factor; null source means "type it yourself". */
export function useKhoReviewFactorHint(input: KhoReviewFactorHintInput) {
  return useQuery({
    queryKey: [
      KHO_REVIEW_QUERY_KEY,
      "factor-hint",
      input.receiptItemId,
      input.itemId ?? null,
      input.docUnit ?? null,
    ],
    enabled: input.enabled !== false && input.receiptItemId !== "",
    queryFn: async (): Promise<KhoReviewFactorHint> => {
      const { data, error } = await rpc.rpc("kho_review_factor_hint", {
        p_receipt_item_id: input.receiptItemId,
        p_item_id: input.itemId ?? null,
        p_doc_unit: input.docUnit ?? null,
      });
      if (error) throw error;
      return data as KhoReviewFactorHint;
    },
  });
}

export interface KhoReviewLinkInput {
  receiptItemId: string;
  itemId: string;
  factor: number;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Link one receipt line to an existing item; idempotent by requestId. */
export function useKhoReviewLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoReviewLinkInput): Promise<KhoReviewLinkResult> => {
      const { data, error } = await rpc.rpc("kho_review_link_line", {
        p_receipt_item_id: input.receiptItemId,
        p_item_id: input.itemId,
        p_factor: input.factor,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewLinkResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewCreateItemInput {
  receiptItemId: string;
  name: string;
  unit: string;
  itemClass: "raw_material" | "packaging_supply";
  factor: number;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Create the item from a receipt line and link that line in one call. */
export function useKhoReviewCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: KhoReviewCreateItemInput,
    ): Promise<KhoReviewLinkResult> => {
      const { data, error } = await rpc.rpc("kho_review_create_item_from_line", {
        p_receipt_item_id: input.receiptItemId,
        p_name: input.name,
        p_unit: input.unit,
        p_class: input.itemClass,
        p_factor: input.factor,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewLinkResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewJevInput {
  /** Narrow the run to these target_key values; omit for every target. */
  targetKeys?: string[];
  /** Server default 20, hard-capped at 40. */
  limit?: number;
}

export interface KhoReviewJevMark {
  target_key: string;
  receipt_item_id: string;
  verdict: KhoReviewJevVerdict;
  probability: number;
  suggested_class: "raw_material" | "packaging_supply" | null;
}

export interface KhoReviewJevResult {
  asked: number;
  cached: number;
  skipped: number;
  marks: KhoReviewJevMark[];
}

/**
 * Owner-triggered Jev scoring.  The edge function reads the review list as the
 * caller and stores suggestions only; it never links a line or creates an item.
 */
export function useKhoReviewJev() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoReviewJevInput = {}): Promise<KhoReviewJevResult> => {
      const { data, error } = await supabase.functions.invoke("kho-review-jev", {
        body: {
          target_keys: input.targetKeys,
          limit: input.limit,
        },
      });
      if (error) throw error;
      return data as KhoReviewJevResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewJevFeedbackInput {
  targetKey: string;
  receiptItemId: string;
  action: "linked" | "dismissed";
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Record the human decision for one (target, receipt line) Jev pair. */
export function useKhoReviewJevFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: KhoReviewJevFeedbackInput,
    ): Promise<KhoReviewJevFeedbackResult> => {
      const { data, error } = await rpc.rpc("kho_review_jev_feedback", {
        p_target_key: input.targetKey,
        p_receipt_item_id: input.receiptItemId,
        p_action: input.action,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewJevFeedbackResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}
