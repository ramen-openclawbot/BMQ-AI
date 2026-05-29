/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Info } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSkuCostBridge } from "@/hooks/useSkuCostBridge";
import { buildSkuAnalysis, compactMoney, decimalMoney, money, pct, todayMonth, type SkuAnalysis } from "@/lib/sku-cost-analysis";

const skuCostNavItems = [
  { to: "/sku-costs/dashboard", label: "Tổng quan giá vốn" },
  { to: "/sku-costs/analysis", label: "Xu hướng giá vốn" },
  { to: "/sku-costs/management", label: "Quản trị SKU" },
];

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="rounded-full bg-muted/50 px-2 py-1 text-[11px] font-bold text-muted-foreground">N/A</span>;
  const isUp = value > 0;
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span className={isUp ? "inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-[11px] font-bold text-destructive ring-1 ring-destructive/20" : "inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-1 text-[11px] font-bold text-success ring-1 ring-success/20"}>
      <Icon className="h-3 w-3" />
      {pct(value)}
    </span>
  );
}

export default function SkuCostsAnalysis() {
  const [period, setPeriod] = useState(todayMonth());
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [analysis, setAnalysis] = useState<SkuAnalysis | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const { data, isLoading } = useSkuCostBridge();

  const items = useMemo(() => data?.items || [], [data?.items]);
  const formulas = useMemo(() => data?.formulas || [], [data?.formulas]);
  const purchases = useMemo(() => data?.purchases || [], [data?.purchases]);
  const selectedSku = useMemo(() => {
    if (!items.length) return null;
    return items.find((item: any) => item.id === selectedSkuId) || items.find((item: any) => String(item.product_name || "").toLowerCase().includes("chà bông")) || items[0];
  }, [items, selectedSkuId]);

  const runAnalysis = () => {
    if (!selectedSku) return;
    setSelectedSkuId(selectedSku.id);
    setShowAllRows(false);
    setAnalysis(buildSkuAnalysis({ sku: selectedSku, formulas, purchases, period }));
  };

  const exportCurrentAnalysis = () => {
    if (!analysis) return;
    const header = ["SKU", "Tháng", "Mã NVL", "Tên NVL chuẩn", "Tên NVL công thức", "Giá CT", "Giá TT TB dùng tính", "Giá mua raw", "Định lượng", "Đơn vị", "Δ cost", "Δ %", "Nguồn", "Số dòng PR/PO", "Cảnh báo"];
    const rows = analysis.rows.map((row) => [analysis.skuLabel, analysis.period, row.materialCode || "", row.name, row.rawName, row.formulaPrice, row.actualPrice ?? "", row.rawActualPrice ?? "", row.dosage, row.unit, row.diffCost ?? "", row.diffPct ?? "", row.source, row.sampleCount, row.warning || ""]);
    const chart = [[""], ["Chart"], ["Ngày", "Giá mua thật", "Formula baseline", "% NVL có giá thật", "NVL match", "Tổng NVL"], ...analysis.chartRows.map((row) => [row.label, row.actual ?? "", row.baseline, row.coveragePct, row.matchedMaterials, row.totalMaterials])];
    const csv = [header, ...rows, ...chart].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sku-cost-review-${analysis.skuId}-${analysis.period}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const staleAnalysis = !!analysis && (analysis.skuId !== selectedSku?.id || analysis.period !== period);
  const displayRows = analysis ? (showAllRows ? analysis.rows : analysis.rows.slice(0, 3)) : [];
  const hiddenRows = analysis ? Math.max(0, analysis.rows.length - displayRows.length) : 0;
  const warningRows = analysis ? analysis.rows.filter((row) => row.warning) : [];

  return (
    <div data-stitch-sku-cost-analysis-theme="pantone-2026-light" className="-m-4 min-h-screen bg-background text-foreground md:-m-6">
      <div className="mx-auto min-h-screen w-full max-w-[430px] bg-background px-4 pb-28 pt-3 shadow-2xl md:max-w-[520px] md:px-5 lg:hidden">
        <header className="sticky top-0 z-20 -mx-4 border-b border-border/60 bg-background/92 px-4 pb-3 pt-2 backdrop-blur-xl md:-mx-5 md:px-5">
          <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-start gap-2">
            <button className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-card/80 text-foreground/80 shadow-inner" aria-label="Quay lại">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 text-center">
              <h1 className="font-sans text-[20px] font-extrabold leading-tight tracking-[-0.02em] text-foreground">Xu hướng giá vốn SKU</h1>
              <p className="mx-auto mt-1 max-w-[300px] text-[12px] font-medium leading-snug text-muted-foreground">Theo dõi cost công thức, giá mua thực tế và biến động theo từng đợt thanh toán.</p>
            </div>
            <button className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-card/80 text-primary/90 shadow-inner" aria-label="Thông tin">
              <Info className="h-5 w-5" />
            </button>
          </div>

          <nav className="mt-4 flex gap-5 overflow-x-auto border-b border-border/70 pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Điều hướng giá vốn">
            {skuCostNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? "relative shrink-0 pb-3 text-[13px] font-extrabold text-primary after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-primary"
                    : "shrink-0 pb-3 text-[13px] font-semibold text-muted-foreground transition hover:text-foreground/80"
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <main className="space-y-4 pt-4">
          <section className="rounded-[24px] border border-border/70 bg-card/70 p-4 shadow-card backdrop-blur-xl">
            <div className="space-y-3">
              <label className="block text-[11px] font-extrabold uppercase tracking-[0.18em] text-muted-foreground">SKU</label>
              <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); setShowAllRows(false); }}>
                <SelectTrigger className="h-12 rounded-[15px] border-border/70 bg-muted/45 px-3 text-left text-[14px] font-bold text-foreground shadow-inner focus:ring-primary/50 [&>svg]:hidden">
                  <SelectValue placeholder={isLoading ? "Đang tải SKU..." : "Chọn SKU"} />
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {items.map((item: any) => <SelectItem key={item.id} value={item.id}>{item.product_name} - {item.sku_code || item.id}</SelectItem>)}
                </SelectContent>
              </Select>

              <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                <div className="min-w-0 overflow-hidden rounded-[15px] border border-border/70 bg-muted/45 shadow-inner">
                  <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); setShowAllRows(false); }} aria-label="Chọn tháng phân tích" className="h-12 w-full min-w-0 border-0 bg-transparent px-3 text-[13px] font-bold text-foreground [color-scheme:light] focus-visible:ring-1 focus-visible:ring-primary/50" />
                </div>
                <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="h-12 rounded-[15px] bg-primary px-3 text-[12px] font-extrabold leading-tight text-primary-foreground shadow-card hover:bg-primary/90">
                  Chạy phân tích SKU
                </Button>
              </div>
            </div>
            <p className="mt-3 text-[12px] font-medium leading-snug text-muted-foreground">
              {items.length} SKU đã tải · {analysis ? `${analysis.matchedRows}/${analysis.totalRows} NVL có giá TT` : "Bấm chạy để lấy giá PR/duyệt chi đã quy đổi."} {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}
            </p>
          </section>

          {!analysis ? (
            <section className="rounded-[24px] border border-dashed border-border/70 bg-muted/35 px-4 py-8 text-center text-[13px] font-medium text-muted-foreground">
              Chọn SKU/tháng rồi bấm “Chạy phân tích SKU” để tạo mapping giá vốn và trend theo đợt thanh toán.
            </section>
          ) : (
            <>
              <section className="grid grid-cols-2 gap-3">
                {[
                  { label: "Cost công thức", value: money(Math.round(analysis.formulaCost)), suffix: "đ/ổ" },
                  { label: "Cost thực tế TB tháng", value: money(Math.round(analysis.actualCost)), suffix: "đ/ổ" },
                  { label: "Chênh lệch", value: `${analysis.diff > 0 ? "+" : ""}${money(Math.round(analysis.diff))}`, suffix: "đ/ổ", percent: pct(analysis.diffPct), isDiff: true },
                  { label: "Lần chạy gần nhất", value: new Date(analysis.runAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }), suffix: new Date(analysis.runAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) },
                ].map((item) => (
                  <article key={item.label} className="min-h-[104px] rounded-[22px] border border-border/70 bg-card/80 p-3.5 shadow-card">
                    <p className="text-[11px] font-bold leading-tight text-muted-foreground">{item.label}</p>
                    <div className="mt-3 flex flex-wrap items-end gap-x-1 gap-y-1">
                      <span className={item.isDiff && analysis.diff > 0 ? "text-[24px] font-black leading-none tracking-[-0.04em] text-destructive" : item.isDiff ? "text-[24px] font-black leading-none tracking-[-0.04em] text-success" : "text-[24px] font-black leading-none tracking-[-0.04em] text-foreground"}>{item.value}</span>
                      <span className="pb-0.5 text-[12px] font-bold text-muted-foreground">{item.suffix}</span>
                    </div>
                    {item.percent && <div className={analysis.diff > 0 ? "mt-2 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-[11px] font-extrabold text-destructive ring-1 ring-destructive/20" : "mt-2 inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-1 text-[11px] font-extrabold text-success ring-1 ring-success/20"}>{analysis.diff > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{item.percent}</div>}
                  </article>
                ))}
              </section>

              {warningRows.length > 0 ? (
                <section className="rounded-[22px] border border-primary/25 bg-primary/[0.08] p-3.5 text-primary shadow-card">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div>
                      <p className="text-[13px] font-black">Có {warningRows.length} NVL cần kiểm tra mapping/quy đổi</p>
                      <p className="mt-1 text-[11px] font-semibold leading-snug text-primary/75">Giá mua lệch ≥100% so với giá công thức nên app đã giữ giá công thức cho trend, không dùng số bất thường.</p>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="overflow-hidden rounded-[24px] border border-border/70 bg-card/80 shadow-card">
                <div className="border-b border-border/70 px-4 py-4">
                  <h2 className="text-[17px] font-black tracking-[-0.02em] text-foreground">Mapping công thức ↔ chi phí thực tế</h2>
                </div>
                <div className="px-4 py-3">
                  <div className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] gap-2 border-b border-border/50 pb-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                    <span>NVL</span><span className="text-right">Giá CT</span><span className="text-right">Giá TT TB</span><span className="text-right">Δ</span>
                  </div>
                  <div className="divide-y divide-border/50">
                    {displayRows.map((row) => (
                      <div key={`${row.rawName}-${row.dosage}`} className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] items-center gap-2 py-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-extrabold leading-tight text-foreground">{row.name}</div>
                      <div className="mt-0.5 truncate text-[10px] font-semibold text-muted-foreground">{row.materialCode ? `${row.materialCode} · ` : ""}{decimalMoney(row.dosage, 2)} {row.unit} · {row.source}</div>
                          {row.warning ? <div className="mt-1 flex items-start gap-1 rounded-lg bg-primary/[0.08] px-2 py-1 text-[10px] font-bold leading-snug text-primary"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{row.warning}</div> : null}
                        </div>
                        <div className="text-right text-[13px] font-bold tabular-nums text-foreground/70">{decimalMoney(row.formulaPrice)}</div>
                        <div className="text-right text-[13px] font-bold tabular-nums text-foreground">{decimalMoney(row.actualPrice)}</div>
                        <div className="flex justify-end"><DeltaBadge value={row.diffPct} /></div>
                      </div>
                    ))}
                  </div>
                  {hiddenRows > 0 ? (
                    <button onClick={() => setShowAllRows(true)} className="mt-1 flex w-full items-center justify-center rounded-2xl border border-dashed border-primary/20 bg-primary/10 px-3 py-3 text-[13px] font-extrabold text-primary">
                      Xem thêm nguyên liệu ({hiddenRows})
                    </button>
                  ) : analysis.rows.length > 3 ? (
                    <button onClick={() => setShowAllRows(false)} className="mt-1 flex w-full items-center justify-center rounded-2xl border border-dashed border-primary/20 bg-primary/10 px-3 py-3 text-[13px] font-extrabold text-primary">Thu gọn nguyên liệu</button>
                  ) : null}
                </div>
              </section>

              <section className="overflow-hidden rounded-[24px] border border-border/70 bg-card/80 p-4 shadow-card">
                <div className="mb-3">
                  <h2 className="text-[17px] font-black tracking-[-0.02em] text-foreground">Biến động theo đợt thanh toán trong tháng</h2>
                  <div className="mt-3 flex flex-wrap gap-3 text-[11px] font-bold text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />Giá mua thật</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 border-t border-dashed border-muted-foreground/50" />Formula baseline</span>
                  </div>
                </div>
                <div className="relative h-[238px] rounded-[18px] border border-border/60 bg-muted/30 px-1 py-3">
                  {analysis.chartRows.length === 0 ? (
                    <div className="absolute inset-0 z-10 flex items-center justify-center px-5 text-center text-[12px] font-semibold leading-relaxed text-muted-foreground">
                      Chưa có PR/PO đã duyệt trong tháng khớp mã NVL của SKU này, nên không vẽ điểm giá mua thật.
                    </div>
                  ) : null}
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analysis.chartRows} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 700 }} dy={8} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickFormatter={(value) => money(Number(value))} width={54} />
                      <Tooltip cursor={{ stroke: "hsl(var(--primary) / 0.28)", strokeWidth: 1 }} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 14, color: "hsl(var(--foreground))" }} formatter={(value: number | null, name: string, item: any) => [value === null ? "Chưa có giá mua thật" : `${money(Math.round(Number(value)))} đ/ổ`, name === "actual" ? `Giá mua thật (${Math.round(item?.payload?.coveragePct || 0)}% NVL)` : "Formula baseline"]} labelFormatter={(label) => `Đợt ${label}`} />
                      <Line type="monotone" dataKey="baseline" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="5 6" dot={false} />
                      <Line type="monotone" dataKey="actual" stroke="hsl(var(--primary))" strokeWidth={4} connectNulls={false} dot={{ r: 4, fill: "hsl(var(--primary))", stroke: "hsl(var(--primary-foreground))", strokeWidth: 2 }} activeDot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--primary-foreground))", strokeWidth: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-3 text-[11px] font-medium leading-snug text-muted-foreground">Chart dùng PR đã thanh toán trong tháng theo paid_at; NVL không mua trong tháng sẽ giữ giá công thức. Nếu giá mua lệch ≥100%, app cảnh báo và không dùng số bất thường để tính trend.</p>
              </section>
            </>
          )}
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[430px] border-t border-border/70 bg-background/92 px-4 py-3 shadow-card backdrop-blur-xl md:max-w-[520px] lg:hidden">
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={exportCurrentAnalysis} disabled={!analysis} variant="outline" className="h-12 rounded-[16px] border-border/70 bg-muted/40 text-[13px] font-extrabold text-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-45">
              Xuất sheet review
            </Button>
            <Button variant="outline" disabled className="h-12 rounded-[16px] border-primary/35 bg-transparent text-[13px] font-extrabold text-primary opacity-55 disabled:opacity-55">
              Cập nhật mapping
            </Button>
          </div>
        </div>
      </div>

      <div className="hidden min-h-screen bg-background px-8 py-8 lg:block">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <header className="rounded-[32px] border border-border/70 bg-card/70 p-6 shadow-card backdrop-blur-xl">
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-primary/70">SKU Costs Analysis</p>
                <h1 className="mt-1 text-[34px] font-black leading-tight tracking-[-0.04em] text-foreground">Xu hướng giá vốn SKU</h1>
                <p className="mt-2 max-w-3xl text-sm font-semibold text-muted-foreground">So sánh cost công thức với giá mua thực tế đã quy đổi, theo từng SKU và từng tháng.</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Button onClick={exportCurrentAnalysis} disabled={!analysis} variant="outline" className="h-11 rounded-2xl border-border/70 bg-muted/40 px-5 text-sm font-extrabold text-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-45">Xuất sheet review</Button>
                <Button variant="outline" disabled className="h-11 rounded-2xl border-primary/35 bg-transparent px-5 text-sm font-extrabold text-primary opacity-55 disabled:opacity-55">Cập nhật mapping</Button>
              </div>
            </div>

            <nav className="mt-6 flex flex-wrap gap-2" aria-label="Điều hướng giá vốn desktop">
              {skuCostNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive
                      ? "inline-flex items-center rounded-2xl bg-primary px-4 py-2.5 text-sm font-extrabold text-primary-foreground shadow-card"
                      : "inline-flex items-center rounded-2xl border border-border/70 bg-muted/45 px-4 py-2.5 text-sm font-extrabold text-muted-foreground transition hover:text-foreground"
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </header>

          <section className="rounded-[30px] border border-border/70 bg-card/80 p-5 shadow-card">
            <div className="grid grid-cols-[minmax(0,1.4fr)_190px_190px] items-end gap-4">
              <div className="min-w-0">
                <label className="mb-2 block text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">SKU</label>
                <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); setShowAllRows(false); }}>
                  <SelectTrigger className="h-12 rounded-2xl border-border/70 bg-muted/45 px-4 text-left text-sm font-bold text-foreground shadow-inner focus:ring-primary/50 [&>svg]:hidden">
                    <SelectValue placeholder={isLoading ? "Đang tải SKU..." : "Chọn SKU"} />
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {items.map((item: any) => <SelectItem key={item.id} value={item.id}>{item.product_name} - {item.sku_code || item.id}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-2 block text-xs font-extrabold uppercase tracking-[0.18em] text-muted-foreground">Tháng</label>
                <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/45 shadow-inner">
                  <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); setShowAllRows(false); }} aria-label="Chọn tháng phân tích desktop" className="h-12 w-full min-w-0 border-0 bg-transparent px-4 text-sm font-bold text-foreground [color-scheme:light] focus-visible:ring-1 focus-visible:ring-primary/50" />
                </div>
              </div>
              <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="h-12 rounded-2xl bg-primary px-5 text-sm font-extrabold text-primary-foreground shadow-card hover:bg-primary/90">Chạy phân tích SKU</Button>
            </div>
            <p className="mt-4 text-sm font-semibold text-muted-foreground">
              {items.length} SKU đã tải · {analysis ? `${analysis.matchedRows}/${analysis.totalRows} NVL có giá TT` : "Bấm chạy để lấy giá PR/duyệt chi đã quy đổi."} {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}
            </p>
          </section>

          {!analysis ? (
            <section className="rounded-[30px] border border-dashed border-border/70 bg-muted/35 px-6 py-16 text-center shadow-card">
              <h2 className="text-2xl font-black tracking-[-0.03em] text-foreground">Chưa có phân tích</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm font-semibold leading-relaxed text-muted-foreground">Chọn SKU và tháng, sau đó bấm “Chạy phân tích SKU” để tạo bảng mapping giá vốn và chart biến động theo đợt thanh toán.</p>
            </section>
          ) : (
            <>
              <section className="grid grid-cols-4 gap-4">
                {[
                  { label: "Cost công thức", value: money(Math.round(analysis.formulaCost)), suffix: "đ/ổ" },
                  { label: "Cost thực tế TB tháng", value: money(Math.round(analysis.actualCost)), suffix: "đ/ổ" },
                  { label: "Chênh lệch", value: `${analysis.diff > 0 ? "+" : ""}${money(Math.round(analysis.diff))}`, suffix: "đ/ổ", percent: pct(analysis.diffPct), isDiff: true },
                  { label: "Lần chạy gần nhất", value: new Date(analysis.runAt).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }), suffix: new Date(analysis.runAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) },
                ].map((item) => (
                  <article key={item.label} className="rounded-[28px] border border-border/70 bg-card/80 p-5 shadow-card">
                    <p className="text-xs font-extrabold uppercase tracking-[0.13em] text-muted-foreground">{item.label}</p>
                    <div className="mt-4 flex flex-wrap items-end gap-x-1 gap-y-1">
                      <span className={item.isDiff && analysis.diff > 0 ? "text-[30px] font-black leading-none tracking-[-0.04em] text-destructive" : item.isDiff ? "text-[30px] font-black leading-none tracking-[-0.04em] text-success" : "text-[30px] font-black leading-none tracking-[-0.04em] text-foreground"}>{item.value}</span>
                      <span className="pb-1 text-sm font-bold text-muted-foreground">{item.suffix}</span>
                    </div>
                    {item.percent && <div className={analysis.diff > 0 ? "mt-3 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-extrabold text-destructive ring-1 ring-destructive/20" : "mt-3 inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-extrabold text-success ring-1 ring-success/20"}>{analysis.diff > 0 ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}{item.percent}</div>}
                  </article>
                ))}
              </section>

              {warningRows.length > 0 ? (
                <section className="rounded-[28px] border border-primary/25 bg-primary/[0.08] p-4 text-primary shadow-card">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <div>
                      <p className="text-sm font-black">Có {warningRows.length} NVL cần kiểm tra mapping/quy đổi</p>
                      <p className="mt-1 text-xs font-semibold leading-relaxed text-primary/75">Giá mua TB lệch ≥100% so với giá công thức. App đã tự động giữ giá công thức cho các dòng này để trend không bị méo, đồng thời hiển thị cảnh báo ở bảng chi tiết.</p>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] gap-5">
                <article className="overflow-hidden rounded-[32px] border border-border/70 bg-card/80 shadow-card">
                  <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-5">
                    <div>
                      <h2 className="text-xl font-black tracking-[-0.03em] text-foreground">Mapping công thức ↔ chi phí thực tế</h2>
                      <p className="mt-1 text-sm font-semibold text-muted-foreground">{analysis.skuLabel}</p>
                    </div>
                    <span className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary ring-1 ring-primary/20">{analysis.matchedRows}/{analysis.totalRows} NVL</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] border-collapse text-left">
                      <thead className="bg-muted/45 text-xs font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3">Mã NVL</th>
                          <th className="px-4 py-3">NVL chuẩn</th>
                          <th className="px-4 py-3">NVL công thức</th>
                          <th className="px-4 py-3 text-right">Giá CT</th>
                          <th className="px-4 py-3 text-right">Giá TT TB</th>
                          <th className="px-4 py-3 text-right">Định lượng</th>
                          <th className="px-4 py-3 text-right">Δ cost</th>
                          <th className="px-4 py-3 text-right">Δ %</th>
                          <th className="px-4 py-3">Nguồn</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {analysis.rows.map((row) => (
                          <tr key={`${row.materialCode || row.rawName}-${row.dosage}`} className="bg-card/60 transition hover:bg-muted/45">
                            <td className="max-w-[170px] px-4 py-3 text-xs font-black text-primary/80"><div className="truncate">{row.materialCode || "—"}</div></td>
                            <td className="max-w-[220px] px-4 py-3 text-sm font-black text-foreground"><div className="truncate">{row.name}</div></td>
                            <td className="max-w-[220px] px-4 py-3 text-xs font-semibold text-muted-foreground"><div className="truncate">{row.rawName}</div></td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-foreground/70">{decimalMoney(row.formulaPrice)}</td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-foreground">{decimalMoney(row.actualPrice)}</td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-muted-foreground">{decimalMoney(row.dosage, 2)} {row.unit}</td>
                            <td className={row.diffCost !== null && row.diffCost > 0 ? "px-4 py-3 text-right text-sm font-black tabular-nums text-destructive" : "px-4 py-3 text-right text-sm font-black tabular-nums text-success"}>{row.diffCost === null ? "—" : compactMoney(row.diffCost)}</td>
                            <td className="px-4 py-3"><div className="flex justify-end"><DeltaBadge value={row.diffPct} /></div></td>
                            <td className="px-4 py-3 text-xs font-bold text-muted-foreground">
                              <div>{row.source} · {row.sampleCount}</div>
                              {row.warning ? <div className="mt-1 flex max-w-[280px] items-start gap-1 rounded-lg bg-primary/[0.08] px-2 py-1 text-[11px] leading-snug text-primary"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{row.warning}</div> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>

                <article className="overflow-hidden rounded-[32px] border border-border/70 bg-card/80 p-5 shadow-card">
                  <div className="mb-4">
                    <h2 className="text-xl font-black tracking-[-0.03em] text-foreground">Biến động trong tháng</h2>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs font-bold text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-primary" />Giá mua thật</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-px w-6 border-t border-dashed border-muted-foreground/50" />Formula baseline</span>
                    </div>
                  </div>
                  <div className="relative h-[390px] rounded-[24px] border border-border/60 bg-muted/30 px-3 py-4">
                    {analysis.chartRows.length === 0 ? (
                      <div className="absolute inset-0 z-10 flex items-center justify-center px-8 text-center text-sm font-semibold leading-relaxed text-muted-foreground">
                        Chưa có PR/PO đã duyệt trong tháng khớp mã NVL của SKU này, nên không vẽ điểm giá mua thật.
                      </div>
                    ) : null}
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={analysis.chartRows} margin={{ top: 12, right: 18, left: -8, bottom: 8 }}>
                        <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12, fontWeight: 700 }} dy={10} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(value) => money(Number(value))} width={64} />
                        <Tooltip cursor={{ stroke: "hsl(var(--primary) / 0.28)", strokeWidth: 1 }} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 14, color: "hsl(var(--foreground))" }} formatter={(value: number | null, name: string, item: any) => [value === null ? "Chưa có giá mua thật" : `${money(Math.round(Number(value)))} đ/ổ`, name === "actual" ? `Giá mua thật (${Math.round(item?.payload?.coveragePct || 0)}% NVL)` : "Formula baseline"]} labelFormatter={(label) => `Đợt ${label}`} />
                        <Line type="monotone" dataKey="baseline" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="5 6" dot={false} />
                        <Line type="monotone" dataKey="actual" stroke="hsl(var(--primary))" strokeWidth={4} connectNulls={false} dot={{ r: 4, fill: "hsl(var(--primary))", stroke: "hsl(var(--primary-foreground))", strokeWidth: 2 }} activeDot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--primary-foreground))", strokeWidth: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-4 text-xs font-semibold leading-relaxed text-muted-foreground">Chart dùng PR đã thanh toán trong tháng theo paid_at; NVL không mua trong tháng sẽ giữ giá công thức. Nếu giá mua lệch ≥100%, app cảnh báo và không dùng số bất thường để tính trend.</p>
                </article>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
