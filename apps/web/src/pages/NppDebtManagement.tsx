import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Loader2, Mail, PencilLine, RefreshCw, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

const DEFAULT_NPP_NAME = "Đại lý cấp 1 - Anh Thanh";

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value || 0));

const formatQty = (value: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(value || 0));

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoMonthStart = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const normalizeText = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type Customer = {
  id: string;
  customer_name: string;
  customer_group?: string | null;
  product_group?: string | null;
  is_npp?: boolean | null;
  supplied_by_npp_customer_id?: string | null;
  npp_management_fee_vnd?: number | string | null;
  is_active?: boolean | null;
};

type LedgerLine = {
  id: string;
  revenue_date: string;
  invoice_no?: string | null;
  channel: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_name: string | null;
  product_name: string | null;
  item_note: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  gross_revenue: number | string | null;
  source_type: string | null;
  approval_status: string | null;
  audit_status?: string | null;
  confidence_status?: string | null;
  review_status?: string | null;
  reconciliation_status?: string | null;
  raw_payload: unknown;
  revenue_source_documents?: { status?: string | null; source_name?: string | null } | null;
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
  approval_status: string | null;
  audit_status: "adjusted";
  confidence_status: "manual_review";
  review_status: "resolved";
  reconciliation_status: "manual_override";
  raw_payload: Record<string, unknown>;
};

type AgencySummary = {
  id: string;
  name: string;
  customer: Customer | null;
  lines: LedgerLine[];
  quantity: number;
  gross: number;
  managementFee: number;
  payable: number;
};

type QueryError = { message?: string } | null;
type CustomerQuery = PromiseLike<{ data: Customer[] | null; error: QueryError }> & {
  select: (columns: string) => CustomerQuery;
  order: (column: string, options: { ascending: boolean }) => CustomerQuery;
};
type LedgerLineQuery = PromiseLike<{ data: LedgerLine[] | null; error: QueryError }> & {
  select: (columns: string) => LedgerLineQuery;
  eq: (column: string, value: string) => LedgerLineQuery;
  gte: (column: string, value: string) => LedgerLineQuery;
  lte: (column: string, value: string) => LedgerLineQuery;
  order: (column: string, options: { ascending: boolean }) => LedgerLineQuery;
  limit: (count: number) => LedgerLineQuery;
};
type DebtExportResponse = { success?: boolean; error?: string; spreadsheetName?: string; webViewLink?: string | null; recipientEmails?: string[]; attachmentName?: string | null; emailResult?: { sent?: boolean; skipped?: boolean; reason?: string; attachmentName?: string } };
type RpcQuery = PromiseLike<{ data: LedgerLine | null; error: QueryError }>;
type ExportStatus = {
  kind: "idle" | "pending" | "success" | "error";
  title: string;
  message?: string;
  webViewLink?: string;
};

const debtDb = supabase as unknown as {
  from: (table: "mini_crm_customers") => CustomerQuery;
};
const ledgerDb = supabase as unknown as {
  from: (table: "revenue_ledger_lines") => LedgerLineQuery;
  rpc: (fn: "edit_revenue_ledger_line", args: { _ledger_line_id: string; _patch: RevenueUpdatePayload; _note: string | null }) => RpcQuery;
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

const buildEditForm = (row: LedgerLine): RevenueEditForm => ({
  revenue_date: row.revenue_date || "",
  invoice_no: row.invoice_no || "",
  customer_name: row.customer_name || getRouteCustomerName(row) || "",
  product_name: row.product_name || "",
  item_note: row.item_note || "",
  quantity: String(row.quantity ?? 0),
  unit_price: String(row.unit_price ?? 0),
  gross_revenue: String(row.gross_revenue ?? 0),
  audit_note: "",
});

const ledgerSnapshot = (row: LedgerLine) => ({
  revenue_date: row.revenue_date,
  invoice_no: row.invoice_no || null,
  customer_name: row.customer_name,
  product_name: row.product_name,
  item_note: row.item_note,
  quantity: row.quantity,
  unit_price: row.unit_price,
  gross_revenue: row.gross_revenue,
  approval_status: row.approval_status,
  audit_status: row.audit_status || null,
  confidence_status: row.confidence_status || null,
  review_status: row.review_status || null,
  reconciliation_status: row.reconciliation_status || null,
  raw_payload: row.raw_payload,
});

const getRouteCustomerId = (line: LedgerLine) => {
  const raw = asRecord(line.raw_payload);
  return String(
    raw.route_customer_id ||
      raw.routeCustomerId ||
      raw.agency_customer_id ||
      ""
  ).trim();
};

const getRouteCustomerName = (line: LedgerLine) => {
  const raw = asRecord(line.raw_payload);
  return String(
    raw.route_customer_name ||
      raw.routeCustomerName ||
      raw.agency_customer_name ||
      raw.route ||
      ""
  ).trim();
};

const lineBelongsToCustomer = (line: LedgerLine, customer: Customer | null) => {
  if (!customer) return false;
  const routeId = getRouteCustomerId(line);
  const routeName = getRouteCustomerName(line);
  return (
    line.customer_id === customer.id ||
    line.parent_customer_id === customer.id ||
    routeId === customer.id ||
    normalizeText(line.customer_name) === normalizeText(customer.customer_name) ||
    Boolean(routeName && normalizeText(routeName) === normalizeText(customer.customer_name))
  );
};

export default function NppDebtManagement() {
  const { toast } = useToast();
  const { canEditModule } = useAuth();
  const canEditRevenue = canEditModule("finance_revenue");
  const [dateFrom, setDateFrom] = useState(isoMonthStart());
  const [dateTo, setDateTo] = useState(isoToday());
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [viewCustomerId, setViewCustomerId] = useState("");
  const [expandedAgencyId, setExpandedAgencyId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: "idle", title: "" });
  const [editingLine, setEditingLine] = useState<LedgerLine | null>(null);
  const [editForm, setEditForm] = useState<RevenueEditForm | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["npp-debt-customers"],
    queryFn: async () => {
      const { data, error } = await debtDb
        .from("mini_crm_customers")
        .select("id,customer_name,customer_group,product_group,is_npp,supplied_by_npp_customer_id,npp_management_fee_vnd,is_active")
        .order("customer_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const activeCustomers = useMemo(() => customers.filter((c) => c.is_active !== false), [customers]);
  const selectableCustomers = useMemo(
    () => activeCustomers.filter((customer) => !customer.supplied_by_npp_customer_id),
    [activeCustomers]
  );
  const { data: customerRevenueLines = [] } = useQuery<LedgerLine[]>({
    queryKey: ["debt-customer-revenue-ranking", dateFrom, dateTo],
    enabled: Boolean(dateFrom && dateTo),
    queryFn: async () => {
      const { data, error } = await ledgerDb
        .from("revenue_ledger_lines")
        .select("id,revenue_date,invoice_no,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,revenue_source_documents(status,source_name)")
        .eq("approval_status", "approved")
        .gte("revenue_date", dateFrom)
        .lte("revenue_date", dateTo)
        .order("gross_revenue", { ascending: false })
        .limit(10000);
      if (error) throw error;
      return data || [];
    },
  });
  const customerRevenueById = useMemo(() => {
    const totals = new Map<string, number>();
    const customerById = new Map(activeCustomers.map((customer) => [customer.id, customer]));
    const customerByName = new Map(activeCustomers.map((customer) => [normalizeText(customer.customer_name), customer]));
    const addRevenue = (customerId: string, amount: number, seenIds: Set<string>) => {
      if (!customerId || !customerById.has(customerId) || seenIds.has(customerId)) return;
      seenIds.add(customerId);
      totals.set(customerId, (totals.get(customerId) || 0) + amount);
    };

    for (const line of customerRevenueLines) {
      const gross = Number(line.gross_revenue || 0);
      if (!gross) continue;
      const seenIds = new Set<string>();
      addRevenue(line.customer_id || "", gross, seenIds);
      addRevenue(line.parent_customer_id || "", gross, seenIds);
      addRevenue(getRouteCustomerId(line), gross, seenIds);

      const routeCustomer = customerByName.get(normalizeText(getRouteCustomerName(line)));
      addRevenue(routeCustomer?.id || "", gross, seenIds);

      const ledgerCustomer = customerByName.get(normalizeText(line.customer_name));
      addRevenue(ledgerCustomer?.id || "", gross, seenIds);
    }

    return totals;
  }, [activeCustomers, customerRevenueLines]);
  const selectedDraftCustomer = useMemo(() => activeCustomers.find((c) => c.id === selectedCustomerId) || null, [activeCustomers, selectedCustomerId]);
  const filteredCustomers = useMemo(() => {
    const normalizedQuery = normalizeText(searchTerm);
    const sorted = [...selectableCustomers].sort((a, b) => {
      const revenueA = customerRevenueById.get(a.id) || 0;
      const revenueB = customerRevenueById.get(b.id) || 0;
      if (revenueA !== revenueB) return revenueB - revenueA;
      if (a.customer_name === DEFAULT_NPP_NAME) return -1;
      if (b.customer_name === DEFAULT_NPP_NAME) return 1;
      return a.customer_name.localeCompare(b.customer_name, "vi");
    });
    if (!normalizedQuery) return sorted.slice(0, 8);
    return sorted
      .filter((customer) => normalizeText(customer.customer_name).includes(normalizedQuery))
      .slice(0, 12);
  }, [customerRevenueById, searchTerm, selectableCustomers]);
  const effectiveCustomerId = viewCustomerId;
  const hasViewedDebt = Boolean(viewCustomerId);
  const selectedCustomer = useMemo(() => customers.find((c) => c.id === effectiveCustomerId) || null, [customers, effectiveCustomerId]);
  const isSelectedNpp = Boolean(selectedCustomer?.is_npp);

  const childAgencies = useMemo(
    () => isSelectedNpp ? customers.filter((c) => c.supplied_by_npp_customer_id === effectiveCustomerId && c.is_active !== false) : [],
    [customers, effectiveCustomerId, isSelectedNpp]
  );

  const { data: ledgerLines = [], isLoading: linesLoading, refetch } = useQuery<LedgerLine[]>({
    queryKey: ["debt-ledger-lines", effectiveCustomerId, dateFrom, dateTo],
    enabled: Boolean(hasViewedDebt && effectiveCustomerId && dateFrom && dateTo),
    queryFn: async () => {
      const { data, error } = await ledgerDb
        .from("revenue_ledger_lines")
        .select("id,revenue_date,invoice_no,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,revenue_source_documents(status,source_name)")
        .eq("approval_status", "approved")
        .gte("revenue_date", dateFrom)
        .lte("revenue_date", dateTo)
        .order("revenue_date", { ascending: true })
        .limit(5000);
      if (error) throw error;
      return data || [];
    },
  });

  const summaries = useMemo<AgencySummary[]>(() => {
    if (!isSelectedNpp) return [];
    const childById = new Map(childAgencies.map((c) => [c.id, c]));
    const childByName = new Map(childAgencies.map((c) => [normalizeText(c.customer_name), c]));
    const groups = new Map<string, AgencySummary>();

    const ensureGroup = (id: string, name: string, customer: Customer | null) => {
      if (!groups.has(id)) {
        groups.set(id, { id, name, customer, lines: [], quantity: 0, gross: 0, managementFee: Number(customer?.npp_management_fee_vnd || 0), payable: 0 });
      }
      return groups.get(id)!;
    };

    for (const c of childAgencies) ensureGroup(c.id, c.customer_name, c);

    for (const line of ledgerLines) {
      const routeId = getRouteCustomerId(line);
      const routeName = getRouteCustomerName(line);
      let customer = routeId ? childById.get(routeId) || null : null;
      if (!customer && line.customer_id) customer = childById.get(line.customer_id) || null;
      if (!customer && routeName) customer = childByName.get(normalizeText(routeName)) || null;

      const belongsToNpp =
        line.parent_customer_id === effectiveCustomerId ||
        line.customer_id === effectiveCustomerId ||
        Boolean(customer) ||
        normalizeText(line.customer_name) === normalizeText(selectedCustomer?.customer_name || "");
      if (!belongsToNpp) continue;

      const group = customer
        ? ensureGroup(customer.id, customer.customer_name, customer)
        : ensureGroup("unmapped", "Chưa map đại lý", null);
      group.lines.push(line);
      group.quantity += Number(line.quantity || 0);
      group.gross += Number(line.gross_revenue || 0);
    }

    return Array.from(groups.values())
      .map((g) => ({ ...g, payable: g.gross - g.managementFee }))
      .sort((a, b) => (b.gross - a.gross) || a.name.localeCompare(b.name, "vi"));
  }, [childAgencies, effectiveCustomerId, isSelectedNpp, ledgerLines, selectedCustomer?.customer_name]);

  const directLines = useMemo(
    () => isSelectedNpp ? [] : ledgerLines.filter((line) => lineBelongsToCustomer(line, selectedCustomer)),
    [isSelectedNpp, ledgerLines, selectedCustomer]
  );

  const totals = useMemo(() => {
    if (!isSelectedNpp) {
      return directLines.reduce((acc, line) => ({
        quantity: acc.quantity + Number(line.quantity || 0),
        gross: acc.gross + Number(line.gross_revenue || 0),
        managementFee: 0,
        payable: acc.payable + Number(line.gross_revenue || 0),
        lines: acc.lines + 1,
      }), { quantity: 0, gross: 0, managementFee: 0, payable: 0, lines: 0 });
    }
    return summaries.reduce((acc, row) => ({
      quantity: acc.quantity + row.quantity,
      gross: acc.gross + row.gross,
      managementFee: acc.managementFee + row.managementFee,
      payable: acc.payable + row.payable,
      lines: acc.lines + row.lines.length,
    }), { quantity: 0, gross: 0, managementFee: 0, payable: 0, lines: 0 });
  }, [directLines, isSelectedNpp, summaries]);

  const buildExportMutation = (sendEmail: boolean) => ({
    mutationFn: async () => {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (sessionError || !accessToken) throw new Error("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-npp-debt-sheet`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fromDate: dateFrom, toDate: dateTo, customerId: effectiveCustomerId, sendEmail }),
      });
      const data = await response.json().catch(() => null) as DebtExportResponse | null;
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || (sendEmail ? "Gửi công nợ thất bại" : "Export Google Sheet thất bại"));
      }
      return data;
    },
    onMutate: () => {
      const title = sendEmail ? "Đang gửi công nợ" : "Đang xuất Google Sheet";
      setExportStatus({
        kind: "pending",
        title,
        message: `${selectedCustomer?.customer_name || "Khách hàng"} • ${dateFrom} → ${dateTo}`,
      });
      toast({ title, description: sendEmail ? "Hệ thống đang tạo file Excel đính kèm, vui lòng chờ trong giây lát." : "Hệ thống đang tạo file, vui lòng chờ trong giây lát." });
    },
    onSuccess: (data: DebtExportResponse) => {
      const emails = data?.recipientEmails || [];
      const title = sendEmail ? "Đã gửi công nợ" : "Đã xuất Google Sheet";
      const baseName = data?.spreadsheetName || "Công nợ khách hàng";
      const message = sendEmail
        ? `${data?.attachmentName || `${baseName}.xlsx`} • file Excel đính kèm • Email CRM: ${emails.join(", ")}`
        : emails.length
          ? `${baseName} • Email CRM: ${emails.join(", ")}`
          : `${baseName} • Chưa có email CRM`;
      setExportStatus({ kind: "success", title, message, webViewLink: sendEmail ? undefined : data?.webViewLink || undefined });
      toast({ title, description: message });
      if (!sendEmail && data?.webViewLink) window.open(data.webViewLink, "_blank", "noopener,noreferrer");
    },
    onError: (error: Error) => {
      const title = sendEmail ? "Gửi email thất bại" : "Export thất bại";
      const message = error?.message || (sendEmail ? "Không thể gửi file Excel công nợ" : "Không thể tạo Google Sheet");
      setExportStatus({ kind: "error", title, message });
      toast({ title, description: message, variant: "destructive" });
    },
  });

  const exportMutation = useMutation(buildExportMutation(false));
  const sendDebtMutation = useMutation(buildExportMutation(true));

  const openEdit = (line: LedgerLine) => {
    setEditingLine(line);
    setEditForm(buildEditForm(line));
  };

  const closeEdit = () => {
    if (savingEdit) return;
    setEditingLine(null);
    setEditForm(null);
  };

  const updateEditField = (key: keyof RevenueEditForm, value: string) => {
    setEditForm((current) => current ? { ...current, [key]: value } : current);
  };

  const saveEdit = async () => {
    if (!editingLine || !editForm) return;
    if (!canEditRevenue) {
      toast({ title: "Không có quyền sửa doanh thu", variant: "destructive" });
      return;
    }

    const customerName = editForm.customer_name.trim();
    const revenueDate = editForm.revenue_date.trim();
    if (!customerName || !revenueDate) {
      toast({ title: "Thiếu ngày doanh thu hoặc tên khách", variant: "destructive" });
      return;
    }

    setSavingEdit(true);
    try {
      const quantity = toNumber(editForm.quantity);
      const unitPrice = toNumber(editForm.unit_price);
      const grossRevenue = toNumber(editForm.gross_revenue);
      const note = editForm.audit_note.trim();
      const { data: authData } = await supabase.auth.getUser();
      const previousRaw = asRecord(editingLine.raw_payload);
      const auditDecision = {
        action: "debt_detail_edit",
        note: note || null,
        edited_at: new Date().toISOString(),
        edited_by: authData?.user?.id || null,
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

      const { error } = await ledgerDb.rpc("edit_revenue_ledger_line", {
        _ledger_line_id: editingLine.id,
        _patch: payload,
        _note: note || null,
      });
      if (error) throw error;

      toast({ title: "Đã lưu chỉnh sửa doanh thu" });
      setEditingLine(null);
      setEditForm(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không lưu được chỉnh sửa";
      toast({ title: "Không lưu được chỉnh sửa", description: message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  };

  const renderEditButton = (line: LedgerLine, className?: string) => {
    if (!canEditRevenue) return null;
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn("h-8 gap-1 px-2 text-xs", className)}
        onClick={(event) => {
          event.stopPropagation();
          openEdit(line);
        }}
      >
        <PencilLine className="h-3.5 w-3.5" />
        Sửa
      </Button>
    );
  };

  const isLoading = customersLoading || (hasViewedDebt && linesLoading);
  const canViewDebt = Boolean(selectedCustomerId && dateFrom && dateTo);
  const handleViewDebt = () => {
    if (!canViewDebt) return;
    setViewCustomerId(selectedCustomerId);
    setExpandedAgencyId(null);
    setExportStatus({ kind: "idle", title: "" });
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold leading-tight md:text-3xl">Quản lý công nợ khách hàng</h1>
          <p className="hidden text-muted-foreground md:block">Theo dõi công nợ theo từng khách hàng: NPP, đại lý trực tiếp, B2B/Vietjet và các kênh doanh thu đã kiểm soát.</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground md:hidden">
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-100">
              {isSelectedNpp ? "NPP" : "Khách hàng"}
            </Badge>
            <Badge variant="outline" className="border-border/70 bg-card/70">
              {dateFrom} → {dateTo}
            </Badge>
            <Badge variant="outline" className="border-border/70 bg-card/70">
              {isSelectedNpp ? `${childAgencies.length} đại lý` : `${totals.lines} dòng`}
            </Badge>
          </div>
        </div>
        {hasViewedDebt && (
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end">
            <Button className="h-10 px-3 text-xs sm:text-sm md:w-auto" variant="outline" onClick={() => refetch()} disabled={isLoading}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Làm mới
            </Button>
            <Button className="h-10 px-3 text-xs sm:text-sm md:w-auto" onClick={() => exportMutation.mutate()} disabled={!effectiveCustomerId || exportMutation.isPending || sendDebtMutation.isPending}>
              {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              <span className="md:hidden">Xuất Sheet</span>
              <span className="hidden md:inline">Xuất Google Sheet</span>
            </Button>
            <Button className="col-span-2 h-10 px-3 text-xs sm:text-sm md:col-span-1 md:w-auto" onClick={() => sendDebtMutation.mutate()} disabled={!effectiveCustomerId || exportMutation.isPending || sendDebtMutation.isPending}>
              {sendDebtMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
              Gửi công nợ
            </Button>
          </div>
        )}
      </div>

      {exportStatus.kind !== "idle" && (
        <Card className={exportStatus.kind === "error" ? "border-destructive/60 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5"}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {exportStatus.kind === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exportStatus.title}
            </CardTitle>
            {exportStatus.message ? <CardDescription>{exportStatus.message}</CardDescription> : null}
          </CardHeader>
          {exportStatus.webViewLink ? (
            <CardContent className="pt-0">
              <Button asChild variant="outline" size="sm">
                <a href={exportStatus.webViewLink} target="_blank" rel="noreferrer">Mở Google Sheet</a>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      )}

      <Card>
        <CardHeader className="space-y-1 px-4 py-4 md:px-6 md:py-6">
          <CardTitle className="text-lg md:text-2xl">Bước 1: Chọn khách hàng</CardTitle>
          <CardDescription className="text-xs md:text-sm">Box mặc định xếp khách hàng theo doanh số từ cao xuống thấp; đại lý đã thuộc NPP sẽ nằm trong chi tiết NPP. Có thể tìm không dấu như “bach dang” để tìm “Bạch Đằng”.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 md:px-6 md:pb-6">
          <div className="space-y-2">
            <Label className="text-xs md:text-sm">Tìm khách hàng</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-11 pl-9 text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Nhập tên khách hàng: bach dang, anh thanh..."
              />
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {filteredCustomers.map((customer) => {
              const active = selectedCustomerId === customer.id;
              const revenue = customerRevenueById.get(customer.id) || 0;
              return (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => {
                    setSelectedCustomerId(customer.id);
                    setExpandedAgencyId(null);
                    if (viewCustomerId && viewCustomerId !== customer.id) setViewCustomerId("");
                  }}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    active ? "border-amber-500/60 bg-amber-500/10" : "border-border/70 bg-card/70 hover:bg-muted/40"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{customer.customer_name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{customer.customer_group || "Khách hàng"}{customer.product_group ? ` • ${customer.product_group}` : ""}</div>
                      <div className="mt-2 text-xs font-medium text-amber-200">Doanh số: {formatVnd(revenue)}</div>
                    </div>
                    {customer.is_npp ? <Badge className="shrink-0">NPP</Badge> : null}
                  </div>
                </button>
              );
            })}
            {filteredCustomers.length === 0 && (
              <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground md:col-span-2">
                Không tìm thấy khách hàng phù hợp.
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-4">
            <div className="min-w-0 space-y-2 md:col-span-1">
              <Label className="text-xs md:text-sm">Từ ngày</Label>
              <Input className="h-11 w-full min-w-0 text-sm [color-scheme:dark] md:h-10" type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setViewCustomerId(""); }} />
            </div>
            <div className="min-w-0 space-y-2 md:col-span-1">
              <Label className="text-xs md:text-sm">Đến ngày</Label>
              <Input className="h-11 w-full min-w-0 text-sm [color-scheme:dark] md:h-10" type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setViewCustomerId(""); }} />
            </div>
            <div className="min-w-0 md:col-span-2 md:flex md:items-end">
              <Button className="h-11 w-full" onClick={handleViewDebt} disabled={!canViewDebt || customersLoading}>
                {customersLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Xem công nợ
              </Button>
            </div>
          </div>
          {selectedDraftCustomer && !hasViewedDebt && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Đã chọn: {selectedDraftCustomer.customer_name}. Bấm “Xem công nợ” để tải dữ liệu và mở chức năng xuất/gửi mail.
            </div>
          )}
        </CardContent>
      </Card>

      {hasViewedDebt && (
        <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{isSelectedNpp ? "Số đại lý" : "Số dòng"}</CardDescription><CardTitle className="text-xl md:text-2xl">{isSelectedNpp ? childAgencies.length : totals.lines}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">Số lượng</CardDescription><CardTitle className="text-xl md:text-2xl">{formatQty(totals.quantity)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">Doanh thu kiểm soát</CardDescription><CardTitle className="break-words text-base leading-tight md:text-2xl">{formatVnd(totals.gross)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{isSelectedNpp ? "Công nợ sau phí" : "Công nợ phải thu"}</CardDescription><CardTitle className="break-words text-base leading-tight md:text-2xl">{formatVnd(totals.payable)}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader className="space-y-1 px-4 py-4 md:px-6 md:py-6">
          <CardTitle className="text-lg md:text-2xl">{isSelectedNpp ? "Tổng công nợ NPP" : "Công nợ khách hàng"}</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            {selectedCustomer?.customer_name || "Chưa chọn khách hàng"} • {isSelectedNpp ? "NPP" : "Khách hàng trực tiếp"} • {dateFrom} → {dateTo} • {totals.lines} dòng doanh thu đã kiểm soát
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
          {isSelectedNpp ? (
            <>
              <div className="space-y-3 md:hidden">
                {summaries.map((row) => (
                  <div key={row.id} className="rounded-xl border border-border/70 bg-card/70 p-4 shadow-sm" onClick={() => setExpandedAgencyId(expandedAgencyId === row.id ? null : row.id)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{row.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{row.lines.length} dòng • SL {formatQty(row.quantity)}</div>
                      </div>
                      {row.id === "unmapped" ? <Badge variant="destructive" className="shrink-0">Cần map</Badge> : <Badge className="shrink-0">OK</Badge>}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">Tổng tiền bánh</div>
                        <div className="font-medium">{formatVnd(row.gross)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Phí quản lí</div>
                        <div className="font-medium">{formatVnd(row.managementFee)}</div>
                      </div>
                      <div className="col-span-2 rounded-lg bg-amber-500/10 p-3">
                        <div className="text-xs text-amber-100/80">Công nợ</div>
                        <div className="text-lg font-semibold text-amber-100">{formatVnd(row.payable)}</div>
                      </div>
                    </div>
                    {expandedAgencyId === row.id && (
                      <div className="mt-4 space-y-2 border-t border-border/70 pt-3">
                        {row.lines.map((line) => (
                          <div key={line.id} className="rounded-lg bg-muted/30 p-3 text-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium">{line.product_name || line.customer_name || "Bánh mì"}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{line.revenue_date} • {line.item_note || getRouteCustomerName(line) || "-"}</div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                                <div className="font-semibold">{formatVnd(Number(line.gross_revenue || 0))}</div>
                                {renderEditButton(line)}
                              </div>
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">SL {formatQty(Number(line.quantity || 0))} • Đơn giá {formatVnd(Number(line.unit_price || 0))}</div>
                          </div>
                        ))}
                        {row.lines.length === 0 && <div className="py-3 text-center text-sm text-muted-foreground">Chưa có dòng trong kỳ này.</div>}
                      </div>
                    )}
                  </div>
                ))}
                {summaries.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Chưa có dữ liệu công nợ cho NPP này.</div>}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Đại lý</TableHead>
                      <TableHead className="text-right">Số dòng</TableHead>
                      <TableHead className="text-right">Số lượng</TableHead>
                      <TableHead className="text-right">Tổng tiền bánh</TableHead>
                      <TableHead className="text-right">Phí quản lí</TableHead>
                      <TableHead className="text-right">Công nợ</TableHead>
                      <TableHead>Trạng thái</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summaries.map((row) => (
                      <Fragment key={row.id}>
                        <TableRow key={row.id} className="cursor-pointer" onClick={() => setExpandedAgencyId(expandedAgencyId === row.id ? null : row.id)}>
                          <TableCell className="font-medium">{row.name}</TableCell>
                          <TableCell className="text-right">{row.lines.length}</TableCell>
                          <TableCell className="text-right">{formatQty(row.quantity)}</TableCell>
                          <TableCell className="text-right">{formatVnd(row.gross)}</TableCell>
                          <TableCell className="text-right">{formatVnd(row.managementFee)}</TableCell>
                          <TableCell className="text-right font-semibold">{formatVnd(row.payable)}</TableCell>
                          <TableCell>{row.id === "unmapped" ? <Badge variant="destructive">Cần map</Badge> : <Badge>OK</Badge>}</TableCell>
                        </TableRow>
                        {expandedAgencyId === row.id && (
                          <TableRow key={`${row.id}-detail`}>
                            <TableCell colSpan={7} className="bg-muted/30 p-0">
                              <div className="max-h-96 overflow-auto p-3">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Ngày</TableHead>
                                      <TableHead>Diễn giải</TableHead>
                                      <TableHead>Ghi chú</TableHead>
                                      <TableHead className="text-right">SL</TableHead>
                                      <TableHead className="text-right">Đơn giá</TableHead>
                                      <TableHead className="text-right">Thành tiền</TableHead>
                                      <TableHead className="text-right">Thao tác</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {row.lines.map((line) => (
                                      <TableRow key={line.id}>
                                        <TableCell>{line.revenue_date}</TableCell>
                                        <TableCell>{line.product_name || line.customer_name || "Bánh mì"}</TableCell>
                                        <TableCell>{line.item_note || getRouteCustomerName(line) || "-"}</TableCell>
                                        <TableCell className="text-right">{formatQty(Number(line.quantity || 0))}</TableCell>
                                        <TableCell className="text-right">{formatVnd(Number(line.unit_price || 0))}</TableCell>
                                        <TableCell className="text-right">{formatVnd(Number(line.gross_revenue || 0))}</TableCell>
                                        <TableCell className="text-right">{renderEditButton(line, "ml-auto")}</TableCell>
                                      </TableRow>
                                    ))}
                                    {row.lines.length === 0 && <TableRow><TableCell colSpan={7} className="py-4 text-center text-muted-foreground">Chưa có dòng trong kỳ này.</TableCell></TableRow>}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))}
                    {summaries.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Chưa có dữ liệu công nợ cho NPP này.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {directLines.map((line) => (
                  <div key={line.id} className="rounded-xl border border-border/70 bg-card/70 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{line.product_name || line.customer_name || "Doanh thu"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{line.revenue_date} • {line.channel || "-"}</div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                        <div className="font-semibold text-amber-100">{formatVnd(Number(line.gross_revenue || 0))}</div>
                        {renderEditButton(line)}
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{line.item_note || line.revenue_source_documents?.source_name || "-"}</div>
                    <div className="mt-3 text-xs text-muted-foreground">SL {formatQty(Number(line.quantity || 0))} • Đơn giá {formatVnd(Number(line.unit_price || 0))}</div>
                  </div>
                ))}
                {directLines.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Chưa có dữ liệu công nợ cho khách hàng này.</div>}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày</TableHead>
                      <TableHead>Kênh</TableHead>
                      <TableHead>Diễn giải</TableHead>
                      <TableHead>Ghi chú</TableHead>
                      <TableHead className="text-right">Số lượng</TableHead>
                      <TableHead className="text-right">Đơn giá</TableHead>
                      <TableHead className="text-right">Công nợ</TableHead>
                      <TableHead className="text-right">Thao tác</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {directLines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>{line.revenue_date}</TableCell>
                        <TableCell>{line.channel || "-"}</TableCell>
                        <TableCell className="font-medium">{line.product_name || line.customer_name || "Doanh thu"}</TableCell>
                        <TableCell>{line.item_note || line.revenue_source_documents?.source_name || "-"}</TableCell>
                        <TableCell className="text-right">{formatQty(Number(line.quantity || 0))}</TableCell>
                        <TableCell className="text-right">{formatVnd(Number(line.unit_price || 0))}</TableCell>
                        <TableCell className="text-right font-semibold">{formatVnd(Number(line.gross_revenue || 0))}</TableCell>
                        <TableCell className="text-right">{renderEditButton(line, "ml-auto")}</TableCell>
                      </TableRow>
                    ))}
                    {directLines.length === 0 && (
                      <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Chưa có dữ liệu công nợ cho khách hàng này.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
        </>
      )}

      <Dialog open={Boolean(editingLine && editForm)} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa doanh thu công nợ</DialogTitle>
            <DialogDescription>
              Staff được phép sửa khi doanh thu chưa đúng. Ghi chú không bắt buộc; hệ thống vẫn ghi audit log khi lưu.
            </DialogDescription>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Ngày doanh thu</Label>
                <Input type="date" value={editForm.revenue_date} onChange={(event) => updateEditField("revenue_date", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Mã hóa đơn / PO</Label>
                <Input value={editForm.invoice_no} onChange={(event) => updateEditField("invoice_no", event.target.value)} placeholder="Không bắt buộc" />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Khách hàng / đại lý</Label>
                <Input value={editForm.customer_name} onChange={(event) => updateEditField("customer_name", event.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Sản phẩm / diễn giải</Label>
                <Input value={editForm.product_name} onChange={(event) => updateEditField("product_name", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Số lượng</Label>
                <Input inputMode="decimal" value={editForm.quantity} onChange={(event) => updateEditField("quantity", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Đơn giá</Label>
                <Input inputMode="decimal" value={editForm.unit_price} onChange={(event) => updateEditField("unit_price", event.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Thành tiền / doanh thu</Label>
                <Input inputMode="decimal" value={editForm.gross_revenue} onChange={(event) => updateEditField("gross_revenue", event.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Ghi chú nội bộ (không bắt buộc)</Label>
                <Textarea value={editForm.audit_note} onChange={(event) => updateEditField("audit_note", event.target.value)} placeholder="Ví dụ: sửa theo số giao thực tế" />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEdit} disabled={savingEdit}>Hủy</Button>
            <Button type="button" onClick={saveEdit} disabled={savingEdit || !editForm}>
              {savingEdit ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Lưu chỉnh sửa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
