import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CheckCircle2, Database, Eye, Loader2, Settings, TrendingUp, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useLanguage } from "@/contexts/LanguageContext";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);

const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

type RevenueLine = {
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
  audit_status: string;
  confidence_status: string;
  review_status: string;
  reconciliation_status: string;
  raw_payload: unknown;
};

type RevenueQuery = PromiseLike<{ data: RevenueLine[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

const db = supabase as unknown as {
  from: (table: string) => { select: (columns: string) => RevenueQuery };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function fetchAllRevenueLines(period: string, trustedOnly: boolean) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = db
      .from("revenue_ledger_lines")
      .select("id,period,revenue_date,channel,source_tab,customer_id,parent_customer_id,customer_name,quantity,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .eq("period", period)
      .order("revenue_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (trustedOnly) q = q.eq("approval_status", "approved").eq("source_document.status", "trusted");

    const { data, error } = await q;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

const channelLabel: Record<string, string> = {
  "Bread business wholesale channel": "Bánh mì wholesale",
  "Bakery business": "Bánh ngọt",
  Franchise: "Nhượng quyền / đại lý",
  "Retail kiosk": "Xe bán lẻ",
};

export default function RevenueManagementDashboard() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const navigate = useNavigate();
  const [period, setPeriod] = useState("2026-03");
  const [basis, setBasis] = useState<"trusted" | "all">("trusted");

  const { data: lines = [], isLoading, error, refetch } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-ledger-lines", period, basis],
    queryFn: async () => {
      return fetchAllRevenueLines(period, basis === "trusted");
    },
  });

  const stats = useMemo(() => {
    const total = lines.reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const qty = lines.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const approved = lines.filter((r) => r.approval_status === "approved").reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const pending = lines.filter((r) => r.approval_status === "pending").reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const review = lines.filter((r) => r.review_status === "needs_manual_review" || r.audit_status === "needs_review").reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const customers = new Set(lines.map((r) => r.parent_customer_id || r.customer_id || r.customer_name)).size;
    return { total, qty, approved, pending, review, customers, rows: lines.length };
  }, [lines]);

  const byDay = useMemo(() => {
    const map = new Map<string, { date: string; revenue: number; review: number }>();
    for (const row of lines) {
      const key = row.revenue_date;
      const cur = map.get(key) || { date: key.slice(5), revenue: 0, review: 0 };
      cur.revenue += Number(row.gross_revenue || 0);
      if (row.review_status === "needs_manual_review" || row.audit_status === "needs_review") cur.review += Number(row.gross_revenue || 0);
      map.set(key, cur);
    }
    return Array.from(map.values());
  }, [lines]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { key: string; label: string; revenue: number; qty: number; rows: number }>();
    for (const row of lines) {
      const key = row.channel || "unknown";
      const cur = map.get(key) || { key, label: channelLabel[key] || key, revenue: 0, qty: 0, rows: 0 };
      cur.revenue += Number(row.gross_revenue || 0);
      cur.qty += Number(row.quantity || 0);
      cur.rows += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [lines]);

  const byCustomer = useMemo(() => {
    const map = new Map<string, { key: string; name: string; revenue: number; qty: number; rows: number; review: number; sourceTypes: Set<string> }>();
    for (const row of lines) {
      const key = row.parent_customer_id || row.customer_id || row.customer_name;
      const raw = asRecord(row.raw_payload);
      const rollupName = String(raw.parent_customer_name || row.customer_name || "Chưa rõ khách hàng");
      const cur = map.get(key) || { key, name: rollupName, revenue: 0, qty: 0, rows: 0, review: 0, sourceTypes: new Set<string>() };
      cur.revenue += Number(row.gross_revenue || 0);
      cur.qty += Number(row.quantity || 0);
      cur.rows += 1;
      if (row.review_status === "needs_manual_review" || row.audit_status === "needs_review") cur.review += Number(row.gross_revenue || 0);
      cur.sourceTypes.add(row.source_type);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [lines]);

  const openSources = (params: Record<string, string>) => {
    const sp = new URLSearchParams({ period, ...params });
    navigate(`/finance-control/revenue/sources?${sp.toString()}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1"><Database className="h-3 w-3" />Trusted ledger</Badge>
            <Badge variant="outline">{basis === "trusted" ? "Approved only" : "All sources"}</Badge>
          </div>
          <h1 className="text-3xl font-display font-bold">{isVi ? "Quản lý doanh thu" : "Revenue Management"}</h1>
          <p className="max-w-3xl text-muted-foreground">
            {isVi
              ? "Dashboard production theo tháng, ngày, kênh và customer. Số chính lấy từ approved/trusted revenue ledger; PO/email parse chỉ là nguồn đối chiếu cho đến khi được duyệt."
              : "Production dashboard by month, day, channel, and customer. The main numbers come from the approved/trusted revenue ledger; parsed PO/email rows remain evidence until approved."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value || monthNow())} className="w-[160px]" />
          <Button variant={basis === "trusted" ? "default" : "outline"} onClick={() => setBasis("trusted")}>Trusted</Button>
          <Button variant={basis === "all" ? "default" : "outline"} onClick={() => setBasis("all")}>All</Button>
          <Button variant="outline" onClick={() => refetch()}>Refresh</Button>
          <Button variant="outline" onClick={() => navigate("/finance-control/revenue/setup")}>
            <Settings className="mr-2 h-4 w-4" />Thiết lập doanh thu
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-destructive">
            <AlertTriangle className="h-5 w-5" />Không đọc được revenue ledger. Kiểm tra migration/database quyền truy cập.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><TrendingUp className="h-4 w-4" />Doanh thu</div><div className="mt-2 text-2xl font-bold">{isLoading ? "…" : vnd(stats.total)}</div><div className="text-xs text-muted-foreground">{stats.rows} ledger lines</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4" />Approved</div><div className="mt-2 text-2xl font-bold">{vnd(stats.approved)}</div><div className="text-xs text-muted-foreground">Trusted / approved only</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="h-4 w-4" />Cần audit</div><div className="mt-2 text-2xl font-bold">{vnd(stats.review)}</div><div className="text-xs text-muted-foreground">Manual review queue</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarDays className="h-4 w-4" />Sản lượng</div><div className="mt-2 text-2xl font-bold">{numberFmt(stats.qty)}</div><div className="text-xs text-muted-foreground">Quantity from ledger</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Users className="h-4 w-4" />Customer/NPP</div><div className="mt-2 text-2xl font-bold">{stats.customers}</div><div className="text-xs text-muted-foreground">Roll-up groups</div></CardContent></Card>
      </div>

      {isLoading ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-xl border"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Tổng quan</TabsTrigger>
            <TabsTrigger value="customers">Theo customer</TabsTrigger>
            <TabsTrigger value="channels">Theo kênh</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Doanh thu theo ngày</CardTitle>
                <CardDescription>Click bảng customer/kênh để mở chi tiết source/audit.</CardDescription>
              </CardHeader>
              <CardContent className="h-[360px]">
                <ChartContainer config={{ revenue: { label: "Revenue", color: "hsl(var(--chart-1))" }, review: { label: "Review", color: "hsl(var(--chart-4))" } }} className="h-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byDay}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={12} />
                      <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`} tickLine={false} axisLine={false} width={48} />
                      <ChartTooltip content={<ChartTooltipContent formatter={(value) => vnd(Number(value))} />} />
                      <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Source policy</CardTitle>
                <CardDescription>Rule production để tránh parser làm sai doanh thu.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="rounded-lg border bg-muted/40 p-3"><b>1. Dashboard</b> đọc approved/trusted revenue ledger.</div>
                <div className="rounded-lg border bg-muted/40 p-3"><b>2. CSV audit</b> thắng PO parse khi có lệch.</div>
                <div className="rounded-lg border bg-muted/40 p-3"><b>3. Parsed PO</b> mặc định pending, dùng để trace/approve/edit.</div>
                <div className="rounded-lg border bg-muted/40 p-3"><b>4. Dòng lệch</b> đưa vào manual review, không tự net doanh thu.</div>
                <Button className="w-full" variant="outline" onClick={() => openSources({ review: "review_queue" })}>
                  <Eye className="mr-2 h-4 w-4" />Mở dòng cần audit
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="customers">
            <Card>
              <CardHeader>
                <CardTitle>Doanh thu theo customer / NPP</CardTitle>
                <CardDescription>Click “Chi tiết” để xem source lines, PO trace và trạng thái audit.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Customer / NPP</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Cần review</TableHead><TableHead>Source</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {byCustomer.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.name}<div className="text-xs text-muted-foreground">{row.rows} lines</div></TableCell>
                        <TableCell className="text-right">{numberFmt(row.qty)}</TableCell>
                        <TableCell className="text-right font-semibold">{vnd(row.revenue)}</TableCell>
                        <TableCell className="text-right">{row.review > 0 ? <Badge variant="outline">{vnd(row.review)}</Badge> : "—"}</TableCell>
                        <TableCell>{Array.from(row.sourceTypes).map((s) => <Badge key={s} variant="secondary" className="mr-1">{s}</Badge>)}</TableCell>
                        <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => openSources({ customer_key: row.key })}>Chi tiết</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channels">
            <Card>
              <CardHeader><CardTitle>Doanh thu theo kênh</CardTitle><CardDescription>Channel split theo trusted ledger.</CardDescription></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Kênh</TableHead><TableHead className="text-right">Rows</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {byChannel.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.label}<div className="text-xs text-muted-foreground">{row.key}</div></TableCell>
                        <TableCell className="text-right">{row.rows}</TableCell>
                        <TableCell className="text-right">{numberFmt(row.qty)}</TableCell>
                        <TableCell className="text-right font-semibold">{vnd(row.revenue)}</TableCell>
                        <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => openSources({ channel: row.key })}>Chi tiết</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
