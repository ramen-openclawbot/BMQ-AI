import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CheckCircle2, Database, Eye, Loader2, Settings, TrendingUp, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

const sourceTypeLabel: Record<string, string> = {
  manual_invoice: "Invoice",
  po_parse: "PO parse",
  email_parse: "Email parse",
  csv_import: "CSV",
  csv: "CSV",
  email: "Email",
  parsed_po: "Parsed PO",
  po: "PO",
  manual: "Manual",
};

const metricCards = [
  {
    key: "total",
    label: "Doanh thu",
    helper: "ledger lines",
    icon: TrendingUp,
    valueTone: "text-amber-100",
    iconShell: "border-amber-300/30 bg-amber-400/10 text-amber-200",
    cardTone: "from-amber-950/35 to-stone-950",
  },
  {
    key: "approved",
    label: "Approved",
    helper: "Trusted / approved only",
    icon: CheckCircle2,
    valueTone: "text-emerald-200",
    iconShell: "border-emerald-300/25 bg-emerald-400/[0.08] text-emerald-200",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
  {
    key: "review",
    label: "Cần audit",
    helper: "Manual review queue",
    icon: AlertTriangle,
    valueTone: "text-rose-200",
    iconShell: "border-rose-300/30 bg-rose-400/[0.08] text-rose-200",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
  {
    key: "qty",
    label: "Sản lượng",
    helper: "Quantity from ledger",
    icon: CalendarDays,
    valueTone: "text-amber-100/80",
    iconShell: "border-amber-300/20 bg-amber-400/[0.08] text-amber-300/70",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
  {
    key: "customers",
    label: "Customer/NPP",
    helper: "Roll-up groups",
    icon: Users,
    valueTone: "text-stone-100",
    iconShell: "border-stone-500/30 bg-stone-400/[0.08] text-stone-300",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
] as const;

const policyCards = [
  { title: "1. Dashboard", copy: "đọc approved/trusted revenue ledger.", rule: "border-l-amber-300 bg-amber-400/[0.06]" },
  { title: "2. CSV audit", copy: "thắng PO parse khi có lệch.", rule: "border-l-emerald-400 bg-emerald-400/[0.05]" },
  { title: "3. Parsed PO", copy: "mặc định pending, dùng để trace/edit.", rule: "border-l-amber-300 bg-amber-400/[0.05]" },
  { title: "4. Dòng lệch", copy: "đưa vào manual review, không tự net doanh thu.", rule: "border-l-rose-400 bg-rose-400/[0.06]" },
] as const;

const CHANNEL_COLORS = ["#FCD34D", "#FBBF24", "#6EE7B7", "#FCA5A5", "#D6D3D1"] as const;

const getChannelColor = (key: string, fallbackIndex: number) => {
  const knownIndex = Object.keys(channelLabel).indexOf(key);
  return CHANNEL_COLORS[(knownIndex >= 0 ? knownIndex : fallbackIndex) % CHANNEL_COLORS.length];
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
    <div className="relative space-y-6 rounded-lg border border-amber-200/10 bg-stone-950/40 p-4 ring-1 ring-stone-200/5 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1 border border-amber-300/40 bg-amber-400/10 text-amber-100">
              <Database className="h-3 w-3" />Trusted ledger
            </Badge>
            <Badge className="border border-emerald-300/25 bg-emerald-400/10 text-emerald-100">
              {basis === "trusted" ? "Approved only" : "All sources"}
            </Badge>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-amber-50 md:text-4xl">
            {isVi ? "Quản lý doanh thu" : "Revenue Management"}
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-stone-300/80 md:text-base">
            {isVi
              ? "Dashboard production theo tháng, ngày, kênh và customer. Số chính lấy từ approved/trusted revenue ledger; PO/email parse chỉ là nguồn đối chiếu cho đến khi được duyệt."
              : "Production dashboard by month, day, channel, and customer. The main numbers come from the approved/trusted revenue ledger; parsed PO/email rows remain evidence until approved."}
          </p>
        </div>
        <div aria-label="Bộ lọc doanh thu" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200/10 bg-gradient-to-br from-stone-900/80 to-stone-950/60 p-2 ring-1 ring-stone-200/5">
          <div className="flex flex-wrap items-center gap-2">
            <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value || monthNow())} className="w-[160px] border-stone-600/70 bg-stone-950/50 text-stone-100 hover:border-amber-300/40 focus-visible:ring-amber-300/30" />
            <Button className={basis === "trusted" ? "border border-amber-300/60 bg-amber-400 text-stone-950 hover:bg-amber-300" : "border border-stone-600/60 bg-transparent text-stone-200 hover:bg-stone-100/[0.04]"} variant={basis === "trusted" ? "default" : "outline"} onClick={() => setBasis("trusted")}>Trusted</Button>
            <Button className={basis === "all" ? "border border-amber-300/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15" : "border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100"} variant="outline" onClick={() => setBasis("all")}>All</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-amber-100/10 pt-2 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0">
            <Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" variant="outline" onClick={() => refetch()}>Refresh</Button>
            <Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" variant="outline" onClick={() => navigate("/finance-control/revenue/setup")}>
              <Settings className="mr-2 h-4 w-4" />Thiết lập doanh thu
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <Card className="border border-rose-300/40 bg-stone-950/80 ring-1 ring-rose-200/10">
          <CardContent className="flex items-center gap-3 bg-rose-400/[0.08] p-4 text-sm text-rose-200">
            <AlertTriangle className="h-5 w-5" />Không đọc được revenue ledger. Kiểm tra migration/database quyền truy cập.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {metricCards.map((card) => {
          const Icon = card.icon;
          const value = card.key === "total" || card.key === "approved" || card.key === "review"
            ? vnd(stats[card.key])
            : card.key === "qty"
              ? numberFmt(stats.qty)
              : String(stats.customers);
          const helper = card.key === "total" ? `${stats.rows} ${card.helper}` : card.helper;

          return (
            <Card key={card.key} className={`overflow-hidden rounded-xl border border-amber-100/10 bg-gradient-to-br ${card.cardTone} ring-1 ring-stone-200/5`}>
              <CardContent className="p-4 pr-5">
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2 pr-1">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-stone-300/80">{card.label}</div>
                    <div className={`mt-2 min-w-0 break-words text-xl font-semibold leading-tight tabular-nums tracking-tight sm:text-2xl 2xl:text-2xl ${card.valueTone}`}>
                      {isLoading ? <span className="inline-block h-7 w-24 animate-pulse rounded bg-stone-700/70 align-middle" /> : value}
                    </div>
                    <div className="mt-1 truncate text-xs text-stone-300/70">{helper}</div>
                  </div>
                  <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border ${card.iconShell}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isLoading ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-md border border-amber-200/10 bg-gradient-to-br from-stone-900/75 to-stone-950/60 ring-1 ring-stone-200/5"><Loader2 className="h-8 w-8 animate-spin text-amber-300" /></div>
      ) : (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="inline-flex gap-6 border-b border-stone-700/50 bg-transparent p-0">
            <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Tổng quan</TabsTrigger>
            <TabsTrigger value="customers" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Theo customer</TabsTrigger>
            <TabsTrigger value="channels" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Theo kênh</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/20 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
                <CardTitle className="text-amber-50">Doanh thu theo ngày</CardTitle>
                <CardDescription className="text-stone-300/75">Click bảng customer/kênh để mở chi tiết source/audit.</CardDescription>
              </CardHeader>
              <CardContent className="h-[360px] pt-6">
                {byDay.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-md border border-amber-100/10 bg-stone-950/40 text-sm text-stone-300/75">
                    Chưa có dữ liệu doanh thu cho kỳ này.
                  </div>
                ) : (
                  <ChartContainer config={{ revenue: { label: "Revenue", color: "#F2C15C" }, review: { label: "Review", color: "#E97878" } }} className="h-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byDay}>
                        <CartesianGrid stroke="rgba(245,158,11,0.14)" vertical={false} />
                        <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={12} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                        <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`} tickLine={false} axisLine={false} width={48} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                        <ChartTooltip content={<ChartTooltipContent formatter={(value) => vnd(Number(value))} />} />
                        <Legend
                          wrapperStyle={{ color: "rgba(245,245,244,0.74)", fontSize: 12 }}
                          formatter={(value) => (value === "revenue" ? "Doanh thu" : "Cần review")}
                        />
                        <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="review" fill="var(--color-review)" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/20 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
                <CardTitle className="text-amber-50">Source policy</CardTitle>
                <CardDescription className="text-stone-300/75">Rule production để tránh parser làm sai doanh thu.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-6 text-sm">
                {policyCards.map((item) => (
                  <div key={item.title} className={`rounded-md border-l-4 p-3 text-sm text-stone-100 ${item.rule}`}>
                    <b>{item.title}</b> {item.copy}
                  </div>
                ))}
                <Button className="w-full border border-rose-300/40 bg-rose-400/[0.04] text-rose-100 hover:bg-rose-400/[0.09]" variant="outline" onClick={() => openSources({ review: "review_queue" })}>
                  <Eye className="mr-2 h-4 w-4" />Mở dòng cần audit
                  {stats.review > 0 ? <Badge className="ml-2 border border-rose-200/40 bg-rose-300/10 text-rose-50" variant="outline">{vnd(stats.review)}</Badge> : null}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="customers">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/15 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
                <CardTitle className="text-amber-50">Doanh thu theo customer / NPP</CardTitle>
                <CardDescription className="text-stone-300/75">Click “Chi tiết” để xem source lines, PO trace và trạng thái audit.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto pt-4">
                <Table>
                  <TableHeader><TableRow className="border-b border-stone-700/50"><TableHead className="text-[11px] uppercase tracking-[0.16em] text-stone-400">Customer / NPP</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Qty</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Revenue</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Cần review</TableHead><TableHead className="text-[11px] uppercase tracking-[0.16em] text-stone-400">Source</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Action</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {byCustomer.map((row) => (
                      <TableRow key={row.key} className="border-b border-stone-800/60 hover:bg-amber-400/[0.08]">
                        <TableCell className="font-medium text-stone-100">{row.name}<div className="text-xs text-stone-400/70">{row.rows} lines</div></TableCell>
                        <TableCell className="text-right tabular-nums text-stone-100">{numberFmt(row.qty)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-100">{vnd(row.revenue)}</TableCell>
                        <TableCell className="text-right">{row.review > 0 ? <Badge className="border border-rose-300/40 bg-rose-400/10 text-rose-100" variant="outline">{vnd(row.review)}</Badge> : <span className="text-stone-500">—</span>}</TableCell>
                        <TableCell>{Array.from(row.sourceTypes).map((s) => <Badge key={s} className="mr-1 border border-amber-300/25 bg-amber-400/[0.07] text-amber-100" variant="secondary">{sourceTypeLabel[s] || s}</Badge>)}</TableCell>
                        <TableCell className="text-right"><Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" size="sm" variant="outline" onClick={() => openSources({ customer_key: row.key })}>Chi tiết</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channels">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/15 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30"><CardTitle className="text-amber-50">Doanh thu theo kênh</CardTitle><CardDescription className="text-stone-300/75">Circle chart theo tỷ trọng revenue của từng kênh trong trusted ledger.</CardDescription></CardHeader>
              <CardContent className="pt-4">
                {byChannel.length === 0 ? (
                  <div className="flex min-h-[260px] items-center justify-center rounded-md border border-amber-100/10 bg-stone-950/40 text-sm text-stone-300/75">
                    Chưa có dữ liệu kênh cho kỳ này.
                  </div>
                ) : (
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                    <div className="shrink-0 lg:w-72">
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie
                            data={byChannel}
                            dataKey="revenue"
                            nameKey="label"
                            cx="50%"
                            cy="50%"
                            innerRadius={68}
                            outerRadius={108}
                            paddingAngle={2}
                            strokeWidth={0}
                          >
                            {byChannel.map((row, index) => (
                              <Cell key={row.key} fill={getChannelColor(row.key, index)} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "#1c1917",
                              border: "1px solid rgba(251,191,36,0.15)",
                              borderRadius: "6px",
                              color: "#fef3c7",
                              fontSize: "12px",
                            }}
                            formatter={(value) => [vnd(Number(value)), "Revenue"]}
                            labelStyle={{ color: "#fef3c7" }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="min-w-0 flex-1 divide-y divide-stone-800/60">
                      {byChannel.map((row, index) => {
                        const pct = stats.total > 0 ? ((row.revenue / stats.total) * 100).toFixed(1) : "0.0";
                        const color = getChannelColor(row.key, index);

                        return (
                          <div key={row.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-stone-100">{row.label}</div>
                                <div className="truncate text-xs text-stone-400/70">{row.key}</div>
                                <div className="text-xs text-stone-400/70">{row.rows} rows · {numberFmt(row.qty)} qty</div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                              <div className="text-right">
                                <div className="text-sm font-semibold tabular-nums text-amber-100">{vnd(row.revenue)}</div>
                                <div className="text-xs text-stone-400">{pct}%</div>
                              </div>
                              <Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" size="sm" variant="outline" onClick={() => openSources({ channel: row.key })}>Chi tiết</Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
