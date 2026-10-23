import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Một khuôn chi định kỳ đã tới kỳ nhưng chưa có hóa đơn / phiếu cho kỳ đó. */
export interface ExpenseDueNotice {
  label: string;
  supplier_name: string;
  period: string;
  typical_day: number | null;
  amount_median: number | null;
}

type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}>;

// get_expense_due_notices / get_auto_payment_request_count được thêm bằng
// migration auto_payment_requests; types.ts chỉ được sinh lại sau khi apply DB.
const rpc = supabase.rpc as unknown as UntypedRpc;

const FIVE_MINUTES = 5 * 60 * 1000;

const asNumber = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function useExpenseDueNotices() {
  return useQuery<ExpenseDueNotice[]>({
    queryKey: ["expense-due-notices"],
    queryFn: async () => {
      const { data, error } = await rpc("get_expense_due_notices");
      if (error) {
        // Chuông thông báo không được vỡ vì RPC lỗi / chưa migrate.
        console.warn("[useExpenseDueNotices] get_expense_due_notices failed", error.message);
        return [];
      }
      if (!Array.isArray(data)) return [];
      return (data as Array<Record<string, unknown>>).map((row) => ({
        label: String(row.label ?? ""),
        supplier_name: String(row.supplier_name ?? ""),
        period: String(row.period ?? ""),
        typical_day: asNumber(row.typical_day),
        amount_median: asNumber(row.amount_median),
      }));
    },
    staleTime: FIVE_MINUTES,
  });
}

export function useAutoPaymentRequestCount() {
  return useQuery<number>({
    queryKey: ["auto-payment-request-count"],
    queryFn: async () => {
      const { data, error } = await rpc("get_auto_payment_request_count");
      if (error) {
        console.warn(
          "[useAutoPaymentRequestCount] get_auto_payment_request_count failed",
          error.message,
        );
        return 0;
      }
      return asNumber(data) ?? 0;
    },
    staleTime: FIVE_MINUTES,
  });
}
