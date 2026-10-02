import { supabase } from "@/integrations/supabase/client";

export type RevenueLine = {
  id: string;
  period: string;
  revenue_date: string;
  channel: string;
  source_tab: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_name: string;
  quantity: number | null;
  gross_revenue: number | null;
  source_type: string;
  approval_status: string;
  raw_payload: unknown;
};

type RevenueQuery = PromiseLike<{
  data: RevenueLine[] | null;
  error: { message?: string } | null;
}> & {
  eq: (column: string, value: string) => RevenueQuery;
  in: (column: string, values: string[]) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

export const db = supabase as unknown as {
  from: (table: string) => { select: (columns: string) => RevenueQuery };
};

export async function fetchAllRevenueLines(period: string, controlledOnly: boolean) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = db
      .from("revenue_ledger_lines")
      .select(
        "id,period,revenue_date,channel,source_tab,customer_id,parent_customer_id,customer_name,quantity,gross_revenue,source_type,approval_status,raw_payload,source_document:revenue_source_documents!inner(status)",
      )
      .eq("period", period)
      .order("revenue_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (controlledOnly)
      q = q
        .eq("approval_status", "approved")
        .in("source_document.status", ["controlled", "trusted"]);

    const { data, error } = await q;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}
