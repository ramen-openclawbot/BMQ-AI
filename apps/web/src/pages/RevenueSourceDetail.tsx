import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Database, Filter, Loader2, PencilLine, Search, Settings, TriangleAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const vnd = (v: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);
const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);
const CONTROLLED_APRIL_PERIOD = "2026-04";

type RevenueLine = {
  id: string;
  source_document_id: string;
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

type RevenueEditForm = {
  revenue_date: string;
  invoice_no: string;
  customer_name: string;
  product_name: string;
  item_note: string;
  quantity: string;
  unit_price: string;
  gross_revenue: string;
  audit_note: string;
};

type RevenueUpdatePayload = {
  revenue_date: string;
  invoice_no: string | null;
  customer_name: string;
  product_name: string | null;
  item_note: string | null;
  quantity: number;
  unit_price: number;
  gross_revenue: number;
  approval_status: string;
  audit_status: "adjusted";
  confidence_status: "manual_review";
  review_status: "resolved";
  reconciliation_status: "manual_override";
  raw_payload: Record<string, unknown>;
};

type RevenueQuery = PromiseLike<{ data: RevenueLine[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueQuery;
  or: (filters: string) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

const db = supabase as unknown as {
  from: (table: string) => {
    select: (columns: string) => RevenueQuery;
  };
  rpc: (fn: "edit_revenue_ledger_line", args: { _ledger_line_id: string; _patch: RevenueUpdatePayload; _note: string | null }) => PromiseLike<{ data: RevenueLine | null; error: { message?: string } | null }>;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toNumber = (value: string) => {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error("Invalid number");
  return parsed;
};

const buildEditForm = (row: RevenueLine): RevenueEditForm => ({
  revenue_date: row.revenue_date || "",
  invoice_no: row.invoice_no || "",
  customer_name: row.customer_name || "",
  product_name: row.product_name || "",
  item_note: row.item_note || "",
  quantity: String(row.quantity ?? 0),
  unit_price: String(row.unit_price ?? 0),
  gross_revenue: String(row.gross_revenue ?? 0),
  audit_note: "",
});

const ledgerSnapshot = (row: RevenueLine) => ({
  revenue_date: row.revenue_date,
  invoice_no: row.invoice_no,
  customer_name: row.customer_name,
  product_name: row.product_name,
  item_note: row.item_note,
  quantity: row.quantity,
  unit_price: row.unit_price,
  gross_revenue: row.gross_revenue,
  approval_status: row.approval_status,
  audit_status: row.audit_status,
  confidence_status: row.confidence_status,
  review_status: row.review_status,
  reconciliation_status: row.reconciliation_status,
  raw_payload: row.raw_payload,
});

async function fetchAllRevenueSourceLines(period: string, channel: string, review: string, sourceDocumentId: string, revenueDate: string) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("revenue_ledger_lines")
      .select("id,source_document_id,source_row_number,period,revenue_date,channel,source_tab,branch,invoice_no,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .eq("period", period)
      .order("revenue_date", { ascending: true })
      .order("source_row_number", { ascending: true })
      .range(from, from + pageSize - 1);

    if (sourceDocumentId) query = query.eq("source_document_id", sourceDocumentId);
    if (revenueDate) query = query.eq("revenue_date", revenueDate);
    if (sourceDocumentId || revenueDate) {
      query = query
        .eq("source_document.status", "controlled")
        .eq("source_document.source_type", "po_email_parse")
        .eq("source_document.summary->>monthly_parse_kind", "auto_daily_post");
    } else {
      query = query.eq("source_document.status", "trusted");
    }
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
  const labels: Record<string, string> = {
    approved: "Đã kiểm soát",
    trusted: "Đã kiểm soát",
    tied: "Khớp đối soát",
    matched: "Khớp",
    matched_po: "Khớp PO",
    needs_review: "Cần kiểm tra",
    needs_manual_review: "Cần kiểm tra",
    po_delta: "Lệch PO",
    csv_only: "Chỉ có nguồn đối soát",
  };
  if (["approved", "trusted", "tied", "matched", "matched_po"].includes(status)) return <Badge variant="secondary">{labels[status] || status}</Badge>;
  if (["needs_review", "needs_manual_review", "po_delta", "csv_only"].includes(status)) return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{labels[status] || status}</Badge>;
  if (["rejected", "low_confidence"].includes(status)) return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export default function RevenueSourceDetail() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const { toast } = useToast();
  const isVi = language === "vi";
  const canEdit = canEditModule("finance_revenue");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const period = params.get("period") || CONTROLLED_APRIL_PERIOD;
  const channel = params.get("channel") || "";
  const customerKey = params.get("customer_key") || "";
  const review = params.get("review") || "";
  const sourceDocumentId = params.get("sourceDocumentId") || "";
  const revenueDate = params.get("revenue_date") || "";
  const [q, setQ] = useState("");
  const [editingLine, setEditingLine] = useState<RevenueLine | null>(null);
  const [editForm, setEditForm] = useState<RevenueEditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: lines = [], isLoading, error, refetch } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-source-detail", period, channel, customerKey, review, sourceDocumentId, revenueDate],
    queryFn: async () => {
      return fetchAllRevenueSourceLines(period, channel, review, sourceDocumentId, revenueDate);
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

  const openEdit = (row: RevenueLine) => {
    setEditingLine(row);
    setEditForm(buildEditForm(row));
  };

  const closeEdit = () => {
    if (saving) return;
    setEditingLine(null);
    setEditForm(null);
  };

  const updateEditField = (key: keyof RevenueEditForm, value: string) => {
    setEditForm((current) => current ? { ...current, [key]: value } : current);
  };

  const saveEdit = async () => {
    if (!editingLine || !editForm) return;
    if (!canEdit) {
      toast({ title: "Không có quyền sửa doanh thu", variant: "destructive" });
      return;
    }

    const customerName = editForm.customer_name.trim();
    const revenueDate = editForm.revenue_date.trim();
    if (!customerName || !revenueDate) {
      toast({ title: "Thiếu ngày doanh thu hoặc tên khách", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const quantity = toNumber(editForm.quantity);
      const unitPrice = toNumber(editForm.unit_price);
      const grossRevenue = toNumber(editForm.gross_revenue);
      const note = editForm.audit_note.trim();
      const { data: authData } = await supabase.auth.getUser();
      const actorId = authData?.user?.id || null;
      const previousRaw = asRecord(editingLine.raw_payload);
      const auditDecision = {
        action: "edit",
        note: note || null,
        edited_at: new Date().toISOString(),
        edited_by: actorId,
        before: ledgerSnapshot(editingLine),
      };
      const payload: RevenueUpdatePayload = {
        revenue_date: revenueDate,
        invoice_no: editForm.invoice_no.trim() || null,
        customer_name: customerName,
        product_name: editForm.product_name.trim() || null,
        item_note: editForm.item_note.trim() || null,
        quantity,
        unit_price: unitPrice,
        gross_revenue: grossRevenue,
        approval_status: editingLine.approval_status,
        audit_status: "adjusted",
        confidence_status: "manual_review",
        review_status: "resolved",
        reconciliation_status: "manual_override",
        raw_payload: {
          ...previousRaw,
          audit_decision: auditDecision,
          audit_decisions: [...(Array.isArray(previousRaw.audit_decisions) ? previousRaw.audit_decisions : []), auditDecision],
        },
      };

      const { error: saveError } = await db.rpc("edit_revenue_ledger_line", {
        _ledger_line_id: editingLine.id,
        _patch: payload,
        _note: note || null,
      });
      if (saveError) throw saveError;

      toast({ title: "Đã lưu chỉnh sửa và ghi log" });
      setEditingLine(null);
      setEditForm(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không lưu được chỉnh sửa";
      toast({ title: "Không lưu được chỉnh sửa", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
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
            {sourceDocumentId ? <Badge variant="outline">Auto daily source</Badge> : null}
            {revenueDate ? <Badge variant="outline">{revenueDate}</Badge> : null}
          </div>
          <h1 className="text-3xl font-display font-bold">{isVi ? "Chi tiết nguồn doanh thu" : "Revenue source detail"}</h1>
          <p className="max-w-3xl text-muted-foreground">
            {isVi
              ? "Trace từng dòng ledger về nguồn đối soát/PO/email. Dòng parse từ PO là evidence vận hành; số dashboard lấy từ ledger đã kiểm soát."
              : "Trace each ledger line back to source evidence, PO, and email. Parsed PO rows are operational evidence; dashboard numbers come from the controlled ledger."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" value={period} onChange={(e) => updateParam("period", e.target.value || CONTROLLED_APRIL_PERIOD)} className="w-[160px]" />
          <Button variant={period === CONTROLLED_APRIL_PERIOD ? "default" : "outline"} onClick={() => updateParam("period", CONTROLLED_APRIL_PERIOD)}>
            T4/2026
          </Button>
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

      <Card className={canEdit ? "border-emerald-400/30 bg-emerald-950/35 text-emerald-50" : "border-amber-400/30 bg-amber-950/35 text-amber-50"}>
        <CardContent className="flex flex-col gap-2 p-4 text-sm md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-medium text-current">
              {canEdit ? "Bạn có quyền finance_revenue: có thể sửa dòng sai qua audited edit flow." : "Bạn chưa có quyền finance_revenue nên nút Edit đang bị khóa."}
            </div>
            <div className={canEdit ? "text-emerald-100/75" : "text-amber-100/75"}>
              Mỗi lần lưu dùng RPC edit_revenue_ledger_line, giữ approval status và ghi audit log trước/sau.
            </div>
          </div>
          <Badge className={canEdit ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-50" : "border-amber-300/40 bg-amber-400/10 text-amber-50"} variant="outline">
            {canEdit ? "Edit enabled" : "Read only"}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Ledger source lines</CardTitle>
              <CardDescription>Search invoice/customer/product/review flag. Staff sửa dòng sai tại đây; mỗi lần lưu sẽ ghi audit log.</CardDescription>
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
                    <TableHead className="text-right">Actions</TableHead>
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
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canEdit}
                            title={canEdit ? "Sửa dòng và ghi audit log" : "Cần quyền finance_revenue để sửa dòng doanh thu"}
                            onClick={() => openEdit(row)}
                          >
                            <PencilLine className="mr-2 h-3.5 w-3.5" />Edit
                          </Button>
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

      <Dialog open={!!editingLine} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Chỉnh dòng doanh thu</DialogTitle>
            <DialogDescription>
              Staff sửa khi phát hiện dòng sai. Khi lưu, hệ thống cập nhật ledger và ghi audit log.
            </DialogDescription>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="revenue-date">Ngày doanh thu</Label>
                  <Input id="revenue-date" type="date" value={editForm.revenue_date} onChange={(e) => updateEditField("revenue_date", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoice-no">Invoice no</Label>
                  <Input id="invoice-no" value={editForm.invoice_no} onChange={(e) => updateEditField("invoice_no", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="customer-name">Khách hàng</Label>
                  <Input id="customer-name" value={editForm.customer_name} onChange={(e) => updateEditField("customer_name", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="product-name">Sản phẩm</Label>
                  <Input id="product-name" value={editForm.product_name} onChange={(e) => updateEditField("product_name", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">Số lượng</Label>
                  <Input id="quantity" inputMode="decimal" value={editForm.quantity} onChange={(e) => updateEditField("quantity", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unit-price">Đơn giá</Label>
                  <Input id="unit-price" inputMode="decimal" value={editForm.unit_price} onChange={(e) => updateEditField("unit_price", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gross-revenue">Doanh thu</Label>
                  <Input id="gross-revenue" inputMode="decimal" value={editForm.gross_revenue} onChange={(e) => updateEditField("gross_revenue", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="item-note">Ghi chú dòng</Label>
                  <Input id="item-note" value={editForm.item_note} onChange={(e) => updateEditField("item_note", e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="audit-note">Lý do sửa / audit note</Label>
                <Textarea id="audit-note" value={editForm.audit_note} onChange={(e) => updateEditField("audit_note", e.target.value)} placeholder="VD: Sửa số lượng theo nguồn đối soát / PO…" />
              </div>
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Sau khi lưu: audit_status = adjusted, review_status = resolved, confidence_status = manual_review, reconciliation_status = manual_override. Approval status được giữ nguyên, không có bước approve riêng.
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Huỷ</Button>
            <Button onClick={saveEdit} disabled={saving || !canEdit}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Lưu & ghi log
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
