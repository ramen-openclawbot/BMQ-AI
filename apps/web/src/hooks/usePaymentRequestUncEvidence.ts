import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  normalizeUncStoragePath,
  summarizeUncPayments,
  type UncEvidenceDisplayRow,
} from "@/lib/payment-unc-evidence";

export const PAYMENT_UNC_BUCKET = "payment-unc";

export interface PaymentRequestUncEvidence {
  storage_path: string | null;
  transfer_date: string | null;
  ocr_amount: number | null;
  manual_override: boolean;
  override_reason: string | null;
  category: string | null;
}

export interface PaymentRequestUncSibling {
  request_id: string;
  request_number: string;
  amount: number;
}

export interface PaymentRequestUncPayment {
  payment_id: string;
  payment_number: string;
  payment_date: string | null;
  payment_total: number;
  allocated_to_request: number;
  reference_number: string | null;
  evidence: PaymentRequestUncEvidence | null;
  siblings: PaymentRequestUncSibling[];
}

export type { UncEvidenceDisplayRow };

/**
 * Short-lived (10 minutes) signed URL for a stored UNC evidence image. Strips
 * the leading "payment-unc/" bucket name; returns null for an invalid path or a
 * storage error.
 */
export async function getUncEvidenceSignedUrl(
  storagePath: string | null | undefined,
): Promise<string | null> {
  const path = normalizeUncStoragePath(storagePath);
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from(PAYMENT_UNC_BUCKET)
    .createSignedUrl(path, 600);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Read-only UNC evidence for one payment request (owner / payment_requests view). */
export function usePaymentRequestUncEvidence(requestId: string | null | undefined) {
  return useQuery({
    queryKey: ["payment-request-unc-evidence", requestId ?? null],
    enabled: !!requestId,
    queryFn: async (): Promise<UncEvidenceDisplayRow[]> => {
      const { data, error } = await supabase.rpc("get_payment_request_unc_evidence", {
        p_request_id: requestId as string,
      });
      if (error) throw error;

      const rows = (Array.isArray(data) ? data : []) as unknown as PaymentRequestUncPayment[];
      return summarizeUncPayments(rows);
    },
  });
}
