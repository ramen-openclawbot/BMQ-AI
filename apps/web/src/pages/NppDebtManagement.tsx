import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const DEFAULT_NPP_NAME = "Đại lý cấp 1 - Anh Thanh";

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value || 0));

const formatQty = (value: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(value || 0));

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
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
  raw_payload: unknown;
  revenue_source_documents?: { status?: string | null; source_name?: string | null } | null;
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
type DebtExportResponse = { success?: boolean; error?: string; spreadsheetName?: string; webViewLink?: string };

const debtDb = supabase as unknown as {
  from: (table: "mini_crm_customers") => CustomerQuery;
};
const ledgerDb = supabase as unknown as {
  from: (table: "revenue_ledger_lines") => LedgerLineQuery;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

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
  const [dateFrom, setDateFrom] = useState(isoDaysAgo(7));
  const [dateTo, setDateTo] = useState(isoToday());
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [expandedAgencyId, setExpandedAgencyId] = useState<string | null>(null);

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
  const nppCustomers = useMemo(() => activeCustomers.filter((c) => Boolean(c.is_npp)), [activeCustomers]);
  const effectiveCustomerId = useMemo(() => {
    if (selectedCustomerId) return selectedCustomerId;
    return nppCustomers.find((c) => normalizeText(c.customer_name) === normalizeText(DEFAULT_NPP_NAME))?.id || activeCustomers[0]?.id || "";
  }, [activeCustomers, nppCustomers, selectedCustomerId]);
  const selectedCustomer = useMemo(() => customers.find((c) => c.id === effectiveCustomerId) || null, [customers, effectiveCustomerId]);
  const isSelectedNpp = Boolean(selectedCustomer?.is_npp);

  const childAgencies = useMemo(
    () => isSelectedNpp ? customers.filter((c) => c.supplied_by_npp_customer_id === effectiveCustomerId && c.is_active !== false) : [],
    [customers, effectiveCustomerId, isSelectedNpp]
  );

  const { data: ledgerLines = [], isLoading: linesLoading, refetch } = useQuery<LedgerLine[]>({
    queryKey: ["debt-ledger-lines", effectiveCustomerId, dateFrom, dateTo],
    enabled: Boolean(effectiveCustomerId && dateFrom && dateTo),
    queryFn: async () => {
      const { data, error } = await ledgerDb
        .from("revenue_ledger_lines")
        .select("id,revenue_date,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,raw_payload,revenue_source_documents(status,source_name)")
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

  const exportMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("export-npp-debt-sheet", {
        body: { fromDate: dateFrom, toDate: dateTo, nppCustomerId: effectiveCustomerId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Export Google Sheet thất bại");
      return data;
    },
    onSuccess: (data: DebtExportResponse) => {
      toast({ title: "Đã xuất Google Sheet", description: data?.spreadsheetName || "Công nợ khách hàng" });
      if (data?.webViewLink) window.open(data.webViewLink, "_blank", "noopener,noreferrer");
    },
    onError: (error: Error) => {
      toast({ title: "Export thất bại", description: error?.message || "Không thể tạo Google Sheet", variant: "destructive" });
    },
  });

  const isLoading = customersLoading || linesLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">Quản lý công nợ khách hàng</h1>
          <p className="text-muted-foreground">Theo dõi công nợ theo từng khách hàng: NPP, đại lý trực tiếp, B2B/Vietjet và các kênh doanh thu đã kiểm soát.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Làm mới
          </Button>
          {isSelectedNpp ? (
            <Button onClick={() => exportMutation.mutate()} disabled={!effectiveCustomerId || exportMutation.isPending}>
              {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Xuất Google Sheet
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc</CardTitle>
          <CardDescription>Chọn khách hàng và kỳ công nợ cần xem.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2 md:col-span-2">
              <Label>Khách hàng</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={effectiveCustomerId}
                onChange={(e) => { setSelectedCustomerId(e.target.value); setExpandedAgencyId(null); }}
              >
                {activeCustomers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.customer_name}{customer.is_npp ? " · NPP" : ""}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Từ ngày</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Đến ngày</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>{isSelectedNpp ? "Số đại lý" : "Số dòng"}</CardDescription><CardTitle>{isSelectedNpp ? childAgencies.length : totals.lines}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Số lượng</CardDescription><CardTitle>{formatQty(totals.quantity)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Doanh thu kiểm soát</CardDescription><CardTitle>{formatVnd(totals.gross)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{isSelectedNpp ? "Công nợ sau phí" : "Công nợ phải thu"}</CardDescription><CardTitle>{formatVnd(totals.payable)}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{isSelectedNpp ? "Tổng công nợ NPP" : "Công nợ khách hàng"}</CardTitle>
          <CardDescription>
            {selectedCustomer?.customer_name || "Chưa chọn khách hàng"} • {isSelectedNpp ? "NPP" : "Khách hàng trực tiếp"} • {dateFrom} → {dateTo} • {totals.lines} dòng doanh thu đã kiểm soát
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isSelectedNpp ? (
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
                                  </TableRow>
                                ))}
                                {row.lines.length === 0 && <TableRow><TableCell colSpan={6} className="py-4 text-center text-muted-foreground">Chưa có dòng trong kỳ này.</TableCell></TableRow>}
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
          ) : (
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
                  </TableRow>
                ))}
                {directLines.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Chưa có dữ liệu công nợ cho khách hàng này.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
