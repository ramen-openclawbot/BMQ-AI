/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Info } from "lucide-react";
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
  if (value === null) return <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[11px] font-bold text-white/45">N/A</span>;
  const isUp = value > 0;
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span className={isUp ? "inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-1 text-[11px] font-bold text-rose-300 ring-1 ring-rose-400/20" : "inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/20"}>
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
    const header = ["SKU", "Tháng", "Mã NVL", "Tên NVL chuẩn", "Tên NVL công thức", "Giá CT", "Giá TT TB", "Định lượng", "Đơn vị", "Δ cost", "Δ %", "Nguồn", "Số dòng PR/PO"];
    const rows = analysis.rows.map((row) => [analysis.skuLabel, analysis.period, row.materialCode || "", row.name, row.rawName, row.formulaPrice, row.actualPrice ?? "", row.dosage, row.unit, row.diffCost ?? "", row.diffPct ?? "", row.source, row.sampleCount]);
    const chart = [[""], ["Chart"], ["Ngày", "Actual paid avg", "Formula baseline"], ...analysis.chartRows.map((row) => [row.label, row.actual, row.baseline])];
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

  return (
    <div className="-m-4 min-h-screen bg-[#0b0908] text-white md:-m-6">
      <div className="mx-auto min-h-screen w-full max-w-[430px] bg-[radial-gradient(circle_at_50%_-10%,rgba(245,158,11,0.24),transparent_34%),linear-gradient(180deg,#17100c_0%,#0b0908_42%,#080706_100%)] px-4 pb-28 pt-3 shadow-2xl md:max-w-[520px] md:px-5 lg:hidden">
        <header className="sticky top-0 z-20 -mx-4 bg-gradient-to-b from-[#17100c]/98 via-[#17100c]/90 to-[#17100c]/70 px-4 pb-3 pt-2 backdrop-blur-xl md:-mx-5 md:px-5">
          <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-start gap-2">
            <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/80 shadow-inner" aria-label="Quay lại">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 text-center">
              <h1 className="font-sans text-[20px] font-extrabold leading-tight tracking-[-0.02em] text-white">Xu hướng giá vốn SKU</h1>
              <p className="mx-auto mt-1 max-w-[300px] text-[12px] font-medium leading-snug text-white/48">Theo dõi cost công thức, giá mua thực tế và biến động theo từng đợt thanh toán.</p>
            </div>
            <button className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-amber-200/90 shadow-inner" aria-label="Thông tin">
              <Info className="h-5 w-5" />
            </button>
          </div>

          <nav className="mt-4 flex gap-5 overflow-x-auto border-b border-white/10 pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Điều hướng giá vốn">
            {skuCostNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? "relative shrink-0 pb-3 text-[13px] font-extrabold text-amber-300 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-amber-400"
                    : "shrink-0 pb-3 text-[13px] font-semibold text-white/45 transition hover:text-white/80"
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <main className="space-y-4 pt-4">
          <section className="rounded-[24px] border border-white/10 bg-white/[0.055] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-xl">
            <div className="space-y-3">
              <label className="block text-[11px] font-extrabold uppercase tracking-[0.18em] text-white/40">SKU</label>
              <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); setShowAllRows(false); }}>
                <SelectTrigger className="h-12 rounded-[15px] border-white/10 bg-[#211915] px-3 text-left text-[14px] font-bold text-white shadow-inner focus:ring-amber-300/60 [&>svg]:hidden">
                  <SelectValue placeholder={isLoading ? "Đang tải SKU..." : "Chọn SKU"} />
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-white/40" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {items.map((item: any) => <SelectItem key={item.id} value={item.id}>{item.product_name} - {item.sku_code || item.id}</SelectItem>)}
                </SelectContent>
              </Select>

              <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                <div className="min-w-0 overflow-hidden rounded-[15px] border border-white/10 bg-[#211915] shadow-inner">
                  <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); setShowAllRows(false); }} aria-label="Chọn tháng phân tích" className="h-12 w-full min-w-0 border-0 bg-transparent px-3 text-[13px] font-bold text-white [color-scheme:dark] focus-visible:ring-1 focus-visible:ring-amber-300" />
                </div>
                <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="h-12 rounded-[15px] bg-[#f59e0b] px-3 text-[12px] font-extrabold leading-tight text-[#1b1004] shadow-[0_14px_28px_rgba(245,158,11,0.25)] hover:bg-amber-300">
                  Chạy phân tích SKU
                </Button>
              </div>
            </div>
            <p className="mt-3 text-[12px] font-medium leading-snug text-white/42">
              {items.length} SKU đã tải · {analysis ? `${analysis.matchedRows}/${analysis.totalRows} NVL có giá TT` : "Bấm chạy để lấy giá PR/duyệt chi đã quy đổi."} {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}
            </p>
          </section>

          {!analysis ? (
            <section className="rounded-[24px] border border-dashed border-white/12 bg-white/[0.035] px-4 py-8 text-center text-[13px] font-medium text-white/45">
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
                  <article key={item.label} className="min-h-[104px] rounded-[22px] border border-white/10 bg-[#14100d]/90 p-3.5 shadow-[0_14px_42px_rgba(0,0,0,0.28)]">
                    <p className="text-[11px] font-bold leading-tight text-white/45">{item.label}</p>
                    <div className="mt-3 flex flex-wrap items-end gap-x-1 gap-y-1">
                      <span className={item.isDiff && analysis.diff > 0 ? "text-[24px] font-black leading-none tracking-[-0.04em] text-rose-300" : item.isDiff ? "text-[24px] font-black leading-none tracking-[-0.04em] text-emerald-300" : "text-[24px] font-black leading-none tracking-[-0.04em] text-white"}>{item.value}</span>
                      <span className="pb-0.5 text-[12px] font-bold text-white/45">{item.suffix}</span>
                    </div>
                    {item.percent && <div className={analysis.diff > 0 ? "mt-2 inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-1 text-[11px] font-extrabold text-rose-300 ring-1 ring-rose-400/20" : "mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-1 text-[11px] font-extrabold text-emerald-300 ring-1 ring-emerald-400/20"}>{analysis.diff > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{item.percent}</div>}
                  </article>
                ))}
              </section>

              <section className="overflow-hidden rounded-[24px] border border-white/10 bg-[#14100d]/95 shadow-[0_18px_60px_rgba(0,0,0,0.34)]">
                <div className="border-b border-white/10 px-4 py-4">
                  <h2 className="text-[17px] font-black tracking-[-0.02em] text-white">Mapping công thức ↔ chi phí thực tế</h2>
                </div>
                <div className="px-4 py-3">
                  <div className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] gap-2 border-b border-white/8 pb-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-white/35">
                    <span>NVL</span><span className="text-right">Giá CT</span><span className="text-right">Giá TT TB</span><span className="text-right">Δ</span>
                  </div>
                  <div className="divide-y divide-white/[0.07]">
                    {displayRows.map((row) => (
                      <div key={`${row.rawName}-${row.dosage}`} className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] items-center gap-2 py-3">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-extrabold leading-tight text-white">{row.name}</div>
                          <div className="mt-0.5 truncate text-[10px] font-semibold text-white/35">{row.materialCode ? `${row.materialCode} · ` : ""}{decimalMoney(row.dosage, 2)} {row.unit} · {row.source}</div>
                        </div>
                        <div className="text-right text-[13px] font-bold tabular-nums text-white/70">{decimalMoney(row.formulaPrice)}</div>
                        <div className="text-right text-[13px] font-bold tabular-nums text-white">{decimalMoney(row.actualPrice)}</div>
                        <div className="flex justify-end"><DeltaBadge value={row.diffPct} /></div>
                      </div>
                    ))}
                  </div>
                  {hiddenRows > 0 ? (
                    <button onClick={() => setShowAllRows(true)} className="mt-1 flex w-full items-center justify-center rounded-2xl border border-dashed border-amber-300/20 bg-amber-300/[0.04] px-3 py-3 text-[13px] font-extrabold text-amber-300">
                      Xem thêm nguyên liệu ({hiddenRows})
                    </button>
                  ) : analysis.rows.length > 3 ? (
                    <button onClick={() => setShowAllRows(false)} className="mt-1 flex w-full items-center justify-center rounded-2xl border border-dashed border-amber-300/20 bg-amber-300/[0.04] px-3 py-3 text-[13px] font-extrabold text-amber-300">Thu gọn nguyên liệu</button>
                  ) : null}
                </div>
              </section>

              <section className="overflow-hidden rounded-[24px] border border-white/10 bg-[#14100d]/95 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.34)]">
                <div className="mb-3">
                  <h2 className="text-[17px] font-black tracking-[-0.02em] text-white">Biến động theo đợt thanh toán trong tháng</h2>
                  <div className="mt-3 flex flex-wrap gap-3 text-[11px] font-bold text-white/50">
                    <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" />Actual paid avg</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 border-t border-dashed border-slate-400" />Formula baseline</span>
                  </div>
                </div>
                <div className="h-[238px] rounded-[18px] border border-white/[0.06] bg-[#0e0b09] px-1 py-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analysis.chartRows} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                      <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.42)", fontSize: 11, fontWeight: 700 }} dy={8} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.32)", fontSize: 10 }} tickFormatter={(value) => money(Number(value))} width={54} />
                      <Tooltip cursor={{ stroke: "rgba(245,158,11,0.28)", strokeWidth: 1 }} contentStyle={{ background: "#1b1410", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, color: "#fff" }} formatter={(value: number, name: string) => [`${money(Math.round(Number(value)))} đ/ổ`, name === "actual" ? "Actual paid avg" : "Formula baseline"]} labelFormatter={(label) => `Đợt ${label}`} />
                      <Line type="monotone" dataKey="baseline" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 6" dot={false} />
                      <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={4} dot={{ r: 4, fill: "#f59e0b", stroke: "#1b1004", strokeWidth: 2 }} activeDot={{ r: 6, fill: "#fbbf24", stroke: "#1b1004", strokeWidth: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-3 text-[11px] font-medium leading-snug text-white/38">Chart tính tổng cost NVL theo giá PR/duyệt chi đã quy đổi tại từng ngày phát sinh mua hàng trong tháng; baseline là cost công thức ban đầu.</p>
              </section>
            </>
          )}
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[430px] border-t border-white/10 bg-[#0b0908]/92 px-4 py-3 shadow-[0_-18px_50px_rgba(0,0,0,0.42)] backdrop-blur-xl md:max-w-[520px] lg:hidden">
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={exportCurrentAnalysis} disabled={!analysis} variant="outline" className="h-12 rounded-[16px] border-white/12 bg-white/[0.04] text-[13px] font-extrabold text-white hover:bg-white/[0.08] hover:text-white disabled:opacity-45">
              Xuất sheet review
            </Button>
            <Button variant="outline" disabled className="h-12 rounded-[16px] border-amber-300/35 bg-transparent text-[13px] font-extrabold text-amber-300 opacity-55 disabled:opacity-55">
              Cập nhật mapping
            </Button>
          </div>
        </div>
      </div>

      <div className="hidden min-h-screen bg-[radial-gradient(circle_at_18%_-12%,rgba(245,158,11,0.18),transparent_34%),linear-gradient(180deg,#140f0c_0%,#0b0908_42%,#070605_100%)] px-8 py-8 lg:block">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <header className="rounded-[32px] border border-white/10 bg-white/[0.055] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-amber-200/70">SKU Costs Analysis</p>
                <h1 className="mt-1 text-[34px] font-black leading-tight tracking-[-0.04em] text-white">Xu hướng giá vốn SKU</h1>
                <p className="mt-2 max-w-3xl text-sm font-semibold text-white/45">So sánh cost công thức với giá mua thực tế đã quy đổi, theo từng SKU và từng tháng.</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Button onClick={exportCurrentAnalysis} disabled={!analysis} variant="outline" className="h-11 rounded-2xl border-white/12 bg-white/[0.04] px-5 text-sm font-extrabold text-white hover:bg-white/[0.08] hover:text-white disabled:opacity-45">Xuất sheet review</Button>
                <Button variant="outline" disabled className="h-11 rounded-2xl border-amber-300/35 bg-transparent px-5 text-sm font-extrabold text-amber-300 opacity-55 disabled:opacity-55">Cập nhật mapping</Button>
              </div>
            </div>

            <nav className="mt-6 flex flex-wrap gap-2" aria-label="Điều hướng giá vốn desktop">
              {skuCostNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive
                      ? "inline-flex items-center rounded-2xl bg-amber-400 px-4 py-2.5 text-sm font-extrabold text-[#1b1004] shadow-[0_10px_24px_rgba(245,158,11,0.22)]"
                      : "inline-flex items-center rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-2.5 text-sm font-extrabold text-white/50 transition hover:text-white"
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </header>

          <section className="rounded-[30px] border border-white/10 bg-[#14100d]/92 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.3)]">
            <div className="grid grid-cols-[minmax(0,1.4fr)_190px_190px] items-end gap-4">
              <div className="min-w-0">
                <label className="mb-2 block text-xs font-extrabold uppercase tracking-[0.18em] text-white/40">SKU</label>
                <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); setShowAllRows(false); }}>
                  <SelectTrigger className="h-12 rounded-2xl border-white/10 bg-[#211915] px-4 text-left text-sm font-bold text-white shadow-inner focus:ring-amber-300/60 [&>svg]:hidden">
                    <SelectValue placeholder={isLoading ? "Đang tải SKU..." : "Chọn SKU"} />
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-white/40" />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {items.map((item: any) => <SelectItem key={item.id} value={item.id}>{item.product_name} - {item.sku_code || item.id}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-2 block text-xs font-extrabold uppercase tracking-[0.18em] text-white/40">Tháng</label>
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#211915] shadow-inner">
                  <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); setShowAllRows(false); }} aria-label="Chọn tháng phân tích desktop" className="h-12 w-full min-w-0 border-0 bg-transparent px-4 text-sm font-bold text-white [color-scheme:dark] focus-visible:ring-1 focus-visible:ring-amber-300" />
                </div>
              </div>
              <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="h-12 rounded-2xl bg-[#f59e0b] px-5 text-sm font-extrabold text-[#1b1004] shadow-[0_14px_28px_rgba(245,158,11,0.25)] hover:bg-amber-300">Chạy phân tích SKU</Button>
            </div>
            <p className="mt-4 text-sm font-semibold text-white/42">
              {items.length} SKU đã tải · {analysis ? `${analysis.matchedRows}/${analysis.totalRows} NVL có giá TT` : "Bấm chạy để lấy giá PR/duyệt chi đã quy đổi."} {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}
            </p>
          </section>

          {!analysis ? (
            <section className="rounded-[30px] border border-dashed border-white/12 bg-white/[0.035] px-6 py-16 text-center shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
              <h2 className="text-2xl font-black tracking-[-0.03em] text-white">Chưa có phân tích</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm font-semibold leading-relaxed text-white/45">Chọn SKU và tháng, sau đó bấm “Chạy phân tích SKU” để tạo bảng mapping giá vốn và chart biến động theo đợt thanh toán.</p>
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
                  <article key={item.label} className="rounded-[28px] border border-white/10 bg-[#14100d]/90 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
                    <p className="text-xs font-extrabold uppercase tracking-[0.13em] text-white/35">{item.label}</p>
                    <div className="mt-4 flex flex-wrap items-end gap-x-1 gap-y-1">
                      <span className={item.isDiff && analysis.diff > 0 ? "text-[30px] font-black leading-none tracking-[-0.04em] text-rose-300" : item.isDiff ? "text-[30px] font-black leading-none tracking-[-0.04em] text-emerald-300" : "text-[30px] font-black leading-none tracking-[-0.04em] text-white"}>{item.value}</span>
                      <span className="pb-1 text-sm font-bold text-white/45">{item.suffix}</span>
                    </div>
                    {item.percent && <div className={analysis.diff > 0 ? "mt-3 inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2.5 py-1 text-xs font-extrabold text-rose-300 ring-1 ring-rose-400/20" : "mt-3 inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-extrabold text-emerald-300 ring-1 ring-emerald-400/20"}>{analysis.diff > 0 ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}{item.percent}</div>}
                  </article>
                ))}
              </section>

              <section className="grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] gap-5">
                <article className="overflow-hidden rounded-[32px] border border-white/10 bg-[#14100d]/94 shadow-[0_24px_80px_rgba(0,0,0,0.34)]">
                  <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-5">
                    <div>
                      <h2 className="text-xl font-black tracking-[-0.03em] text-white">Mapping công thức ↔ chi phí thực tế</h2>
                      <p className="mt-1 text-sm font-semibold text-white/38">{analysis.skuLabel}</p>
                    </div>
                    <span className="rounded-full bg-amber-300/10 px-3 py-1.5 text-xs font-extrabold text-amber-200 ring-1 ring-amber-300/20">{analysis.matchedRows}/{analysis.totalRows} NVL</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] border-collapse text-left">
                      <thead className="bg-white/[0.045] text-xs font-extrabold uppercase tracking-[0.12em] text-white/38">
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
                      <tbody className="divide-y divide-white/8">
                        {analysis.rows.map((row) => (
                          <tr key={`${row.materialCode || row.rawName}-${row.dosage}`} className="bg-[#120e0b]/72 transition hover:bg-white/[0.045]">
                            <td className="max-w-[170px] px-4 py-3 text-xs font-black text-amber-200/80"><div className="truncate">{row.materialCode || "—"}</div></td>
                            <td className="max-w-[220px] px-4 py-3 text-sm font-black text-white"><div className="truncate">{row.name}</div></td>
                            <td className="max-w-[220px] px-4 py-3 text-xs font-semibold text-white/40"><div className="truncate">{row.rawName}</div></td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-white/70">{decimalMoney(row.formulaPrice)}</td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-white">{decimalMoney(row.actualPrice)}</td>
                            <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-white/60">{decimalMoney(row.dosage, 2)} {row.unit}</td>
                            <td className={row.diffCost !== null && row.diffCost > 0 ? "px-4 py-3 text-right text-sm font-black tabular-nums text-rose-300" : "px-4 py-3 text-right text-sm font-black tabular-nums text-emerald-300"}>{row.diffCost === null ? "—" : compactMoney(row.diffCost)}</td>
                            <td className="px-4 py-3"><div className="flex justify-end"><DeltaBadge value={row.diffPct} /></div></td>
                            <td className="px-4 py-3 text-xs font-bold text-white/45">{row.source} · {row.sampleCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>

                <article className="overflow-hidden rounded-[32px] border border-white/10 bg-[#14100d]/94 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.34)]">
                  <div className="mb-4">
                    <h2 className="text-xl font-black tracking-[-0.03em] text-white">Biến động trong tháng</h2>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs font-bold text-white/50">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" />Actual paid avg</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-px w-6 border-t border-dashed border-slate-400" />Formula baseline</span>
                    </div>
                  </div>
                  <div className="h-[390px] rounded-[24px] border border-white/[0.06] bg-[#0e0b09] px-3 py-4">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={analysis.chartRows} margin={{ top: 12, right: 18, left: -8, bottom: 8 }}>
                        <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.42)", fontSize: 12, fontWeight: 700 }} dy={10} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.32)", fontSize: 11 }} tickFormatter={(value) => money(Number(value))} width={64} />
                        <Tooltip cursor={{ stroke: "rgba(245,158,11,0.28)", strokeWidth: 1 }} contentStyle={{ background: "#1b1410", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, color: "#fff" }} formatter={(value: number, name: string) => [`${money(Math.round(Number(value)))} đ/ổ`, name === "actual" ? "Actual paid avg" : "Formula baseline"]} labelFormatter={(label) => `Đợt ${label}`} />
                        <Line type="monotone" dataKey="baseline" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 6" dot={false} />
                        <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={4} dot={{ r: 4, fill: "#f59e0b", stroke: "#1b1004", strokeWidth: 2 }} activeDot={{ r: 6, fill: "#fbbf24", stroke: "#1b1004", strokeWidth: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-4 text-xs font-semibold leading-relaxed text-white/38">Chart tính tổng cost NVL theo giá PR/duyệt chi đã quy đổi tại từng ngày phát sinh mua hàng trong tháng; baseline là cost công thức ban đầu.</p>
                </article>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
