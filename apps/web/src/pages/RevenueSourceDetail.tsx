import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Database, Filter, Search, Settings, TriangleAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLanguage } from "@/contexts/LanguageContext";

const vnd = (v: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);
const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);

type RevenueLine = {
  id: string;
  source_row_number: number;
  period: string;
  revenue_date: string;
  channel: string;
  source_tab: string | null;
  branch: string | null;
  invoice_no: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_name: string;
  product_name: string | null;
  item_note: string | null;
  quantity: number | null;
  unit_price: number | null;
  gross_revenue: number | null;
  source_type: string;
  approval_status: string;
  audit_status: string;
  confidence_status: string;
  review_status: string;
  reconciliation_status: string;
  raw_payload: unknown;
};

type RevenueQuery = PromiseLike<{ data: RevenueLine[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueQuery;
  or: (filters: string) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

const db = supabase as unknown as {
  from: (table: string) => { select: (columns: string) => RevenueQuery };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function fetchAllRevenueSourceLines(period: string, channel: string, review: string) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("revenue_ledger_lines")
      .select("id,source_row_number,period,revenue_date,channel,source_tab,branch,invoice_no,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .eq("period", period)
      .eq("source_document.status", "trusted")
      .order("revenue_date", { ascending: true })
      .order("source_row_number", { ascending: true })
      .range(from, from + pageSize - 1);

    if (channel) query = query.eq("channel", channel);
    if (review === "review_queue") query = query.or("review_status.eq.needs_manual_review,audit_status.eq.needs_review");
    else if (review) query = query.eq("review_status", review);

    const { data, error } = await query;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

function statusBadge(status: string) {
  if (["approved", "trusted", "tied", "matched", "matched_po"].includes(status)) return <Badge variant="secondary">{status}</Badge>;
  if (["needs_review", "needs_manual_review", "po_delta", "csv_only"].includes(status)) return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{status}</Badge>;
  if (["rejected", "low_confidence"].includes(status)) return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export default function RevenueSourceDetail() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const period = params.get("period") || "2026-03";
  const channel = params.get("channel") || "";
  const customerKey = params.get("customer_key") || "";
  const review = params.get("review") || "";
  const [q, setQ] = useState("");

  const { data: lines = [], isLoading, error } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-source-detail", period, channel, customerKey, review],
    queryFn: async () => {
      return fetchAllRevenueSourceLines(period, channel, review);
    },
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter((row) => {
      if (customerKey) {
        const key = row.parent_customer_id || row.customer_id || row.customer_name;
        if (key !== customerKey) return false;
      }
      if (!needle) return true;
      const raw = asRecord(row.raw_payload);
      const po = asRecord(raw.po_reconciliation);
      return [row.customer_name, row.product_name, row.invoice_no, row.branch, raw.parent_customer_name, po.review_flag]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [customerKey, lines, q]);

  const stats = useMemo(() => ({
    rows: filtered.length,
    qty: filtered.reduce((s, r) => s + Number(r.quantity || 0), 0),
    revenue: filtered.reduce((s, r) => s + Number(r.gross_revenue || 0), 0),
    review: filtered.filter((r) => r.review_status === "needs_manual_review" || r.audit_status === "needs_review").length,
  }), [filtered]);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" className="-ml-2" onClick={() => navigate("/finance-control/revenue")}>
            <ArrowLeft className="mr-2 h-4 w-4" />Quay lại dashboard
          </Button>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1"><Database className="h-3 w-3" />Source detail</Badge>
            {review ? <Badge variant="outline">{review}</Badge> : null}
            {channel ? <Badge variant="outline">{channel}</Badge> : null}
          </div>
          <h1 className="text-3xl font-display font-bold">{isVi ? "Chi tiết nguồn doanh thu" : "Revenue source detail"}</h1>
          <p className="max-w-3xl text-muted-foreground">
            {isVi
              ? "Trace từng dòng ledger về nguồn CSV/PO/email. Dòng parse từ PO mặc định pending; dòng trusted CSV được dùng làm số production nếu có lệch."
              : "Trace each ledger line back to CSV/PO/email evidence. Parsed PO rows default to pending; trusted CSV rows drive production revenue when sources disagree."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" value={period} onChange={(e) => updateParam("period", e.target.value || "2026-03")} className="w-[160px]" />
          <Button variant={review ? "default" : "outline"} onClick={() => updateParam("review", review ? "" : "review_queue")}>
            <Filter className="mr-2 h-4 w-4" />Cần audit
          </Button>
          <Button variant="outline" onClick={() => navigate("/finance-control/revenue/setup")}>
            <Settings className="mr-2 h-4 w-4" />Thiết lập
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Rows</div><div className="mt-1 text-2xl font-bold">{stats.rows}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Qty</div><div className="mt-1 text-2xl font-bold">{numberFmt(stats.qty)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Revenue</div><div className="mt-1 text-2xl font-bold">{vnd(stats.revenue)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Need review</div><div className="mt-1 text-2xl font-bold">{stats.review}</div></CardContent></Card>
      </div>

      {error ? <Card className="border-destructive/40 bg-destructive/5"><CardContent className="p-4 text-sm text-destructive">Không đọc được revenue ledger.</CardContent></Card> : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Ledger source lines</CardTitle>
              <CardDescription>Search invoice/customer/product/review flag. Edit/approve actions sẽ được nối vào workflow ở slice tiếp theo.</CardDescription>
            </div>
            <div className="relative w-full lg:w-[360px]">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search source lines…" className="pl-9" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải…</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer / source</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Audit note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const raw = asRecord(row.raw_payload);
                    const po = asRecord(raw.po_reconciliation);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">{row.revenue_date}<div className="text-xs text-muted-foreground">#{row.source_row_number}</div></TableCell>
                        <TableCell className="min-w-[260px]">
                          <div className="font-medium">{String(raw.parent_customer_name || row.customer_name)}</div>
                          <div className="text-xs text-muted-foreground">{row.customer_name}</div>
                          <div className="text-xs text-muted-foreground">{row.source_tab || row.source_type} · {row.invoice_no || "no invoice"}</div>
                        </TableCell>
                        <TableCell className="min-w-[220px]">{row.product_name || "—"}<div className="text-xs text-muted-foreground">{row.item_note || row.branch || ""}</div></TableCell>
                        <TableCell className="text-right">{numberFmt(Number(row.quantity || 0))}</TableCell>
                        <TableCell className="text-right font-semibold">{vnd(Number(row.gross_revenue || 0))}</TableCell>
                        <TableCell className="space-y-1">
                          <div>{statusBadge(row.approval_status)}</div>
                          <div>{statusBadge(row.reconciliation_status)}</div>
                        </TableCell>
                        <TableCell className="min-w-[260px] text-sm">
                          {row.review_status === "needs_manual_review" || row.audit_status === "needs_review" ? (
                            <div className="flex gap-2 text-amber-700"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{String(po.review_flag || row.audit_status || "needs_manual_review")}</span></div>
                          ) : (
                            <div className="flex gap-2 text-emerald-700"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{row.confidence_status}</span></div>
                          )}
                          {po.po_qty != null ? <div className="mt-1 text-xs text-muted-foreground">PO qty: {String(po.po_qty)}; delta: {String(po.delta_qty)}</div> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
