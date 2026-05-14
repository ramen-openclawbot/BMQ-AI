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
  raw_payload: any;
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

const getRouteCustomerId = (line: LedgerLine) =>
  String(
    line.raw_payload?.route_customer_id ||
      line.raw_payload?.routeCustomerId ||
      line.raw_payload?.agency_customer_id ||
      ""
  ).trim();

const getRouteCustomerName = (line: LedgerLine) =>
  String(
    line.raw_payload?.route_customer_name ||
      line.raw_payload?.routeCustomerName ||
      line.raw_payload?.agency_customer_name ||
      line.raw_payload?.route ||
      ""
  ).trim();

export default function NppDebtManagement() {
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(isoDaysAgo(7));
  const [dateTo, setDateTo] = useState(isoToday());
  const [selectedNppId, setSelectedNppId] = useState("");
  const [expandedAgencyId, setExpandedAgencyId] = useState<string | null>(null);

  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["npp-debt-customers"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customers")
        .select("id,customer_name,customer_group,product_group,is_npp,supplied_by_npp_customer_id,npp_management_fee_vnd,is_active")
        .order("customer_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const nppCustomers = useMemo(() => customers.filter((c) => Boolean(c.is_npp)), [customers]);
  const effectiveNppId = useMemo(() => {
    if (selectedNppId) return selectedNppId;
    return nppCustomers.find((c) => normalizeText(c.customer_name) === normalizeText(DEFAULT_NPP_NAME))?.id || nppCustomers[0]?.id || "";
  }, [nppCustomers, selectedNppId]);
  const selectedNpp = useMemo(() => customers.find((c) => c.id === effectiveNppId) || null, [customers, effectiveNppId]);

  const childAgencies = useMemo(
    () => customers.filter((c) => c.supplied_by_npp_customer_id === effectiveNppId && c.is_active !== false),
    [customers, effectiveNppId]
  );

  const { data: ledgerLines = [], isLoading: linesLoading, refetch } = useQuery<LedgerLine[]>({
    queryKey: ["npp-debt-ledger-lines", effectiveNppId, dateFrom, dateTo],
    enabled: Boolean(effectiveNppId && dateFrom && dateTo),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
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
        line.parent_customer_id === effectiveNppId ||
        line.customer_id === effectiveNppId ||
        Boolean(customer) ||
        normalizeText(line.customer_name) === normalizeText(selectedNpp?.customer_name || "");
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
  }, [childAgencies, effectiveNppId, ledgerLines, selectedNpp?.customer_name]);

  const totals = useMemo(() => summaries.reduce((acc, row) => ({
    quantity: acc.quantity + row.quantity,
    gross: acc.gross + row.gross,
    managementFee: acc.managementFee + row.managementFee,
    payable: acc.payable + row.payable,
    lines: acc.lines + row.lines.length,
  }), { quantity: 0, gross: 0, managementFee: 0, payable: 0, lines: 0 }), [summaries]);

  const exportMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("export-npp-debt-sheet", {
        body: { fromDate: dateFrom, toDate: dateTo, nppCustomerId: effectiveNppId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Export Google Sheet thất bại");
      return data;
    },
    onSuccess: (data: any) => {
      toast({ title: "Đã xuất Google Sheet", description: data?.spreadsheetName || "Công nợ NPP" });
      if (data?.webViewLink) window.open(data.webViewLink, "_blank", "noopener,noreferrer");
    },
    onError: (error: any) => {
      toast({ title: "Export thất bại", description: error?.message || "Không thể tạo Google Sheet", variant: "destructive" });
    },
  });

  const isLoading = customersLoading || linesLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">Quản lý công nợ NPP</h1>
          <p className="text-muted-foreground">Tính công nợ đại lý lấy bánh từ NPP dựa trên doanh thu đã kiểm soát.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Làm mới
          </Button>
          <Button onClick={() => exportMutation.mutate()} disabled={!effectiveNppId || exportMutation.isPending}>
            {exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Xuất Google Sheet
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc</CardTitle>
          <CardDescription>Chọn NPP và kỳ công nợ cần xuất.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2 md:col-span-2">
              <Label>NPP</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={effectiveNppId} onChange={(e) => setSelectedNppId(e.target.value)}>
                {nppCustomers.map((npp) => <option key={npp.id} value={npp.id}>{npp.customer_name}</option>)}
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
        <Card><CardHeader className="pb-2"><CardDescription>Số đại lý</CardDescription><CardTitle>{childAgencies.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Số lượng</CardDescription><CardTitle>{formatQty(totals.quantity)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Doanh thu kiểm soát</CardDescription><CardTitle>{formatVnd(totals.gross)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Công nợ phải thu</CardDescription><CardTitle>{formatVnd(totals.payable)}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tổng công nợ</CardTitle>
          <CardDescription>
            {selectedNpp?.customer_name || "Chưa chọn NPP"} • {dateFrom} → {dateTo} • {totals.lines} dòng doanh thu đã kiểm soát
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
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
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Chưa có dữ liệu công nợ cho bộ lọc này.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
