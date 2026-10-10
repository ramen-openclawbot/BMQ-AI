import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { uploadPaymentRequestAttachments } from "@/hooks/usePaymentRequestAttachments";
import {
  buildCashPrIdempotencyKey,
  validateCashPrForm,
  type CashPrItemInput,
} from "@/lib/cash-pr-lines";

export interface CreateCashPaymentRequestInput {
  title: string;
  description?: string | null;
  items: CashPrItemInput[];
  /** The scanned invoices; stored as Chứng từ kèm theo. */
  invoiceFiles?: File[];
  /** Extra supporting documents. */
  docFiles?: File[];
}

export interface CreateCashPaymentRequestResult {
  payment_request_id: string;
  request_number: string;
  total: number;
  replayed: boolean;
  /** True when the phiếu was created but its attachments could not be uploaded. */
  attachmentsFailed: boolean;
}

export interface CreateCashPaymentRequestOptions {
  /** Override the per-session idempotency key (tests / explicit callers). */
  idempotencyKey?: string;
}

interface CashPaymentRequestRpcResult {
  payment_request_id: string;
  request_number: string;
  total: number;
  replayed: boolean;
}

const KNOWN_CASH_PR_ERRORS = [
  "insufficient_privilege",
  "idempotency_key_required",
  "invalid_payload",
  "invalid_title",
  "items_required",
  "too_many_items",
  "invalid_item",
  "invalid_item_name",
  "invalid_amount",
  "amount_over_limit",
  "total_over_limit",
];

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error ?? "");
};

const isKnownCashPrError = (error: unknown): boolean =>
  KNOWN_CASH_PR_ERRORS.some((code) => errorMessage(error).includes(code));

/**
 * Data-only hook for the dedicated "Tạo chi tiền mặt" dialog. It validates the
 * form with the same rules as the RPC, creates the phiếu under a stable
 * per-session idempotency key (retrying an uncertain failure once with the same
 * key, which replays safely), then uploads the invoice + document files as
 * attachments. An attachment failure never undoes the phiếu. No JSX.
 */
export function useCreateCashPaymentRequest() {
  const queryClient = useQueryClient();
  const sessionKeyRef = useRef<string | null>(null);

  const resetSessionKey = useCallback(() => {
    sessionKeyRef.current = null;
  }, []);

  const getSessionKey = useCallback(() => {
    if (!sessionKeyRef.current) {
      sessionKeyRef.current = buildCashPrIdempotencyKey();
    }
    return sessionKeyRef.current;
  }, []);

  const callCreate = useCallback(
    async (
      payload: { title: string; description: string | null; items: CashPrItemInput[] },
      idempotencyKey: string,
    ): Promise<CashPaymentRequestRpcResult> => {
      const { data, error } = await supabase.rpc("create_cash_payment_request", {
        p_payload: payload as unknown as Json,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      return data as unknown as CashPaymentRequestRpcResult;
    },
    [],
  );

  const create = useCallback(
    async (
      input: CreateCashPaymentRequestInput,
      options?: CreateCashPaymentRequestOptions,
    ): Promise<CreateCashPaymentRequestResult> => {
      const payload = {
        title: input.title,
        description: input.description ?? null,
        items: Array.isArray(input.items) ? input.items : [],
      };

      const validation = validateCashPrForm(payload);
      if (!validation.ok) {
        throw new Error(
          validation.messages.join(" ") || "Dữ liệu chi tiền mặt không hợp lệ.",
        );
      }

      const idempotencyKey = options?.idempotencyKey?.trim() || getSessionKey();

      let result: CashPaymentRequestRpcResult;
      try {
        result = await callCreate(payload, idempotencyKey);
      } catch (error) {
        if (isKnownCashPrError(error)) throw error;
        // Uncertain (network/timeout): replay once with the SAME key. The RPC
        // returns the already-created phiếu instead of inserting a second one.
        result = await callCreate(payload, idempotencyKey);
      }

      let attachmentsFailed = false;
      const files = [...(input.invoiceFiles ?? []), ...(input.docFiles ?? [])];
      if (files.length > 0) {
        try {
          await uploadPaymentRequestAttachments(result.payment_request_id, files);
        } catch (error) {
          // The phiếu already exists; the operator can retry the upload later.
          console.error("[useCreateCashPaymentRequest] attachment upload failed", error);
          attachmentsFailed = true;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });

      return { ...result, attachmentsFailed };
    },
    [callCreate, getSessionKey, queryClient],
  );

  return { create, resetSessionKey };
}
