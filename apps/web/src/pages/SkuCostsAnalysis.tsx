import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Info } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

const tabs = ["Tổng quan giá vốn", "Xu hướng giá vốn", "Phân bổ chi phí", "Nhân công"];

const mockSkus = [
  { id: "bmcb-2026-v2", label: "Bánh Mì Chà Bông - bmcb-2026-v2" },
  { id: "bmtt-2026-v1", label: "Bánh Mì Thập Cẩm - bmtt-2026-v1" },
];

const kpis = [
  { label: "Cost công thức", value: "10,952", suffix: "đ/ổ" },
  { label: "Cost thực tế TB tháng", value: "11,463", suffix: "đ/ổ" },
  { label: "Chênh lệch", value: "+511", suffix: "đ/ổ", percent: "+4.67%", intent: "up" },
  { label: "Lần chạy gần nhất", value: "26/05/2026", suffix: "09:42" },
];

const mappingRows = [
  { name: "Bột mì 888", formula: "18.42", actual: "18.37", delta: "-0.3%", direction: "down" as const },
  { name: "Chà bông", formula: "140.00", actual: "145.00", delta: "+3.6%", direction: "up" as const },
  { name: "Giấm gạo", formula: "51.00", actual: "40.00", delta: "-21.6%", direction: "down" as const },
];

const chartRows = [
  { label: "05/05", actual: 11040, baseline: 10952 },
  { label: "12/05", actual: 11280, baseline: 10952 },
  { label: "18/05", actual: 11460, baseline: 10952 },
  { label: "25/05", actual: 11610, baseline: 10952 },
];

function DeltaBadge({ direction, value }: { direction: "up" | "down"; value: string }) {
  const isUp = direction === "up";
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span
      className={
        isUp
          ? "inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-1 text-[11px] font-bold text-rose-300 ring-1 ring-rose-400/20"
          : "inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-1 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/20"
      }
    >
      <Icon className="h-3 w-3" />
      {value}
    </span>
  );
}

export default function SkuCostsAnalysis() {
  return (
    <div className="-m-4 min-h-screen bg-[#0b0908] text-white md:-m-6">
      <div className="mx-auto min-h-screen w-full max-w-[430px] bg-[radial-gradient(circle_at_50%_-10%,rgba(245,158,11,0.24),transparent_34%),linear-gradient(180deg,#17100c_0%,#0b0908_42%,#080706_100%)] px-4 pb-28 pt-3 shadow-2xl md:max-w-[520px] md:px-5">
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
            {tabs.map((tab) => {
              const active = tab === "Xu hướng giá vốn";
              return (
                <button
                  key={tab}
                  className={
                    active
                      ? "relative shrink-0 pb-3 text-[13px] font-extrabold text-amber-300 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-amber-400"
                      : "shrink-0 pb-3 text-[13px] font-semibold text-white/45"
                  }
                >
                  {tab}
                </button>
              );
            })}
          </nav>
        </header>

        <main className="space-y-4 pt-4">
          <section className="rounded-[24px] border border-white/10 bg-white/[0.055] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-xl">
            <div className="space-y-3">
              <label className="block text-[11px] font-extrabold uppercase tracking-[0.18em] text-white/40">SKU</label>
              <Select defaultValue="bmcb-2026-v2">
                <SelectTrigger className="h-12 rounded-[15px] border-white/10 bg-[#211915] px-3 text-[14px] font-bold text-white shadow-inner focus:ring-amber-300/60 [&>svg]:hidden">
                  <SelectValue placeholder="Chọn SKU" />
                  <ChevronDown className="ml-2 h-4 w-4 text-white/40" />
                </SelectTrigger>
                <SelectContent>
                  {mockSkus.map((sku) => (
                    <SelectItem key={sku.id} value={sku.id}>{sku.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                <div className="min-w-0 overflow-hidden rounded-[15px] border border-white/10 bg-[#211915] shadow-inner">
                  <Input
                    type="month"
                    defaultValue="2026-05"
                    aria-label="Chọn tháng phân tích"
                    className="h-12 w-full min-w-0 border-0 bg-transparent px-3 text-[13px] font-bold text-white [color-scheme:dark] focus-visible:ring-1 focus-visible:ring-amber-300"
                  />
                </div>
                <Button className="h-12 rounded-[15px] bg-[#f59e0b] px-3 text-[12px] font-extrabold leading-tight text-[#1b1004] shadow-[0_14px_28px_rgba(245,158,11,0.25)] hover:bg-amber-300">
                  Chạy phân tích SKU
                </Button>
              </div>
            </div>
            <p className="mt-3 text-[12px] font-medium leading-snug text-white/42">Dữ liệu mẫu đang mô phỏng giá PR/duyệt chi đã quy đổi về đơn vị công thức.</p>
          </section>

          <section className="grid grid-cols-2 gap-3">
            {kpis.map((item) => {
              const isDiff = item.label === "Chênh lệch";
              return (
                <article key={item.label} className="min-h-[104px] rounded-[22px] border border-white/10 bg-[#14100d]/90 p-3.5 shadow-[0_14px_42px_rgba(0,0,0,0.28)]">
                  <p className="text-[11px] font-bold leading-tight text-white/45">{item.label}</p>
                  <div className="mt-3 flex flex-wrap items-end gap-x-1 gap-y-1">
                    <span className={isDiff ? "text-[24px] font-black leading-none tracking-[-0.04em] text-rose-300" : "text-[24px] font-black leading-none tracking-[-0.04em] text-white"}>{item.value}</span>
                    <span className="pb-0.5 text-[12px] font-bold text-white/45">{item.suffix}</span>
                  </div>
                  {item.percent && (
                    <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-1 text-[11px] font-extrabold text-rose-300 ring-1 ring-rose-400/20">
                      <ArrowUp className="h-3 w-3" />
                      {item.percent}
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <section className="overflow-hidden rounded-[24px] border border-white/10 bg-[#14100d]/95 shadow-[0_18px_60px_rgba(0,0,0,0.34)]">
            <div className="border-b border-white/10 px-4 py-4">
              <h2 className="text-[17px] font-black tracking-[-0.02em] text-white">Mapping công thức ↔ chi phí thực tế</h2>
            </div>
            <div className="px-4 py-3">
              <div className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] gap-2 border-b border-white/8 pb-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-white/35">
                <span>NVL</span>
                <span className="text-right">Giá CT</span>
                <span className="text-right">Giá TT TB</span>
                <span className="text-right">Δ</span>
              </div>
              <div className="divide-y divide-white/[0.07]">
                {mappingRows.map((row) => (
                  <div key={row.name} className="grid grid-cols-[minmax(0,1.2fr)_68px_78px_66px] items-center gap-2 py-3">
                    <div className="min-w-0 text-[13px] font-extrabold leading-tight text-white">{row.name}</div>
                    <div className="text-right text-[13px] font-bold tabular-nums text-white/70">{row.formula}</div>
                    <div className="text-right text-[13px] font-bold tabular-nums text-white">{row.actual}</div>
                    <div className="flex justify-end"><DeltaBadge direction={row.direction} value={row.delta} /></div>
                  </div>
                ))}
              </div>
              <button className="mt-1 flex w-full items-center justify-center rounded-2xl border border-dashed border-amber-300/20 bg-amber-300/[0.04] px-3 py-3 text-[13px] font-extrabold text-amber-300">
                Xem thêm nguyên liệu (12)
              </button>
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
                <LineChart data={chartRows} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.42)", fontSize: 11, fontWeight: 700 }} dy={8} />
                  <YAxis domain={[10500, 12000]} axisLine={false} tickLine={false} tick={{ fill: "rgba(255,255,255,0.32)", fontSize: 10 }} tickFormatter={(value) => money(Number(value))} width={54} />
                  <Tooltip
                    cursor={{ stroke: "rgba(245,158,11,0.28)", strokeWidth: 1 }}
                    contentStyle={{ background: "#1b1410", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, color: "#fff" }}
                    formatter={(value: number, name: string) => [`${money(Number(value))} đ/ổ`, name === "actual" ? "Actual paid avg" : "Formula baseline"]}
                    labelFormatter={(label) => `Đợt ${label}`}
                  />
                  <Line type="monotone" dataKey="baseline" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 6" dot={false} />
                  <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={4} dot={{ r: 4, fill: "#f59e0b", stroke: "#1b1004", strokeWidth: 2 }} activeDot={{ r: 6, fill: "#fbbf24", stroke: "#1b1004", strokeWidth: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[430px] border-t border-white/10 bg-[#0b0908]/92 px-4 py-3 shadow-[0_-18px_50px_rgba(0,0,0,0.42)] backdrop-blur-xl md:max-w-[520px]">
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" className="h-12 rounded-[16px] border-white/12 bg-white/[0.04] text-[13px] font-extrabold text-white hover:bg-white/[0.08] hover:text-white">
              Xuất sheet review
            </Button>
            <Button variant="outline" disabled className="h-12 rounded-[16px] border-amber-300/35 bg-transparent text-[13px] font-extrabold text-amber-300 opacity-55 disabled:opacity-55">
              Cập nhật mapping
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
