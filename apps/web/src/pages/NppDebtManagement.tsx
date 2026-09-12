import { useLanguage } from "@/contexts/LanguageContext";
import { nppDebt } from "@/i18n/nppDebt";
import { formatText } from "@/i18n/format";
import { Fragment, useEffect, useMemo, useState } from "react";
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
import { fetchAllPages } from "@/lib/npp-debt-pagination";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

const DEFAULT_NPP_NAME = "Đại lý cấp 1 - Anh Thanh";
const REVENUE_ROWS_PAGE_SIZE = 20;

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

type DebtAdjustment = {
  id: string;
  customer_id: string;
  period_from: string;
  period_to: string;
  opening_balance_vnd: number | string;
  amount_collected_vnd: number | string;
  payment_due_date: string | null;
  note: string | null;
  updated_at?: string | null;
};

type DebtAdjustmentForm = {
  opening_balance_vnd: string;
  amount_collected_vnd: string;
  payment_due_date: string;
  note: string;
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
  range: (from: number, to: number) => LedgerLineQuery;
};
type DebtExportResponse = {
  success?: boolean;
  code?: string;
  error?: string;
  spreadsheetName?: string;
  webViewLink?: string | null;
  recipientEmails?: string[];
  attachmentName?: string | null;
  existingFileId?: string | null;
  existingWebViewLink?: string | null;
  emailResult?: { sent?: boolean; skipped?: boolean; reason?: string; attachmentName?: string };
};
type DebtExportOptions = { overwrite?: boolean };
type PendingOverwrite = { spreadsheetName: string; existingWebViewLink?: string | null };
type DebtExportError = Error & { uiKey?: keyof typeof nppDebt.vi; code?: string; spreadsheetName?: string; existingWebViewLink?: string | null };
type RpcQuery = PromiseLike<{ data: LedgerLine | null; error: QueryError }>;
type DebtAdjustmentQuery = PromiseLike<{ data: DebtAdjustment | null; error: QueryError }> & {
  select: (columns: string) => DebtAdjustmentQuery;
  eq: (column: string, value: string) => DebtAdjustmentQuery;
  maybeSingle: () => PromiseLike<{ data: DebtAdjustment | null; error: QueryError }>;
};
type DebtAdjustmentRpcQuery = PromiseLike<{ data: DebtAdjustment | null; error: QueryError }>;
type LocalizedStatus = (copy: typeof nppDebt.vi) => string;
type ExportStatus = {
  kind: "idle" | "pending" | "success" | "error";
  title: LocalizedStatus;
  message?: LocalizedStatus;
  webViewLink?: string;
};

const debtDb = supabase as unknown as {
  from: (table: "mini_crm_customers") => CustomerQuery;
};
const ledgerDb = supabase as unknown as {
  from: (table: "revenue_ledger_lines") => LedgerLineQuery;
  rpc: (fn: "edit_revenue_ledger_line", args: { _ledger_line_id: string; _patch: RevenueUpdatePayload; _note: string | null }) => RpcQuery;
};
const adjustmentDb = supabase as unknown as {
  from: (table: "customer_debt_period_adjustments") => DebtAdjustmentQuery;
  rpc: (fn: "upsert_customer_debt_period_adjustment", args: {
    _customer_id: string;
    _period_from: string;
    _period_to: string;
    _opening_balance_vnd: number;
    _amount_collected_vnd: number;
    _payment_due_date: string | null;
    _note: string | null;
  }) => DebtAdjustmentRpcQuery;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toNumber = (value: string, invalidMessage = "Invalid number") => {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(invalidMessage);
  return parsed;
};

const formatNumberInput = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));

const calculateGrossRevenueInput = (quantity: string, unitPrice: string) => {
  try {
    return formatNumberInput(toNumber(quantity) * toNumber(unitPrice));
  } catch {
    return null;
  }
};

const buildEditForm = (row: LedgerLine): RevenueEditForm => {
  const quantity = String(row.quantity ?? 0);
  const unitPrice = String(row.unit_price ?? 0);
  return {
    revenue_date: row.revenue_date || "",
    invoice_no: row.invoice_no || "",
    customer_name: row.customer_name || getRouteCustomerName(row) || "",
    product_name: row.product_name || "",
    item_note: row.item_note || "",
    quantity,
    unit_price: unitPrice,
    gross_revenue: calculateGrossRevenueInput(quantity, unitPrice) ?? String(row.gross_revenue ?? 0),
    audit_note: "",
  };
};

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
  const { language } = useLanguage();
  const copy = nppDebt[language];
  const { toast } = useToast();
  const { canEditModule } = useAuth();
  const canEditRevenue = canEditModule("finance_revenue");
  const [dateFrom, setDateFrom] = useState(isoMonthStart());
  const [dateTo, setDateTo] = useState(isoToday());
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [viewCustomerId, setViewCustomerId] = useState("");
  const [expandedAgencyId, setExpandedAgencyId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: "idle", title: () => "" });
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite | null>(null);
  const [editingLine, setEditingLine] = useState<LedgerLine | null>(null);
  const [directRevenuePage, setDirectRevenuePage] = useState(1);
  const [expandedAgencyRevenuePage, setExpandedAgencyRevenuePage] = useState(1);
  const [editForm, setEditForm] = useState<RevenueEditForm | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [debtAdjustmentForm, setDebtAdjustmentForm] = useState<DebtAdjustmentForm>({
    opening_balance_vnd: "0",
    amount_collected_vnd: "0",
    payment_due_date: "",
    note: "",
  });
  const [savingDebtAdjustment, setSavingDebtAdjustment] = useState(false);

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
    queryFn: () => fetchAllPages((from, to) => ledgerDb
        .from("revenue_ledger_lines")
        .select("id,revenue_date,invoice_no,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,revenue_source_documents(status,source_name)")
        .eq("approval_status", "approved")
        .gte("revenue_date", dateFrom)
        .lte("revenue_date", dateTo)
        .order("gross_revenue", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)),
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
  const {
    data: debtAdjustment,
    isLoading: debtAdjustmentLoading,
    refetch: refetchDebtAdjustment,
  } = useQuery<DebtAdjustment | null>({
    queryKey: ["customer-debt-period-adjustment", effectiveCustomerId, dateFrom, dateTo],
    enabled: Boolean(hasViewedDebt && effectiveCustomerId && !isSelectedNpp && dateFrom && dateTo),
    queryFn: async () => {
      const { data, error } = await adjustmentDb
        .from("customer_debt_period_adjustments")
        .select("id,customer_id,period_from,period_to,opening_balance_vnd,amount_collected_vnd,payment_due_date,note,updated_at")
        .eq("customer_id", effectiveCustomerId)
        .eq("period_from", dateFrom)
        .eq("period_to", dateTo)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const childAgencies = useMemo(
    () => isSelectedNpp ? customers.filter((c) => c.supplied_by_npp_customer_id === effectiveCustomerId && c.is_active !== false) : [],
    [customers, effectiveCustomerId, isSelectedNpp]
  );

  const { data: ledgerLines = [], isLoading: linesLoading, refetch } = useQuery<LedgerLine[]>({
    queryKey: ["debt-ledger-lines", effectiveCustomerId, dateFrom, dateTo],
    enabled: Boolean(hasViewedDebt && effectiveCustomerId && dateFrom && dateTo),
    queryFn: () => fetchAllPages((from, to) => ledgerDb
        .from("revenue_ledger_lines")
        .select("id,revenue_date,invoice_no,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,revenue_source_documents(status,source_name)")
        .eq("approval_status", "approved")
        .gte("revenue_date", dateFrom)
        .lte("revenue_date", dateTo)
        .order("revenue_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)),
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
  const expandedAgencyLines = useMemo(
    () => summaries.find((row) => row.id === expandedAgencyId)?.lines || [],
    [expandedAgencyId, summaries]
  );
  const directRevenueTotalPages = Math.max(1, Math.ceil(directLines.length / REVENUE_ROWS_PAGE_SIZE));
  const directRevenuePageSafe = Math.min(directRevenuePage, directRevenueTotalPages);
  const paginatedDirectLines = directLines.slice(
    (directRevenuePageSafe - 1) * REVENUE_ROWS_PAGE_SIZE,
    directRevenuePageSafe * REVENUE_ROWS_PAGE_SIZE
  );
  const expandedAgencyRevenueTotalPages = Math.max(1, Math.ceil(expandedAgencyLines.length / REVENUE_ROWS_PAGE_SIZE));
  const expandedAgencyRevenuePageSafe = Math.min(expandedAgencyRevenuePage, expandedAgencyRevenueTotalPages);
  const paginatedExpandedAgencyLines = expandedAgencyLines.slice(
    (expandedAgencyRevenuePageSafe - 1) * REVENUE_ROWS_PAGE_SIZE,
    expandedAgencyRevenuePageSafe * REVENUE_ROWS_PAGE_SIZE
  );

  useEffect(() => {
    setDirectRevenuePage(1);
  }, [effectiveCustomerId, dateFrom, dateTo, isSelectedNpp]);

  useEffect(() => {
    setExpandedAgencyRevenuePage(1);
  }, [expandedAgencyId]);

  useEffect(() => {
    if (directRevenuePage > directRevenueTotalPages) setDirectRevenuePage(directRevenueTotalPages);
  }, [directRevenuePage, directRevenueTotalPages]);

  useEffect(() => {
    if (expandedAgencyRevenuePage > expandedAgencyRevenueTotalPages) setExpandedAgencyRevenuePage(expandedAgencyRevenueTotalPages);
  }, [expandedAgencyRevenuePage, expandedAgencyRevenueTotalPages]);

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

  useEffect(() => {
    if (!hasViewedDebt || isSelectedNpp) return;
    setDebtAdjustmentForm({
      opening_balance_vnd: String(debtAdjustment?.opening_balance_vnd ?? 0),
      amount_collected_vnd: String(debtAdjustment?.amount_collected_vnd ?? 0),
      payment_due_date: debtAdjustment?.payment_due_date || "",
      note: debtAdjustment?.note || "",
    });
  }, [debtAdjustment, hasViewedDebt, isSelectedNpp]);

  const parsedOpeningBalance = Number(debtAdjustmentForm.opening_balance_vnd || 0);
  const parsedAmountCollected = Number(debtAdjustmentForm.amount_collected_vnd || 0);
  const openingBalance = Number.isFinite(parsedOpeningBalance) ? parsedOpeningBalance : 0;
  const amountCollected = Number.isFinite(parsedAmountCollected) ? parsedAmountCollected : 0;
  const remainingDebt = isSelectedNpp ? totals.payable : openingBalance + totals.gross - amountCollected;

  const saveDebtAdjustment = async () => {
    if (!effectiveCustomerId || isSelectedNpp) return;
    if (!canEditRevenue) {
      toast({ title: copy.youDoNotHavePermissionToEdit, variant: "destructive" });
      return;
    }
    setSavingDebtAdjustment(true);
    try {
      const nextOpeningBalance = toNumber(debtAdjustmentForm.opening_balance_vnd, copy.invalidNumber);
      const nextAmountCollected = toNumber(debtAdjustmentForm.amount_collected_vnd, copy.invalidNumber);
      if (nextAmountCollected < 0) throw new Error(copy.theAmountCollectedCannotBeNegative);
      const { error } = await adjustmentDb.rpc("upsert_customer_debt_period_adjustment", {
        _customer_id: effectiveCustomerId,
        _period_from: dateFrom,
        _period_to: dateTo,
        _opening_balance_vnd: nextOpeningBalance,
        _amount_collected_vnd: nextAmountCollected,
        _payment_due_date: debtAdjustmentForm.payment_due_date || null,
        _note: debtAdjustmentForm.note.trim() || null,
      });
      if (error) throw error;
      await refetchDebtAdjustment();
      toast({ title: copy.debtInformationSaved });
    } catch (error) {
      toast({
        title: copy.unableToSaveDebtInformation,
        description: error instanceof Error ? error.message : copy.pleaseTryAgain,
        variant: "destructive",
      });
    } finally {
      setSavingDebtAdjustment(false);
    }
  };

  const buildExportMutation = (sendEmail: boolean) => ({
    mutationFn: async (options?: DebtExportOptions) => {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (sessionError || !accessToken) throw Object.assign(new Error(copy.yourSessionHasExpiredPleaseSignIn), { uiKey: "yourSessionHasExpiredPleaseSignIn" });

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-npp-debt-sheet`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fromDate: dateFrom, toDate: dateTo, customerId: effectiveCustomerId, sendEmail, overwrite: Boolean(options?.overwrite) }),
      });
      const data = await response.json().catch(() => null) as DebtExportResponse | null;
      if (!response.ok || !data?.success) {
        const error = new Error(data?.error || (sendEmail ? copy.unableToSendDebtStatement : copy.unableToExportGoogleSheet)) as DebtExportError;
        if (!data?.error) error.uiKey = sendEmail ? "unableToSendDebtStatement" : "unableToExportGoogleSheet";
        error.code = data?.code;
        error.spreadsheetName = data?.spreadsheetName;
        error.existingWebViewLink = data?.existingWebViewLink;
        throw error;
      }
      return data;
    },
    onMutate: (options?: DebtExportOptions) => {
      const title: LocalizedStatus = (copy) => sendEmail ? copy.sendingDebtStatement : (options?.overwrite ? copy.overwritingGoogleSheet : copy.exportingGoogleSheet);
      setPendingOverwrite(null);
      setExportStatus({
        kind: "pending",
        title,
        message: (copy) => `${selectedCustomer?.customer_name || copy.customer} • ${dateFrom} → ${dateTo}`,
      });
      toast({ title: title(copy), description: sendEmail ? copy.creatingTheExcelAttachmentPleaseWaitA : copy.creatingTheFilePleaseWaitAMoment });
    },
    onSuccess: (data: DebtExportResponse) => {
      const emails = data?.recipientEmails || [];
      const title: LocalizedStatus = (copy) => sendEmail ? copy.debtStatementSent : copy.googleSheetExported;
      const baseName = data?.spreadsheetName || "Công nợ khách hàng";
      const message: LocalizedStatus = (copy) => sendEmail
        ? formatText(copy.excelRecipients, { name: data?.attachmentName || `${baseName}.xlsx`, emails: emails.join(", ") })
        : emails.length
          ? formatText(copy.recipients, { name: baseName, emails: emails.join(", ") })
          : formatText(copy.noRecipients, { name: baseName });
      setExportStatus({ kind: "success", title, message, webViewLink: sendEmail ? undefined : data?.webViewLink || undefined });
      toast({ title: title(copy), description: message(copy) });
      if (!sendEmail && data?.webViewLink) window.open(data.webViewLink, "_blank", "noopener,noreferrer");
    },
    onError: (error: DebtExportError) => {
      if (!sendEmail && error.code === "debt_sheet_exists") {
        const spreadsheetName = error.spreadsheetName || "";
        setPendingOverwrite({ spreadsheetName, existingWebViewLink: error.existingWebViewLink });
        setExportStatus({
          kind: "idle",
          title: () => "",
        });
        return;
      }
      const title: LocalizedStatus = (copy) => sendEmail ? copy.unableToSendEmail : copy.exportFailed;
      const message: LocalizedStatus = (copy) => (error.uiKey ? copy[error.uiKey] : error?.message) || (sendEmail ? copy.unableToSendTheDebtExcelFile : copy.unableToCreateGoogleSheet);
      setExportStatus({ kind: "error", title, message });
      toast({ title: title(copy), description: message(copy), variant: "destructive" });
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
    setEditForm((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      if (key === "quantity" || key === "unit_price") {
        const calculatedGross = calculateGrossRevenueInput(next.quantity, next.unit_price);
        if (calculatedGross !== null) next.gross_revenue = calculatedGross;
      }
      return next;
    });
  };

  const saveEdit = async () => {
    if (!editingLine || !editForm) return;
    if (!canEditRevenue) {
      toast({ title: copy.youDoNotHavePermissionToEdit2, variant: "destructive" });
      return;
    }

    const customerName = editForm.customer_name.trim();
    const revenueDate = editForm.revenue_date.trim();
    if (!customerName || !revenueDate) {
      toast({ title: copy.revenueDateOrCustomerNameIsMissing, variant: "destructive" });
      return;
    }

    setSavingEdit(true);
    try {
      const quantity = toNumber(editForm.quantity, copy.invalidNumber);
      const unitPrice = toNumber(editForm.unit_price, copy.invalidNumber);
      const grossRevenue = toNumber(editForm.gross_revenue, copy.invalidNumber);
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

      toast({ title: copy.revenueChangesSaved });
      setEditingLine(null);
      setEditForm(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.unableToSaveChanges;
      toast({ title: copy.unableToSaveChanges, description: message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  };

  const renderEditButton = (line: LedgerLine, className = "") => {
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

        {copy.edit}
      </Button>
    );
  };

  const renderRevenuePagination = (totalRows: number, currentPage: number, totalPages: number, setPage: (updater: (page: number) => number) => void) => (
    <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
      <span>{formatText(copy.pagination, { count: totalRows })}</span>
      <div className="flex items-center justify-between gap-2 md:justify-end">
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1}>

          {copy.previousPage}
        </Button>
        <span className="min-w-[104px] text-center font-medium text-foreground">{formatText(copy.revenuePage, { page: currentPage, total: totalPages })}</span>
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage >= totalPages}>

          {copy.nextPage}
        </Button>
      </div>
    </div>
  );

  const isLoading = customersLoading || (hasViewedDebt && (linesLoading || (!isSelectedNpp && debtAdjustmentLoading)));
  const canViewDebt = Boolean(selectedCustomerId && dateFrom && dateTo);
  const handleViewDebt = () => {
    if (!canViewDebt) return;
    setViewCustomerId(selectedCustomerId);
    setExpandedAgencyId(null);
    setExportStatus({ kind: "idle", title: () => "" });
    setPendingOverwrite(null);
  };

  return (
    <div data-staff-i18n="npp-debt-v1" data-stitch-npp-debt-theme="pantone-2026-light" className="space-y-4 bg-background text-foreground md:space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold leading-tight md:text-3xl">{copy.customerDebtManagement}</h1>
          <p className="hidden text-muted-foreground md:block">{copy.trackDebtByCustomerDistributorsDirectDealers}</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground md:hidden">
            <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary">
              {isSelectedNpp ? "NPP" : copy.customer}
            </Badge>
            <Badge variant="outline" className="border-border/70 bg-card/70">
              {dateFrom} → {dateTo}
            </Badge>
            <Badge variant="outline" className="border-border/70 bg-card/70">
              {isSelectedNpp ? formatText(copy.dealers, { count: childAgencies.length }) : formatText(copy.rows, { count: totals.lines })}
            </Badge>
          </div>
        </div>
        {hasViewedDebt && (
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end">
            <Button className="h-10 px-3 text-xs sm:text-sm md:w-auto" variant="outline" onClick={() => { void refetch(); if (!isSelectedNpp) void refetchDebtAdjustment(); }} disabled={isLoading}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}

              {copy.refresh}
            </Button>
            <Button className="h-10 px-3 text-xs sm:text-sm md:w-auto" onClick={() => exportMutation.mutate({})} disabled={!effectiveCustomerId || exportMutation.isPending || sendDebtMutation.isPending}>
              {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              <span className="md:hidden">{copy.exportSheet}</span>
              <span className="hidden md:inline">{copy.exportGoogleSheet}</span>
            </Button>
            <Button className="col-span-2 h-10 px-3 text-xs sm:text-sm md:col-span-1 md:w-auto" onClick={() => sendDebtMutation.mutate({})} disabled={!effectiveCustomerId || exportMutation.isPending || sendDebtMutation.isPending}>
              {sendDebtMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}

              {copy.sendDebtStatement}
            </Button>
          </div>
        )}
      </div>

      <Dialog open={Boolean(pendingOverwrite)} onOpenChange={(open) => { if (!open) setPendingOverwrite(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.thisDebtStatementFileAlreadyExists}</DialogTitle>
            <DialogDescription>
              {formatText(copy.overwritePrompt, { name: pendingOverwrite?.spreadsheetName || copy.debtStatementFile })}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
            {formatText(copy.overwriteWarning, { name: selectedCustomer?.customer_name || copy.customer2, from: dateFrom, to: dateTo })}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setPendingOverwrite(null)} disabled={exportMutation.isPending}>{copy.cancel}</Button>
            {pendingOverwrite?.existingWebViewLink ? (
              <Button asChild variant="secondary" disabled={exportMutation.isPending}>
                <a href={pendingOverwrite.existingWebViewLink} target="_blank" rel="noreferrer">{copy.openExistingFile}</a>
              </Button>
            ) : null}
            <Button onClick={() => exportMutation.mutate({ overwrite: true })} disabled={exportMutation.isPending}>
              {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}

              {copy.overwrite}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {exportStatus.kind !== "idle" && (
        <Card className={exportStatus.kind === "error" ? "border-destructive/60 bg-destructive/5" : "border-primary/20 bg-primary/5"}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {exportStatus.kind === "pending" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {exportStatus.title(copy)}
            </CardTitle>
            {exportStatus.message ? <CardDescription>{exportStatus.message(copy)}</CardDescription> : null}
          </CardHeader>
          {exportStatus.webViewLink ? (
            <CardContent className="pt-0">
              <Button asChild variant="outline" size="sm">
                <a href={exportStatus.webViewLink} target="_blank" rel="noreferrer">{copy.openGoogleSheet}</a>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      )}

      <Card className="bg-card/80 shadow-card">
        <CardHeader className="space-y-1 px-4 py-4 md:px-6 md:py-6">
          <CardTitle className="text-lg md:text-2xl">{copy.step1SelectACustomer}</CardTitle>
          <CardDescription className="text-xs md:text-sm">{copy.customersAreSortedBySalesFromHighest}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 md:px-6 md:pb-6">
          <div className="space-y-2">
            <Label className="text-xs md:text-sm">{copy.findCustomer}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-11 pl-9 text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={copy.enterCustomerNameBachDangAnhThanh}
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
                    active ? "border-primary/40 bg-primary/10 shadow-sm" : "border-border/70 bg-card/70 hover:bg-muted/40"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{customer.customer_name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{customer.customer_group || copy.customer}{customer.product_group ? ` • ${customer.product_group}` : ""}</div>
                      <div className="mt-2 text-xs font-medium text-primary">{copy.sales} {formatVnd(revenue)}</div>
                    </div>
                    {customer.is_npp ? <Badge className="shrink-0">NPP</Badge> : null}
                  </div>
                </button>
              );
            })}
            {filteredCustomers.length === 0 && (
              <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground md:col-span-2">

                {copy.noMatchingCustomersFound}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-4">
            <div className="min-w-0 space-y-2 md:col-span-1">
              <Label className="text-xs md:text-sm">{copy.fromDate}</Label>
              <Input className="h-11 w-full min-w-0 text-sm [color-scheme:light] md:h-10" type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setViewCustomerId(""); }} />
            </div>
            <div className="min-w-0 space-y-2 md:col-span-1">
              <Label className="text-xs md:text-sm">{copy.toDate}</Label>
              <Input className="h-11 w-full min-w-0 text-sm [color-scheme:light] md:h-10" type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setViewCustomerId(""); }} />
            </div>
            <div className="min-w-0 md:col-span-2 md:flex md:items-end">
              <Button className="h-11 w-full" onClick={handleViewDebt} disabled={!canViewDebt || customersLoading}>
                {customersLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}

                {copy.viewDebt}
              </Button>
            </div>
          </div>
          {selectedDraftCustomer && !hasViewedDebt && (
            <div className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary">
              {formatText(copy.selected, { name: selectedDraftCustomer.customer_name })}
            </div>
          )}
        </CardContent>
      </Card>

      {hasViewedDebt && (
        <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{isSelectedNpp ? copy.dealers2 : copy.rows2}</CardDescription><CardTitle className="text-xl md:text-2xl">{isSelectedNpp ? childAgencies.length : totals.lines}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{copy.quantity}</CardDescription><CardTitle className="text-xl md:text-2xl">{formatQty(totals.quantity)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{copy.reviewedRevenue}</CardDescription><CardTitle className="break-words text-base leading-tight md:text-2xl">{formatVnd(totals.gross)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="p-4 pb-3 md:p-6 md:pb-2"><CardDescription className="text-xs md:text-sm">{isSelectedNpp ? copy.debtAfterFees : copy.remainingDebt}</CardDescription><CardTitle className="break-words text-base leading-tight md:text-2xl">{formatVnd(remainingDebt)}</CardTitle></CardHeader></Card>
      </div>

      {!isSelectedNpp && (
        <Card data-customer-debt-period-adjustment className="border-primary/20 bg-card/80 shadow-card">
          <CardHeader className="space-y-1 px-4 py-4 md:px-6 md:py-5">
            <CardTitle className="text-lg">{copy.debtReconciliationInformation}</CardTitle>
            <CardDescription>

              {copy.revenueComesFromApprovedOrdersOpeningBalance}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-4 pb-4 md:grid-cols-4 md:px-6 md:pb-6">
            <div className="space-y-2">
              <Label>{copy.openingBalance}</Label>
              <Input
                inputMode="decimal"
                value={debtAdjustmentForm.opening_balance_vnd}
                onChange={(event) => setDebtAdjustmentForm((current) => ({ ...current, opening_balance_vnd: event.target.value }))}
                disabled={!canEditRevenue || savingDebtAdjustment}
              />
            </div>
            <div className="space-y-2">
              <Label>{copy.collected}</Label>
              <Input
                inputMode="decimal"
                value={debtAdjustmentForm.amount_collected_vnd}
                onChange={(event) => setDebtAdjustmentForm((current) => ({ ...current, amount_collected_vnd: event.target.value }))}
                disabled={!canEditRevenue || savingDebtAdjustment}
              />
            </div>
            <div className="space-y-2">
              <Label>{copy.paymentDueDate}</Label>
              <Input
                type="date"
                value={debtAdjustmentForm.payment_due_date}
                onChange={(event) => setDebtAdjustmentForm((current) => ({ ...current, payment_due_date: event.target.value }))}
                disabled={!canEditRevenue || savingDebtAdjustment}
              />
            </div>
            <div className="rounded-xl bg-primary/10 p-4">
              <div className="text-xs text-primary/80">{copy.remainingDebt}</div>
              <div className="mt-1 break-words text-lg font-semibold text-primary">{formatVnd(remainingDebt)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{copy.openingBalanceRevenueCollected}</div>
            </div>
            <div className="space-y-2 md:col-span-3">
              <Label>{copy.accountingNotes}</Label>
              <Input
                value={debtAdjustmentForm.note}
                onChange={(event) => setDebtAdjustmentForm((current) => ({ ...current, note: event.target.value }))}
                placeholder={copy.optional}
                disabled={!canEditRevenue || savingDebtAdjustment}
              />
            </div>
            <div className="flex items-end">
              <Button className="w-full" type="button" onClick={saveDebtAdjustment} disabled={!canEditRevenue || savingDebtAdjustment}>
                {savingDebtAdjustment ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}

                {copy.saveDebt}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-card/80 shadow-card">
        <CardHeader className="space-y-1 px-4 py-4 md:px-6 md:py-6">
          <CardTitle className="text-lg md:text-2xl">{isSelectedNpp ? copy.totalDistributorDebt : copy.customerDebt}</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            {selectedCustomer?.customer_name || copy.noCustomerSelected} • {isSelectedNpp ? "NPP" : copy.directCustomer} • {dateFrom} → {dateTo} • {formatText(copy.reviewedRows, { count: totals.lines })}
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
                        <div className="truncate font-semibold">{row.id === "unmapped" ? copy.unmappedDealer : row.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{formatText(copy.rowQuantity, { count: row.lines.length, quantity: formatQty(row.quantity) })}</div>
                      </div>
                      {row.id === "unmapped" ? <Badge variant="destructive" className="shrink-0">{copy.mappingRequired}</Badge> : <Badge className="shrink-0">OK</Badge>}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">{copy.totalBreadAmount}</div>
                        <div className="font-medium">{formatVnd(row.gross)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">{copy.managementFee}</div>
                        <div className="font-medium">{formatVnd(row.managementFee)}</div>
                      </div>
                      <div className="col-span-2 rounded-lg bg-primary/10 p-3">
                        <div className="text-xs text-primary/80">{copy.debt}</div>
                        <div className="text-lg font-semibold text-primary">{formatVnd(row.payable)}</div>
                      </div>
                    </div>
                    {expandedAgencyId === row.id && (
                      <div className="mt-4 space-y-2 border-t border-border/70 pt-3">
                        {paginatedExpandedAgencyLines.map((line) => (
                          <div key={line.id} className="rounded-lg bg-muted/30 p-3 text-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium">{line.product_name || line.customer_name || copy.bread}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{line.revenue_date} • {line.item_note || getRouteCustomerName(line) || "-"}</div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                                <div className="font-semibold">{formatVnd(Number(line.gross_revenue || 0))}</div>
                                {renderEditButton(line)}
                              </div>
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">{formatText(copy.quantityPrice, { quantity: formatQty(Number(line.quantity || 0)), price: formatVnd(Number(line.unit_price || 0)) })}</div>
                          </div>
                        ))}
                        {row.lines.length === 0 && <div className="py-3 text-center text-sm text-muted-foreground">{copy.noRowsInThisPeriod}</div>}
                        {row.lines.length > 0 && renderRevenuePagination(row.lines.length, expandedAgencyRevenuePageSafe, expandedAgencyRevenueTotalPages, setExpandedAgencyRevenuePage)}
                      </div>
                    )}
                  </div>
                ))}
                {summaries.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{copy.noDebtDataForThisDistributor}</div>}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy.dealer}</TableHead>
                      <TableHead className="text-right">{copy.rows2}</TableHead>
                      <TableHead className="text-right">{copy.quantity}</TableHead>
                      <TableHead className="text-right">{copy.totalBreadAmount}</TableHead>
                      <TableHead className="text-right">{copy.managementFee}</TableHead>
                      <TableHead className="text-right">{copy.debt}</TableHead>
                      <TableHead>{copy.status}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summaries.map((row) => (
                      <Fragment key={row.id}>
                        <TableRow key={row.id} className="cursor-pointer" onClick={() => setExpandedAgencyId(expandedAgencyId === row.id ? null : row.id)}>
                          <TableCell className="font-medium">{row.id === "unmapped" ? copy.unmappedDealer : row.name}</TableCell>
                          <TableCell className="text-right">{row.lines.length}</TableCell>
                          <TableCell className="text-right">{formatQty(row.quantity)}</TableCell>
                          <TableCell className="text-right">{formatVnd(row.gross)}</TableCell>
                          <TableCell className="text-right">{formatVnd(row.managementFee)}</TableCell>
                          <TableCell className="text-right font-semibold">{formatVnd(row.payable)}</TableCell>
                          <TableCell>{row.id === "unmapped" ? <Badge variant="destructive">{copy.mappingRequired}</Badge> : <Badge>OK</Badge>}</TableCell>
                        </TableRow>
                        {expandedAgencyId === row.id && (
                          <TableRow key={`${row.id}-detail`}>
                            <TableCell colSpan={7} className="bg-muted/30 p-0">
                              <div className="max-h-96 overflow-auto p-3">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>{copy.date}</TableHead>
                                      <TableHead>{copy.description}</TableHead>
                                      <TableHead>{copy.notes}</TableHead>
                                      <TableHead className="text-right">{copy.qty}</TableHead>
                                      <TableHead className="text-right">{copy.unitPrice}</TableHead>
                                      <TableHead className="text-right">{copy.amount}</TableHead>
                                      <TableHead className="text-right">{copy.actions}</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {paginatedExpandedAgencyLines.map((line) => (
                                      <TableRow key={line.id}>
                                        <TableCell>{line.revenue_date}</TableCell>
                                        <TableCell>{line.product_name || line.customer_name || copy.bread}</TableCell>
                                        <TableCell>{line.item_note || getRouteCustomerName(line) || "-"}</TableCell>
                                        <TableCell className="text-right">{formatQty(Number(line.quantity || 0))}</TableCell>
                                        <TableCell className="text-right">{formatVnd(Number(line.unit_price || 0))}</TableCell>
                                        <TableCell className="text-right">{formatVnd(Number(line.gross_revenue || 0))}</TableCell>
                                        <TableCell className="text-right">{renderEditButton(line, "ml-auto")}</TableCell>
                                      </TableRow>
                                    ))}
                                    {row.lines.length === 0 && <TableRow><TableCell colSpan={7} className="py-4 text-center text-muted-foreground">{copy.noRowsInThisPeriod}</TableCell></TableRow>}
                                  </TableBody>
                                </Table>
                                {row.lines.length > 0 && renderRevenuePagination(row.lines.length, expandedAgencyRevenuePageSafe, expandedAgencyRevenueTotalPages, setExpandedAgencyRevenuePage)}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))}
                    {summaries.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{copy.noDebtDataForThisDistributor}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {paginatedDirectLines.map((line) => (
                  <div key={line.id} className="rounded-xl border border-border/70 bg-card/70 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{line.product_name || line.customer_name || copy.revenue}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{line.revenue_date} • {line.channel || "-"}</div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                        <div className="font-semibold text-primary">{formatVnd(Number(line.gross_revenue || 0))}</div>
                        {renderEditButton(line)}
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{line.item_note || line.revenue_source_documents?.source_name || "-"}</div>
                    <div className="mt-3 text-xs text-muted-foreground">{formatText(copy.quantityPrice, { quantity: formatQty(Number(line.quantity || 0)), price: formatVnd(Number(line.unit_price || 0)) })}</div>
                  </div>
                ))}
                {directLines.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{copy.noDebtDataForThisCustomer}</div>}
                {directLines.length > 0 && renderRevenuePagination(directLines.length, directRevenuePageSafe, directRevenueTotalPages, setDirectRevenuePage)}
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy.date}</TableHead>
                      <TableHead>{copy.channel}</TableHead>
                      <TableHead>{copy.description}</TableHead>
                      <TableHead>{copy.notes}</TableHead>
                      <TableHead className="text-right">{copy.quantity}</TableHead>
                      <TableHead className="text-right">{copy.unitPrice}</TableHead>
                      <TableHead className="text-right">{copy.debt}</TableHead>
                      <TableHead className="text-right">{copy.actions}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedDirectLines.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell>{line.revenue_date}</TableCell>
                        <TableCell>{line.channel || "-"}</TableCell>
                        <TableCell className="font-medium">{line.product_name || line.customer_name || copy.revenue}</TableCell>
                        <TableCell>{line.item_note || line.revenue_source_documents?.source_name || "-"}</TableCell>
                        <TableCell className="text-right">{formatQty(Number(line.quantity || 0))}</TableCell>
                        <TableCell className="text-right">{formatVnd(Number(line.unit_price || 0))}</TableCell>
                        <TableCell className="text-right font-semibold">{formatVnd(Number(line.gross_revenue || 0))}</TableCell>
                        <TableCell className="text-right">{renderEditButton(line, "ml-auto")}</TableCell>
                      </TableRow>
                    ))}
                    {directLines.length === 0 && (
                      <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">{copy.noDebtDataForThisCustomer}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
                {directLines.length > 0 && renderRevenuePagination(directLines.length, directRevenuePageSafe, directRevenueTotalPages, setDirectRevenuePage)}
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
            <DialogTitle>{copy.editDebtRevenue}</DialogTitle>
            <DialogDescription>

              {copy.staffCanCorrectInaccurateRevenueNotesAre}
            </DialogDescription>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{copy.revenueDate}</Label>
                <Input type="date" value={editForm.revenue_date} onChange={(event) => updateEditField("revenue_date", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{copy.invoicePONumber}</Label>
                <Input value={editForm.invoice_no} onChange={(event) => updateEditField("invoice_no", event.target.value)} placeholder={copy.optional} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>{copy.customerDealer}</Label>
                <Input value={editForm.customer_name} onChange={(event) => updateEditField("customer_name", event.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>{copy.productDescription}</Label>
                <Input value={editForm.product_name} onChange={(event) => updateEditField("product_name", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{copy.quantity}</Label>
                <Input inputMode="decimal" value={editForm.quantity} onChange={(event) => updateEditField("quantity", event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{copy.unitPrice}</Label>
                <Input inputMode="decimal" value={editForm.unit_price} onChange={(event) => updateEditField("unit_price", event.target.value)} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>{copy.amountRevenue}</Label>
                <Input
                  inputMode="decimal"
                  value={editForm.gross_revenue}
                  readOnly
                  aria-readonly="true"
                  className="bg-muted/40"
                />
                <p className="text-xs text-muted-foreground">{copy.calculatedAsQuantityUnitPriceToPrevent}</p>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>{copy.internalNotesOptional}</Label>
                <Textarea value={editForm.audit_note} onChange={(event) => updateEditField("audit_note", event.target.value)} placeholder={copy.exampleAdjustToActualDeliveredQuantity} />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEdit} disabled={savingEdit}>{copy.cancel2}</Button>
            <Button type="button" onClick={saveEdit} disabled={savingEdit || !editForm}>
              {savingEdit ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}

              {copy.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
