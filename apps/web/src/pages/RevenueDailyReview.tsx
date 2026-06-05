import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2, Save, TriangleAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);
const REVENUE_ROWS_PAGE_SIZE = 20;

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const dateOnly = (value?: string | null) => String(value || "").slice(0, 10);

type RevenueDraft = {
  id: string;
  customer_id: string | null;
  sales_po_doc_id: string | null;
  status: string | null;
  source: string | null;
  po_number: string | null;
  po_order_date: string | null;
  delivery_date: string | null;
  total_amount: number | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  mini_crm_customers?: { customer_name?: string | null } | null;
};

type DraftEditState = Record<string, { amount: string; note: string; saving?: boolean }>;
type DraftQuery = PromiseLike<{ data: RevenueDraft[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => DraftQuery;
  order: (column: string, options: { ascending: boolean }) => DraftQuery;
  limit: (count: number) => DraftQuery;
};
type DraftRpcResult = PromiseLike<{ data: RevenueDraft | null; error: { message?: string } | null }>;
const db = supabase as unknown as {
  from: (table: "revenue_drafts") => {
    select: (columns: string) => DraftQuery;
  };
  rpc: (
    fn: "edit_revenue_draft_daily_review",
    args: {
      _draft_id: string;
      _amount: number;
      _note: string | null;
      _mark_exception: boolean;
    }
  ) => DraftRpcResult;
};

const getDraftDate = (draft: RevenueDraft) =>
  dateOnly(draft.po_order_date) || dateOnly(draft.delivery_date) || dateOnly(draft.created_at);

const statusLabel = (status?: string | null) => {
  if (status === "exception") return "Ngoại lệ";
  if (status === "rejected") return "Đã loại";
  if (status === "approved") return "Đã kiểm soát";
  if (status === "draft") return "Nháp";
  return "Cần kiểm tra";
};

export default function RevenueDailyReview() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canEditModule } = useAuth();
  const { toast } = useToast();
  const canEdit = canEditModule("finance_revenue");
  const [date, setDate] = useState(todayLocal());
  const [customer, setCustomer] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [status, setStatus] = useState("pending");
  const [reviewRowsPage, setReviewRowsPage] = useState(1);
  const [edits, setEdits] = useState<DraftEditState>({});

  const { data: drafts = [], isLoading, error } = useQuery<RevenueDraft[]>({
    queryKey: ["revenue-daily-review", date, status],
    queryFn: async () => {
      let query = db
        .from("revenue_drafts")
        .select("id,customer_id,sales_po_doc_id,status,source,po_number,po_order_date,delivery_date,total_amount,raw_payload,created_at,updated_at,mini_crm_customers(customer_name)")
        .order("created_at", { ascending: false })
        .limit(500);

      if (status !== "all") query = query.eq("status", status);
      const { data, error: queryError } = await query;
      if (queryError) throw queryError;
      return (data || []) as RevenueDraft[];
    },
  });

  const sourceOptions = useMemo(() => {
    const sources = new Set(drafts.map((draft) => draft.source || "auto-parse"));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }, [drafts]);

  const filteredDrafts = useMemo(() => {
    const needle = customer.trim().toLowerCase();
    return drafts.filter((draft) => {
      if (date && getDraftDate(draft) !== date) return false;
      const draftSource = draft.source || "auto-parse";
      if (sourceFilter !== "all" && draftSource !== sourceFilter) return false;
      if (!needle) return true;
      const customerName = draft.mini_crm_customers?.customer_name || "";
      return [customerName, draft.po_number].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [customer, date, drafts, sourceFilter]);

  const stats = useMemo(() => ({
    rows: filteredDrafts.length,
    amount: filteredDrafts.reduce((sum, draft) => sum + Number(draft.total_amount || 0), 0),
    exceptions: filteredDrafts.filter((draft) => draft.status === "exception").length,
  }), [filteredDrafts]);
  const reviewRowsTotalPages = Math.max(1, Math.ceil(filteredDrafts.length / REVENUE_ROWS_PAGE_SIZE));
  const reviewRowsPageSafe = Math.min(reviewRowsPage, reviewRowsTotalPages);
  const paginatedDrafts = filteredDrafts.slice(
    (reviewRowsPageSafe - 1) * REVENUE_ROWS_PAGE_SIZE,
    reviewRowsPageSafe * REVENUE_ROWS_PAGE_SIZE
  );

  useEffect(() => {
    setReviewRowsPage(1);
  }, [customer, date, sourceFilter, status]);

  useEffect(() => {
    if (reviewRowsPage > reviewRowsTotalPages) setReviewRowsPage(reviewRowsTotalPages);
  }, [reviewRowsPage, reviewRowsTotalPages]);

  const editFor = (draft: RevenueDraft) => edits[draft.id] || { amount: String(draft.total_amount ?? 0), note: "" };

  const openDraftEvidence = (draft: RevenueDraft) => {
    const draftDate = getDraftDate(draft);
    const period = draftDate.slice(0, 7);
    const params = new URLSearchParams({ period });
    if (draft.customer_id) params.set("customer_key", draft.customer_id);
    navigate(`/finance-control/revenue/sources?${params.toString()}`);
  };

  const openPoInboxEvidence = (draft: RevenueDraft) => {
    const params = new URLSearchParams();
    if (draft.po_number) params.set("q", draft.po_number);
    if (draft.sales_po_doc_id) params.set("sales_po_doc_id", draft.sales_po_doc_id);
    navigate(`/sales-po-inbox${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const updateEdit = (draft: RevenueDraft, patch: Partial<{ amount: string; note: string; saving: boolean }>) => {
    setEdits((prev) => ({ ...prev, [draft.id]: { ...editFor(draft), ...patch } }));
  };

  const saveDraftEdit = async (draft: RevenueDraft, asException = false) => {
    if (!canEdit) {
      toast({ title: "Không có quyền sửa", description: "Cần quyền edit Finance Revenue để lưu chỉnh sửa.", variant: "destructive" });
      return;
    }

    const edit = editFor(draft);
    const amount = Number(String(edit.amount).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount < 0) {
      toast({ title: "Số tiền không hợp lệ", description: "Vui lòng nhập doanh thu hợp lệ.", variant: "destructive" });
      return;
    }

    updateEdit(draft, { saving: true });

    const { error: updateError } = await db.rpc("edit_revenue_draft_daily_review", {
      _draft_id: draft.id,
      _amount: amount,
      _note: edit.note || null,
      _mark_exception: asException,
    });

    updateEdit(draft, { saving: false });
    if (updateError) {
      toast({ title: "Không lưu được chỉnh sửa", description: updateError.message, variant: "destructive" });
      return;
    }

    await queryClient.invalidateQueries({ queryKey: ["revenue-daily-review"] });
    await queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] });
    toast({ title: asException ? "Đã đánh dấu ngoại lệ" : "Đã lưu chỉnh sửa", description: "Audit metadata đã được ghi vào draft." });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-amber-200/15 bg-gradient-to-br from-stone-950 via-stone-900 to-amber-950/25 p-4 text-stone-100 md:p-6">
        <Button variant="ghost" className="mb-4 -ml-2 text-stone-300 hover:text-amber-100" onClick={() => navigate("/finance-control/revenue")}>
          <ArrowLeft className="mr-2 h-4 w-4" />Dashboard
        </Button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Badge className="border border-amber-300/35 bg-amber-400/10 text-amber-100">Staff daily review</Badge>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-amber-50 md:text-4xl">Revenue Daily Review</h1>
            <p className="max-w-3xl text-sm leading-6 text-stone-300/80">
              Kiểm tra doanh thu auto-parse theo ngày/customer. Chỉ sửa khi phát hiện sai; không có bước duyệt bắt buộc.
            </p>
          </div>
          <Button variant="outline" className="border-amber-300/35 bg-amber-400/[0.08] text-amber-100 hover:bg-amber-400/[0.14]" onClick={() => navigate("/finance-control/revenue/sources")}>
            <ExternalLink className="mr-2 h-4 w-4" />Open source detail
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label htmlFor="review-date">Date</Label>
          <Input id="review-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="review-customer">Customer/PO</Label>
          <Input id="review-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Tên khách hàng hoặc PO..." />
        </div>
        <div className="space-y-1">
          <Label htmlFor="review-source">Source</Label>
          <select id="review-source" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="all">Tất cả nguồn</option>
            {sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="review-status">Status</Label>
          <select id="review-status" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Cần kiểm tra</option>
            <option value="exception">Ngoại lệ</option>
            <option value="approved">Đã kiểm soát</option>
            <option value="all">Tất cả</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div className="rounded-lg border p-2">
            <div className="text-muted-foreground">Rows</div>
            <div className="font-semibold">{stats.rows}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-muted-foreground">Amount</div>
            <div className="truncate font-semibold" title={vnd(stats.amount)}>{vnd(stats.amount)}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-muted-foreground">Exceptions</div>
            <div className="font-semibold">{stats.exceptions}</div>
          </div>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <TriangleAlert className="h-4 w-4" />Không tải được revenue drafts.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Review queue</CardTitle>
          <CardDescription>Mobile dùng card; desktop có bảng đầy đủ.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
          ) : filteredDrafts.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Không có draft cần kiểm tra cho bộ lọc này.</div>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {paginatedDrafts.map((draft) => {
                  const edit = editFor(draft);
                  return (
                    <div key={draft.id} className="rounded-xl border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{draft.mini_crm_customers?.customer_name || "Chưa rõ khách hàng"}</div>
                          <div className="text-xs text-muted-foreground">{getDraftDate(draft)} • {draft.po_number || "No PO"} • {draft.source || "auto-parse"}</div>
                        </div>
                        <Badge variant={draft.status === "exception" ? "destructive" : "outline"}>{statusLabel(draft.status)}</Badge>
                      </div>
                      <div className="mt-3 grid gap-2">
                        <Input value={edit.amount} onChange={(e) => updateEdit(draft, { amount: e.target.value })} disabled={!canEdit} inputMode="decimal" />
                        <Textarea value={edit.note} onChange={(e) => updateEdit(draft, { note: e.target.value })} disabled={!canEdit} placeholder="Ghi chú chỉnh sửa..." />
                        <div className="grid grid-cols-2 gap-2">
                          <Button type="button" variant="outline" onClick={() => openDraftEvidence(draft)}>
                            <ExternalLink className="mr-2 h-4 w-4" />Nguồn
                          </Button>
                          <Button type="button" variant="outline" onClick={() => openPoInboxEvidence(draft)}>
                            PO inbox
                          </Button>
                        </div>
                        <div className="flex gap-2">
                          <Button className="flex-1" disabled={!canEdit || edit.saving} onClick={() => void saveDraftEdit(draft)}>
                            {edit.saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
                          </Button>
                          <Button variant="outline" disabled={!canEdit || edit.saving} onClick={() => void saveDraftEdit(draft, true)}>Exception</Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
                  <span>Mỗi trang tối đa 20 dòng doanh thu • {filteredDrafts.length} dòng</span>
                  <div className="flex items-center justify-between gap-2 md:justify-end">
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setReviewRowsPage((page) => Math.max(1, page - 1))} disabled={reviewRowsPageSafe <= 1}>Trang trước</Button>
                    <span className="min-w-[104px] text-center font-medium text-foreground">Trang doanh thu {reviewRowsPageSafe}/{reviewRowsTotalPages}</span>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setReviewRowsPage((page) => Math.min(reviewRowsTotalPages, page + 1))} disabled={reviewRowsPageSafe >= reviewRowsTotalPages}>Trang sau</Button>
                  </div>
                </div>
              </div>

              <div className="hidden overflow-x-auto lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Date / PO</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Parsed amount</TableHead>
                      <TableHead>Editable amount</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedDrafts.map((draft) => {
                      const edit = editFor(draft);
                      return (
                        <TableRow key={draft.id}>
                          <TableCell className="font-medium">{draft.mini_crm_customers?.customer_name || "Chưa rõ khách hàng"}</TableCell>
                          <TableCell>
                            <div>{getDraftDate(draft)}</div>
                            <div className="text-xs text-muted-foreground">{draft.po_number || "No PO"} • {draft.source || "auto-parse"}</div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">{draft.source || "auto-parse"}</div>
                            <Badge variant={draft.status === "exception" ? "destructive" : "outline"}>{statusLabel(draft.status)}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-medium">{vnd(Number(draft.total_amount || 0))}</TableCell>
                          <TableCell><Input className="w-40" value={edit.amount} onChange={(e) => updateEdit(draft, { amount: e.target.value })} disabled={!canEdit} /></TableCell>
                          <TableCell><Input className="w-64" value={edit.note} onChange={(e) => updateEdit(draft, { note: e.target.value })} disabled={!canEdit} placeholder="Audit note" /></TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="outline" onClick={() => openDraftEvidence(draft)}>Nguồn</Button>
                              <Button size="sm" variant="outline" onClick={() => openPoInboxEvidence(draft)}>PO</Button>
                              <Button size="sm" disabled={!canEdit || edit.saving} onClick={() => void saveDraftEdit(draft)}>
                                {edit.saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
                              </Button>
                              <Button size="sm" variant="outline" disabled={!canEdit || edit.saving} onClick={() => void saveDraftEdit(draft, true)}>Exception</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
                  <span>Mỗi trang tối đa 20 dòng doanh thu • {filteredDrafts.length} dòng</span>
                  <div className="flex items-center justify-between gap-2 md:justify-end">
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setReviewRowsPage((page) => Math.max(1, page - 1))} disabled={reviewRowsPageSafe <= 1}>Trang trước</Button>
                    <span className="min-w-[104px] text-center font-medium text-foreground">Trang doanh thu {reviewRowsPageSafe}/{reviewRowsTotalPages}</span>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setReviewRowsPage((page) => Math.min(reviewRowsTotalPages, page + 1))} disabled={reviewRowsPageSafe >= reviewRowsTotalPages}>Trang sau</Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
