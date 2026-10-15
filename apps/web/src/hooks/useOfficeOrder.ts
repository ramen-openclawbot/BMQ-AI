import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  OfficeOrderSnapshot,
  PaymentDocDetail,
} from "@/lib/office-order";

// No UI here: the hooks only call the two office-order RPCs and read the
// pending payment requests. The server owns every permission gate.
//
// Query keys are exported so the page can invalidate the lists it reads.
export const OFFICE_ORDER_SNAPSHOT_QUERY_KEY = "office-order-snapshot";
export const PAYMENT_DOC_DETAIL_QUERY_KEY = "payment-doc-detail";
export const OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY =
  "office-pending-payment-requests";

// The generated database types do not know the new RPCs yet.
const db = supabase as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

export type OfficeOrderLocation = "tan_tao" | "q7";
export type PaymentDocKind = "pr" | "po";

/** One warehouse's stock items with their purchase facts (and Q7 forecast). */
export function useOfficeOrderSnapshot(location: OfficeOrderLocation) {
  return useQuery({
    queryKey: [OFFICE_ORDER_SNAPSHOT_QUERY_KEY, location],
    enabled: Boolean(location),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<OfficeOrderSnapshot | null> => {
      const { data, error } = await db.rpc("get_office_order_snapshot", {
        p_location: location,
      });
      if (error) throw error;
      return (data ?? null) as OfficeOrderSnapshot | null;
    },
  });
}

/** One PR or one PO in full, under the caller's own row-level security. */
export function usePaymentDocDetail(
  kind: PaymentDocKind,
  id: string | null | undefined,
) {
  return useQuery({
    queryKey: [PAYMENT_DOC_DETAIL_QUERY_KEY, kind, id ?? null],
    enabled: Boolean(id),
    staleTime: 60 * 1000,
    queryFn: async (): Promise<PaymentDocDetail | null> => {
      const { data, error } = await db.rpc("get_payment_doc_detail", {
        p_kind: kind,
        p_id: id,
      });
      if (error) throw error;
      return (data ?? null) as PaymentDocDetail | null;
    },
  });
}

export interface PendingPaymentRequestRow {
  id: string;
  request_number: string;
  title: string;
  total_amount: number | null;
  created_at: string;
  supplier_id: string | null;
  purchase_order_id: string | null;
  supplier_name: string | null;
  item_count: number;
}

interface PendingPaymentRequestRaw {
  id: string;
  request_number: string | null;
  title: string | null;
  total_amount: number | null;
  created_at: string;
  supplier_id: string | null;
  purchase_order_id: string | null;
  suppliers: { id: string; name: string | null } | null;
  payment_request_items: Array<{ id: string }> | null;
}

/** The newest 60 unpaid pending payment requests, for the office list. */
export function usePendingPaymentRequests() {
  return useQuery({
    queryKey: [OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY],
    staleTime: 60 * 1000,
    queryFn: async (): Promise<PendingPaymentRequestRow[]> => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select(
          "id, request_number, title, total_amount, created_at, supplier_id, purchase_order_id, suppliers(id, name), payment_request_items(id)",
        )
        .eq("status", "pending")
        .eq("payment_status", "unpaid")
        .order("created_at", { ascending: false })
        .limit(60);

      if (error) throw error;

      return ((data ?? []) as unknown as PendingPaymentRequestRaw[]).map((row) => ({
        id: row.id,
        request_number: row.request_number ?? "",
        title: row.title ?? "",
        total_amount: row.total_amount ?? null,
        created_at: row.created_at,
        supplier_id: row.supplier_id ?? null,
        purchase_order_id: row.purchase_order_id ?? null,
        supplier_name: row.suppliers?.name ?? null,
        item_count: Array.isArray(row.payment_request_items)
          ? row.payment_request_items.length
          : 0,
      }));
    },
  });
}
