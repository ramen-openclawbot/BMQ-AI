import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";
import {
  paymentSubmissionPageToRange,
  paymentSubmissionTotalPages,
  vietnamDateCutoff,
} from "@/lib/payment-submission";

// Same relation select as usePaymentRequests so the submission picker and the
// detail page render the same rows without a second load.
const UNPAID_PAYMENT_REQUESTS_SELECT =
  "*, suppliers(id, name), payment_request_items(id, product_name, raw_product_name), payment_allocations(id, amount, payment_id, created_at), goods_receipts(id, receipt_number, receipt_date, payable_status), purchase_orders(id, po_number, status), invoices:invoices!payment_requests_invoice_id_fkey(id, invoice_number)";

export interface UnpaidPaymentRequestsPageParams {
  page: number;
  pageSize?: number;
  /** Number of Vietnam days to look back, or null for all time. */
  days?: number | null;
  search?: string | null;
}

export interface UnpaidPaymentRequestsPage {
  rows: PaymentRequestWithSupplier[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Server-side paginated list of payable requests (pending/approved and
 * unpaid/partial) using `.range()` + exact count so the browser never loads the
 * whole table. `days: null` disables the created_at cutoff.
 */
export function useUnpaidPaymentRequestsPage({
  page,
  pageSize = 10,
  days = 90,
  search,
}: UnpaidPaymentRequestsPageParams) {
  const range = paymentSubmissionPageToRange(page, pageSize);
  const normalizedSearch = search?.trim() || "";
  const cutoff = days === null || days === undefined ? null : vietnamDateCutoff(days);

  return useQuery({
    queryKey: [
      "unpaid-payment-requests-page",
      range.page,
      range.pageSize,
      days ?? "all",
      normalizedSearch,
    ],
    queryFn: async (): Promise<UnpaidPaymentRequestsPage> => {
      let query = supabase
        .from("payment_requests")
        .select(UNPAID_PAYMENT_REQUESTS_SELECT, { count: "exact" })
        .in("status", ["pending", "approved"])
        .in("payment_status", ["unpaid", "partial"])
        .order("created_at", { ascending: false })
        .range(range.from, range.to);

      if (cutoff) query = query.gte("created_at", cutoff);

      if (normalizedSearch) {
        const term = normalizedSearch.replace(/[%,()]/g, " ").trim();
        if (term) {
          query = query.or(`request_number.ilike.%${term}%,title.ilike.%${term}%`);
        }
      }

      const { data, count, error } = await query;
      if (error) throw error;

      const totalCount = Number(count || 0);
      return {
        rows: (data || []) as PaymentRequestWithSupplier[],
        totalCount,
        page: range.page,
        pageSize: range.pageSize,
        totalPages: paymentSubmissionTotalPages(totalCount, range.pageSize),
      };
    },
    staleTime: 30000,
  });
}

export interface PaymentSubmissionCreateItem {
  payment_request_id: string;
  remaining_at_submit: number;
  position: number;
}

export interface PaymentSubmissionCreateResult {
  status: string;
  submission_id: string;
  submission_number: string;
  note: string | null;
  total_amount: number;
  item_count: number;
  items: PaymentSubmissionCreateItem[];
  idempotent: boolean;
}

export interface CreatePaymentSubmissionInput {
  requestIds: string[];
  note?: string | null;
  idempotencyKey?: string;
}

/** Owner / payment_requests edit: create a Trình chi gấp submission. */
export function useCreatePaymentSubmission() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ requestIds, note, idempotencyKey }: CreatePaymentSubmissionInput) => {
      const key = idempotencyKey?.trim() || `payment_submission:${crypto.randomUUID()}`;
      const { data, error } = await (supabase as any).rpc("create_payment_submission", {
        p_request_ids: requestIds,
        p_note: note ?? null,
        p_idempotency_key: key,
      });
      if (error) throw error;
      return data as PaymentSubmissionCreateResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-submissions"] });
      queryClient.invalidateQueries({ queryKey: ["unpaid-payment-requests-page"] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
    },
    onError: (error) => {
      console.error("Error creating payment submission:", error);
    },
  });
}

export interface PaymentSubmissionItemDetail {
  payment_request_id: string;
  position: number;
  remaining_at_submit: number;
  request_number: string;
  title: string;
  supplier_id: string | null;
  supplier_name: string | null;
  total_amount: number | null;
  allocated_amount: number;
  remaining_amount: number;
  status: string;
  payment_status: string;
  requires_receipt: boolean;
  created_at: string;
}

export interface PaymentSubmissionDetail {
  id: string;
  submission_number: string;
  note: string | null;
  total_amount: number;
  created_by: string | null;
  created_at: string;
  items: PaymentSubmissionItemDetail[];
}

/** Owner / payment_requests view: one submission with live request data. */
export function usePaymentSubmission(id: string | null) {
  return useQuery({
    queryKey: ["payment-submission", id],
    enabled: !!id,
    queryFn: async (): Promise<PaymentSubmissionDetail | null> => {
      if (!id) return null;
      const { data, error } = await (supabase as any).rpc("get_payment_submission", {
        p_id: id,
      });
      if (error) throw error;
      return (data as PaymentSubmissionDetail | null) ?? null;
    },
    staleTime: 30000,
  });
}
