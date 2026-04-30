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

const metricCards = [
  {
    key: "total",
    label: "Doanh thu",
    helper: "ledger lines",
    icon: TrendingUp,
    accent: "from-cyan-500/25 via-sky-500/10 to-transparent",
    border: "border-cyan-300/35",
    iconTone: "bg-cyan-400/[0.18] text-cyan-200 ring-cyan-300/25",
    valueTone: "text-cyan-100",
  },
  {
    key: "approved",
    label: "Approved",
    helper: "Trusted / approved only",
    icon: CheckCircle2,
    accent: "from-emerald-500/25 via-lime-500/10 to-transparent",
    border: "border-emerald-300/35",
    iconTone: "bg-emerald-400/[0.18] text-emerald-200 ring-emerald-300/25",
    valueTone: "text-emerald-100",
  },
  {
    key: "review",
    label: "Cần audit",
    helper: "Manual review queue",
    icon: AlertTriangle,
    accent: "from-rose-500/25 via-fuchsia-500/10 to-transparent",
    border: "border-rose-300/35",
    iconTone: "bg-rose-400/[0.18] text-rose-200 ring-rose-300/25",
    valueTone: "text-rose-100",
  },
  {
    key: "qty",
    label: "Sản lượng",
    helper: "Quantity from ledger",
    icon: CalendarDays,
    accent: "from-violet-500/25 via-indigo-500/10 to-transparent",
    border: "border-violet-300/35",
    iconTone: "bg-violet-400/[0.18] text-violet-200 ring-violet-300/25",
    valueTone: "text-violet-100",
  },
  {
    key: "customers",
    label: "Customer/NPP",
    helper: "Roll-up groups",
    icon: Users,
    accent: "from-teal-500/25 via-emerald-500/10 to-transparent",
    border: "border-teal-300/35",
    iconTone: "bg-teal-400/[0.18] text-teal-200 ring-teal-300/25",
    valueTone: "text-teal-100",
  },
] as const;

const policyCards = [
  { title: "1. Dashboard", copy: "đọc approved/trusted revenue ledger.", tone: "border-l-cyan-300 bg-cyan-400/[0.08] text-cyan-50" },
  { title: "2. CSV audit", copy: "thắng PO parse khi có lệch.", tone: "border-l-emerald-300 bg-emerald-400/[0.08] text-emerald-50" },
  { title: "3. Parsed PO", copy: "mặc định pending, dùng để trace/edit.", tone: "border-l-violet-300 bg-violet-400/[0.08] text-violet-50" },
  { title: "4. Dòng lệch", copy: "đưa vào manual review, không tự net doanh thu.", tone: "border-l-rose-300 bg-rose-400/[0.08] text-rose-50" },
] as const;

const channelDotClasses = [
  "bg-cyan-300 text-cyan-300",
  "bg-emerald-300 text-emerald-300",
  "bg-violet-300 text-violet-300",
  "bg-rose-300 text-rose-300",
  "bg-teal-300 text-teal-300",
  "bg-sky-300 text-sky-300",
] as const;

const getChannelDotClass = (index: number) => channelDotClasses[index % channelDotClasses.length];

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
    <div className="relative space-y-6 overflow-hidden rounded-3xl border border-cyan-300/10 bg-gradient-to-br from-cyan-500/[0.07] via-transparent to-violet-500/[0.07] p-4 shadow-2xl shadow-cyan-950/20 md:p-6">
      <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 left-1/3 h-72 w-72 rounded-full bg-fuchsia-500/15 blur-3xl" />

      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1 border-cyan-300/40 bg-cyan-400/15 text-cyan-100 shadow-sm shadow-cyan-950/20">
              <Database className="h-3 w-3" />Trusted ledger
            </Badge>
            <Badge className="border-emerald-300/40 bg-emerald-400/15 text-emerald-100">
              {basis === "trusted" ? "Approved only" : "All sources"}
            </Badge>
          </div>
          <h1 className="bg-gradient-to-r from-cyan-100 via-emerald-100 to-violet-100 bg-clip-text text-3xl font-display font-bold text-transparent md:text-4xl">
            {isVi ? "Quản lý doanh thu" : "Revenue Management"}
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-200/80 md:text-base">
            {isVi
              ? "Dashboard production theo tháng, ngày, kênh và customer. Số chính lấy từ approved/trusted revenue ledger; PO/email parse chỉ là nguồn đối chiếu cho đến khi được duyệt."
              : "Production dashboard by month, day, channel, and customer. The main numbers come from the approved/trusted revenue ledger; parsed PO/email rows remain evidence until approved."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 backdrop-blur">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value || monthNow())} className="w-[160px] border-cyan-300/25 bg-cyan-950/20" />
          <Button className={basis === "trusted" ? "bg-cyan-500 text-cyan-950 hover:bg-cyan-400" : "border-cyan-300/35 text-cyan-100 hover:bg-cyan-400/10"} variant={basis === "trusted" ? "default" : "outline"} onClick={() => setBasis("trusted")}>Trusted</Button>
          <Button className={basis === "all" ? "bg-violet-500 text-white hover:bg-violet-400" : "border-violet-300/35 text-violet-100 hover:bg-violet-400/10"} variant={basis === "all" ? "default" : "outline"} onClick={() => setBasis("all")}>All</Button>
          <Button className="border-emerald-300/35 text-emerald-100 hover:bg-emerald-400/10" variant="outline" onClick={() => refetch()}>Refresh</Button>
          <Button className="border-rose-300/35 text-rose-100 hover:bg-rose-400/10" variant="outline" onClick={() => navigate("/finance-control/revenue/setup")}>
            <Settings className="mr-2 h-4 w-4" />Thiết lập doanh thu
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="relative border-rose-300/40 bg-rose-500/10">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-rose-100">
            <AlertTriangle className="h-5 w-5" />Không đọc được revenue ledger. Kiểm tra migration/database quyền truy cập.
          </CardContent>
        </Card>
      ) : null}

      <div className="relative grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {metricCards.map((card) => {
          const Icon = card.icon;
          const value = card.key === "total" || card.key === "approved" || card.key === "review"
            ? vnd(stats[card.key])
            : card.key === "qty"
              ? numberFmt(stats.qty)
              : String(stats.customers);
          const helper = card.key === "total" ? `${stats.rows} ${card.helper}` : card.helper;

          return (
            <Card key={card.key} className={`group overflow-hidden border bg-card/80 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:shadow-xl ${card.border}`}>
              <CardContent className="relative p-4">
                <div className={`absolute inset-0 bg-gradient-to-br ${card.accent}`} />
                <div className="relative flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-slate-200/80">{card.label}</div>
                    <div className={`text-2xl font-bold tracking-tight ${card.valueTone}`}>{isLoading ? "…" : value}</div>
                    <div className="text-xs text-slate-300/70">{helper}</div>
                  </div>
                  <div className={`rounded-2xl p-2 ring-1 ${card.iconTone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isLoading ? (
        <div className="relative flex min-h-[240px] items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-400/5"><Loader2 className="h-8 w-8 animate-spin text-cyan-200" /></div>
      ) : (
        <Tabs defaultValue="overview" className="relative space-y-4">
          <TabsList className="border border-white/10 bg-white/[0.04] p-1 backdrop-blur">
            <TabsTrigger value="overview" className="data-[state=active]:bg-cyan-400/20 data-[state=active]:text-cyan-50">Tổng quan</TabsTrigger>
            <TabsTrigger value="customers" className="data-[state=active]:bg-emerald-400/20 data-[state=active]:text-emerald-50">Theo customer</TabsTrigger>
            <TabsTrigger value="channels" className="data-[state=active]:bg-violet-400/20 data-[state=active]:text-violet-50">Theo kênh</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <Card className="overflow-hidden border-cyan-300/25 bg-card/85 shadow-xl shadow-cyan-950/15">
              <CardHeader className="border-b border-cyan-300/10 bg-gradient-to-r from-cyan-500/10 to-transparent">
                <CardTitle className="text-cyan-50">Doanh thu theo ngày</CardTitle>
                <CardDescription>Click bảng customer/kênh để mở chi tiết source/audit.</CardDescription>
              </CardHeader>
              <CardContent className="h-[360px] pt-6">
                <ChartContainer config={{ revenue: { label: "Revenue", color: "#22d3ee" }, review: { label: "Review", color: "#fb7185" } }} className="h-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byDay}>
                      <defs>
                        <linearGradient id="revenueGradient" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.95} />
                          <stop offset="55%" stopColor="#34d399" stopOpacity={0.85} />
                          <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.65} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.18)" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={12} tick={{ fill: "rgba(226, 232, 240, 0.72)" }} />
                      <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`} tickLine={false} axisLine={false} width={48} tick={{ fill: "rgba(226, 232, 240, 0.72)" }} />
                      <ChartTooltip content={<ChartTooltipContent formatter={(value) => vnd(Number(value))} />} />
                      <Bar dataKey="revenue" fill="url(#revenueGradient)" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="review" fill="var(--color-review)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </CardContent>
            </Card>
            <Card className="overflow-hidden border-violet-300/25 bg-card/85 shadow-xl shadow-violet-950/15">
              <CardHeader className="border-b border-violet-300/10 bg-gradient-to-r from-violet-500/10 to-transparent">
                <CardTitle className="text-violet-50">Source policy</CardTitle>
                <CardDescription>Rule production để tránh parser làm sai doanh thu.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-6 text-sm">
                {policyCards.map((item) => (
                  <div key={item.title} className={`rounded-lg border border-white/10 border-l-4 p-3 shadow-sm ${item.tone}`}>
                    <b>{item.title}</b> {item.copy}
                  </div>
                ))}
                <Button className="w-full border-rose-300/35 text-rose-100 hover:bg-rose-400/10" variant="outline" onClick={() => openSources({ review: "review_queue" })}>
                  <Eye className="mr-2 h-4 w-4" />Mở dòng cần audit
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="customers">
            <Card className="overflow-hidden border-emerald-300/25 bg-card/85 shadow-xl shadow-emerald-950/15">
              <CardHeader className="border-b border-emerald-300/10 bg-gradient-to-r from-emerald-500/10 to-transparent">
                <CardTitle className="text-emerald-50">Doanh thu theo customer / NPP</CardTitle>
                <CardDescription>Click “Chi tiết” để xem source lines, PO trace và trạng thái audit.</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <Table>
                  <TableHeader><TableRow className="border-emerald-300/15"><TableHead>Customer / NPP</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Cần review</TableHead><TableHead>Source</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {byCustomer.map((row) => (
                      <TableRow key={row.key} className="border-white/10 hover:bg-emerald-400/[0.06]">
                        <TableCell className="font-medium text-slate-100">{row.name}<div className="text-xs text-emerald-100/60">{row.rows} lines</div></TableCell>
                        <TableCell className="text-right">{numberFmt(row.qty)}</TableCell>
                        <TableCell className="text-right font-semibold text-cyan-100">{vnd(row.revenue)}</TableCell>
                        <TableCell className="text-right">{row.review > 0 ? <Badge className="border-rose-300/40 bg-rose-400/15 text-rose-100" variant="outline">{vnd(row.review)}</Badge> : "—"}</TableCell>
                        <TableCell>{Array.from(row.sourceTypes).map((s) => <Badge key={s} className="mr-1 border-cyan-300/30 bg-cyan-400/10 text-cyan-100" variant="secondary">{s}</Badge>)}</TableCell>
                        <TableCell className="text-right"><Button className="border-emerald-300/35 text-emerald-100 hover:bg-emerald-400/10" size="sm" variant="outline" onClick={() => openSources({ customer_key: row.key })}>Chi tiết</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channels">
            <Card className="overflow-hidden border-violet-300/25 bg-card/85 shadow-xl shadow-violet-950/15">
              <CardHeader className="border-b border-violet-300/10 bg-gradient-to-r from-violet-500/10 to-transparent"><CardTitle className="text-violet-50">Doanh thu theo kênh</CardTitle><CardDescription>Channel split theo trusted ledger.</CardDescription></CardHeader>
              <CardContent className="pt-4">
                <Table>
                  <TableHeader><TableRow className="border-violet-300/15"><TableHead>Kênh</TableHead><TableHead className="text-right">Rows</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {byChannel.map((row, index) => {
                      const dotClass = getChannelDotClass(index);
                      return (
                        <TableRow key={row.key} className="border-white/10 hover:bg-violet-400/[0.06]">
                          <TableCell className="font-medium text-slate-100">
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${dotClass} shadow-[0_0_16px_currentColor]`} />
                              <span>{row.label}</span>
                            </div>
                            <div className="text-xs text-violet-100/60">{row.key}</div>
                          </TableCell>
                          <TableCell className="text-right">{row.rows}</TableCell>
                          <TableCell className="text-right">{numberFmt(row.qty)}</TableCell>
                          <TableCell className="text-right font-semibold text-cyan-100">{vnd(row.revenue)}</TableCell>
                          <TableCell className="text-right"><Button className="border-violet-300/35 text-violet-100 hover:bg-violet-400/10" size="sm" variant="outline" onClick={() => openSources({ channel: row.key })}>Chi tiết</Button></TableCell>
                        </TableRow>
                      );
                    })}
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
