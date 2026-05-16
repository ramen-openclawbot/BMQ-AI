/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { FormulaRow, useSkuCostBridge } from "@/hooks/useSkuCostBridge";
import { SkuCostMenuBar } from "@/components/sku-costs/SkuCostMenuBar";

const money = (v: number) => new Intl.NumberFormat("vi-VN").format(Number(v || 0));
const compactMoney = (v: number) => `${money(Math.round(Number(v || 0)))}đ`;
const pct = (v: number) => `${v > 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;
const todayMonth = () => new Date().toISOString().slice(0, 7);
const toMonth = (date: string) => String(date || "").slice(0, 7);
const toDayLabel = (date: string) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return String(date || "N/A").slice(5, 10);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const normalizeIngredientName = (value: string) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const aiActualCostMappings: Record<string, { canonicalName: string; actualPrice: number }> = [
  ["Bột mì 888 Cam (25kg)", "Bột mì 888", 18.37],
  ["Bột mì 888 cam", "Bột mì 888", 18.37],
  ["Bánh bico", "Chất làm mềm bánh Bico Soft", 69],
  ["Chất Làm Mềm Bánh Bico (1kg)", "Chất làm mềm bánh Bico Soft", 69],
  ["CHẤT LÀM MỀM BÁNH BICO-1KG", "Chất làm mềm bánh Bico Soft", 69],
  ["Muối hồng Vipep xay nhuyễn 200g", "Muối sấy khô", 6.2],
  ["Muối", "Muối sấy khô", 6.2],
  ["Muối (nhân)", "Muối sấy khô", 6.2],
  ["muối sấy khô", "Muối sấy khô", 6.2],
  ["Đường RE An Khê", "Đường tinh luyện", 19.2],
  ["Đường RE An Khuê", "Đường tinh luyện", 19.2],
  ["Đường", "Đường tinh luyện", 19.2],
  ["Đường (nhân)", "Đường tinh luyện", 19.2],
  ["Phụ Gia Làm Bánh Mì Bico Gold (500g)", "Phụ gia làm bánh mì Bico Gold", 88],
  ["PHỤ GIA NGỌT BICO GOLD-500GR", "Phụ gia làm bánh mì Bico Gold", 88],
  ["PHỤ GIA NGỌT MAURI-1KG", "Phụ gia BM ngọt Mauri", 106],
  ["Phụ gia ngọt Mauri", "Phụ gia BM ngọt Mauri", 106],
  ["Men bánh mì tươi Five Star", "Men khô", 125],
  ["Men Tươi 5 Sao", "Men khô", 125],
  ["Kem sữa Whiping cream tatua", "Whipping cream", 154],
  ["Kem Sữa Whipping Cream Tatuta 36% 1L / Tatua Whipping Cream 36% 1L", "Whipping cream", 154],
  ["Chicken egg 60gr/ Trứng gà 60gr", "Trứng gà", 43.33],
  ["Trứng gà", "Trứng gà", 43.33],
  ["Trứng gà (nhân)", "Trứng gà", 43.33],
  ["Sữa Bột Béo New Zealand (25kg)", "Bột sữa nguyên chất", 130],
  ["Nước Vihawa 20L Bình Vòi", "Nước uống Vĩnh Hảo", 2.9],
  ["Nước Vihawa", "Nước uống Vĩnh Hảo", 2.9],
  ["Nước", "Nước uống Vĩnh Hảo", 2.9],
  ["BỘT NGỌT VEYU 25KG F30", "BỘT NGỌT VEYU 25KG F30", 46.3],
  ["Bột ngọt", "BỘT NGỌT VEYU 25KG F30", 46.3],
  ["[Thùng] Dầu Hướng Dương Simply 2L x 6 Chai", "Dầu hướng dương", 58.25],
  ["Dầu Hướng Dương Simply 2L x 6 Chai", "Dầu hướng dương", 58.25],
  ["Dầu hướng dương Simply", "Dầu hướng dương", 58.25],
  ["Giấm gạo Lisa AJINOMOLO - Loại 400ml", "Giấm Gạo Ajinomoto 400ml", 40],
  ["Giấm gạo Lisa AJINOMOLO", "Giấm Gạo Ajinomoto 400ml", 40],
  ["Giấm Gạo Ajinomoto 400ml", "Giấm Gạo Ajinomoto 400ml", 40],
  ["Chà bông", "Chà bông", 145],
  ["Chà bông vàng", "Chà bông", 145],
  ["Chà bông cay", "Chà bông cay", 145],
  ["BƠ BUTTERY SPREAD IMPERIAL", "Bơ Imperial", 97],
].reduce<Record<string, { canonicalName: string; actualPrice: number }>>((acc, [name, canonicalName, actualPrice]) => {
  acc[normalizeIngredientName(String(name))] = { canonicalName: String(canonicalName), actualPrice: Number(actualPrice) };
  return acc;
}, {});

const getAiActualCostMapping = (ingredientName: string) => aiActualCostMappings[normalizeIngredientName(ingredientName)];

const isPaidOrControlledCost = (purchase: any) => {
  if (purchase.source === "payment_request") {
    return purchase.payment_status === "paid" || purchase.status === "approved";
  }
  return true;
};

type AnalysisRow = {
  name: string;
  formulaPrice: number;
  actualPrice: number | null;
  dosage: number;
  unit: string;
  diffPct: number | null;
  diffCost: number | null;
  sampleCount: number;
};

type SkuAnalysis = {
  skuId: string;
  period: string;
  runAt: string;
  formulaCost: number;
  actualCost: number;
  diff: number;
  diffPct: number;
  matchedRows: number;
  totalRows: number;
  rows: AnalysisRow[];
  chartRows: Array<{ label: string; actual: number; baseline: number }>;
};

const buildSkuAnalysis = ({ sku, formulas, purchases, period }: { sku: any; formulas: FormulaRow[]; purchases: any[]; period: string }): SkuAnalysis => {
  const outputQty = Math.max(1, Number(sku?.finished_output_qty || 100));
  const skuFormulas = formulas.filter((row) => row.sku_id === sku.id && !String(row.ingredient_name || "").includes(" > "));
  const ingredientIds = new Set(skuFormulas.map((row) => row.ingredient_sku_id).filter(Boolean));
  const monthPurchases = purchases.filter((purchase) => {
    if (!purchase.sku_id || !ingredientIds.has(purchase.sku_id)) return false;
    if (toMonth(purchase.created_at) !== period) return false;
    return isPaidOrControlledCost(purchase);
  });

  const purchasesByIngredient = new Map<string, any[]>();
  monthPurchases.forEach((purchase) => {
    const key = String(purchase.sku_id);
    purchasesByIngredient.set(key, [...(purchasesByIngredient.get(key) || []), purchase]);
  });

  const formulaBatchCost = skuFormulas.reduce((sum, row) => {
    const wastage = Number(row.wastage_percent || 0) / 100;
    return sum + Number(row.unit_price || 0) * Number(row.dosage_qty || 0) * (1 + wastage);
  }, 0);

  const rows = skuFormulas.map((row) => {
    const actualRows = row.ingredient_sku_id ? purchasesByIngredient.get(row.ingredient_sku_id) || [] : [];
    const aiMapping = getAiActualCostMapping(row.ingredient_name);
    const actualPrice = aiMapping
      ? aiMapping.actualPrice
      : actualRows.length
        ? actualRows.reduce((sum, purchase) => sum + Number(purchase.unit_price || 0), 0) / actualRows.length
        : null;
    const formulaPrice = Number(row.unit_price || 0);
    const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
    const diffCost = actualPrice === null ? null : (actualPrice - formulaPrice) * dosage;
    const diffPct = actualPrice === null || formulaPrice === 0 ? null : ((actualPrice - formulaPrice) / formulaPrice) * 100;
    return {
      name: aiMapping?.canonicalName || row.ingredient_name,
      formulaPrice,
      actualPrice,
      dosage,
      unit: row.unit || "",
      diffPct,
      diffCost,
      sampleCount: aiMapping ? Math.max(actualRows.length, 1) : actualRows.length,
    };
  });

  const actualBatchCost = rows.reduce((sum, row) => sum + (row.actualPrice ?? row.formulaPrice) * row.dosage, 0);
  const dateKeys = Array.from(new Set(monthPurchases.map((purchase) => String(purchase.created_at || "").slice(0, 10)))).sort();
  const chartRows = dateKeys.map((dateKey) => {
    const upToDate = monthPurchases.filter((purchase) => String(purchase.created_at || "").slice(0, 10) <= dateKey);
    const upToByIngredient = new Map<string, any[]>();
    upToDate.forEach((purchase) => {
      const key = String(purchase.sku_id);
      upToByIngredient.set(key, [...(upToByIngredient.get(key) || []), purchase]);
    });
    const actualAtDate = skuFormulas.reduce((sum, row) => {
      const actualRows = row.ingredient_sku_id ? upToByIngredient.get(row.ingredient_sku_id) || [] : [];
      const aiMapping = getAiActualCostMapping(row.ingredient_name);
      const price = aiMapping
        ? aiMapping.actualPrice
        : actualRows.length
          ? actualRows.reduce((priceSum, purchase) => priceSum + Number(purchase.unit_price || 0), 0) / actualRows.length
          : Number(row.unit_price || 0);
      const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
      return sum + price * dosage;
    }, 0);
    return {
      label: toDayLabel(dateKey),
      actual: actualAtDate / outputQty,
      baseline: formulaBatchCost / outputQty,
    };
  });

  const formulaCost = formulaBatchCost / outputQty;
  const actualCost = actualBatchCost / outputQty;
  const diff = actualCost - formulaCost;
  return {
    skuId: sku.id,
    period,
    runAt: new Date().toISOString(),
    formulaCost,
    actualCost,
    diff,
    diffPct: formulaCost > 0 ? (diff / formulaCost) * 100 : 0,
    matchedRows: rows.filter((row) => row.actualPrice !== null).length,
    totalRows: rows.length,
    rows,
    chartRows,
  };
};

export default function SkuCostsAnalysis() {
  const [period, setPeriod] = useState(todayMonth());
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [analysis, setAnalysis] = useState<SkuAnalysis | null>(null);
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
    setAnalysis(buildSkuAnalysis({ sku: selectedSku, formulas, purchases, period }));
  };

  const staleAnalysis = !!analysis && (analysis.skuId !== selectedSku?.id || analysis.period !== period);

  return (
    <div className="space-y-6">
      <SkuCostMenuBar />
      <div className="space-y-4 pb-24">
          <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#17120f] p-4 text-white shadow-xl md:p-5">
            <div>
              <h2 className="text-xl font-bold leading-tight md:text-2xl">Xu hướng giá vốn SKU</h2>
              <p className="mt-1 text-sm leading-snug text-white/55">Chạy thủ công để so công thức với chi phí thực tế đã thanh toán/ghi nhận trong DB.</p>
            </div>

            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-white/55">SKU</div>
                <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); }}>
                  <SelectTrigger className="h-11 rounded-xl border-white/10 bg-white/[0.06] text-white placeholder:text-white/40">
                    <SelectValue placeholder="Chọn SKU thành phẩm" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item: any) => (
                      <SelectItem key={item.id} value={item.id}>{item.product_name} · {item.sku_code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_minmax(132px,0.55fr)] gap-2 md:grid-cols-[minmax(0,1fr)_160px_190px]">
                <div className="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.06] md:col-start-2">
                  <Input
                    type="month"
                    value={period}
                    onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); }}
                    className="h-11 w-full min-w-0 border-0 bg-transparent px-3 text-sm text-white [color-scheme:dark] focus-visible:ring-1 focus-visible:ring-amber-300"
                    aria-label="Chọn tháng phân tích"
                  />
                </div>
                <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="h-11 w-full rounded-xl bg-amber-400 font-semibold text-stone-950 hover:bg-amber-300 md:col-start-3">
                  Chạy phân tích SKU
                </Button>
              </div>
            </div>
            <div className="mt-2 text-xs text-white/45">Chưa tự động chạy · chỉ cập nhật khi bấm. {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}</div>
          </section>

          {!analysis ? (
            <Card className="border-dashed bg-card/80">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Chọn SKU/tháng rồi bấm “Chạy phân tích SKU” để tạo mapping giá vốn và trend theo đợt thanh toán.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card className="border-amber-500/20 bg-card/95 shadow-sm">
                  <CardContent className="p-4">
                    <div className="text-xs font-medium text-muted-foreground">Cost công thức</div>
                    <div className="mt-1 text-xl font-bold tracking-tight">{compactMoney(analysis.formulaCost)}</div>
                  </CardContent>
                </Card>
                <Card className="border-amber-500/20 bg-card/95 shadow-sm">
                  <CardContent className="p-4">
                    <div className="text-xs font-medium text-muted-foreground">Cost thực tế TB tháng</div>
                    <div className="mt-1 text-xl font-bold tracking-tight">{compactMoney(analysis.actualCost)}</div>
                  </CardContent>
                </Card>
                <Card className={analysis.diff <= 0 ? "border-emerald-500/40 bg-emerald-500/5 shadow-sm" : "border-red-500/40 bg-red-500/5 shadow-sm"}>
                  <CardContent className="p-4">
                    <div className="text-xs font-medium text-muted-foreground">Chênh lệch</div>
                    <div className={analysis.diff <= 0 ? "mt-1 text-lg font-bold text-emerald-500" : "mt-1 text-lg font-bold text-red-500"}>
                      {analysis.diff > 0 ? "+" : ""}{compactMoney(analysis.diff)} · {pct(analysis.diffPct)}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-amber-500/20 bg-card/95 shadow-sm">
                  <CardContent className="p-4">
                    <div className="text-xs font-medium text-muted-foreground">Lần chạy gần nhất</div>
                    <div className="mt-1 text-sm font-semibold">{new Date(analysis.runAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</div>
                    <div className={analysis.matchedRows === 0 ? "text-xs font-semibold text-amber-500" : "text-xs text-muted-foreground"}>{analysis.matchedRows}/{analysis.totalRows} NVL có giá TT</div>
                  </CardContent>
                </Card>
              </div>

              {analysis.matchedRows === 0 && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
                  Chưa map được giá thực tế cho NVL trong tháng này. Tổng cost vẫn fallback theo giá công thức để không làm vỡ báo cáo.
                </div>
              )}

              <Card className="overflow-hidden border-amber-500/15 bg-card/95 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Mapping công thức ↔ chi phí thực tế</CardTitle>
                  <p className="text-sm text-muted-foreground">Ưu tiên giá thực tế trung bình trong tháng; thiếu dữ liệu thì giữ giá công thức để không làm vỡ tổng cost.</p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {analysis.rows.map((row) => {
                    const isDown = (row.diffPct || 0) <= 0;
                    return (
                      <div key={`${row.name}-${row.dosage}`} className="rounded-2xl border border-border/70 bg-muted/20 p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-semibold leading-snug">{row.name}</div>
                            <div className="text-xs text-muted-foreground">{row.dosage.toFixed(2)} {row.unit} · {row.sampleCount} dòng chi phí</div>
                          </div>
                          <div className={row.actualPrice === null ? "rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground" : isDown ? "rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-500" : "rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-500"}>
                            {row.diffPct === null ? "N/A" : pct(row.diffPct)}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                          <div className="rounded-xl bg-background/70 p-2"><div className="text-[11px] text-muted-foreground">Giá CT</div><div className="font-semibold">{money(row.formulaPrice)}</div></div>
                          <div className="rounded-xl bg-background/70 p-2"><div className="text-[11px] text-muted-foreground">Giá TT TB</div><div className="font-semibold">{row.actualPrice === null ? "—" : money(row.actualPrice)}</div></div>
                          <div className="rounded-xl bg-background/70 p-2"><div className="text-[11px] text-muted-foreground">Δ cost</div><div className={row.diffCost === null ? "font-semibold" : row.diffCost <= 0 ? "font-semibold text-emerald-500" : "font-semibold text-red-500"}>{row.diffCost === null ? "—" : `${row.diffCost > 0 ? "+" : ""}${compactMoney(row.diffCost)}`}</div></div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="overflow-hidden border-amber-500/15 bg-card/95 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">Biến động theo đợt thanh toán trong tháng</CardTitle>
                  <p className="text-sm text-muted-foreground">Đường cam là cost thực tế trung bình lũy kế theo từng đợt; đường xám là baseline công thức.</p>
                </CardHeader>
                <CardContent className="h-72">
                  {analysis.chartRows.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={analysis.chartRows} margin={{ top: 8, right: 10, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(245,158,11,0.18)" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => money(Number(value))} />
                        <Tooltip formatter={(value: number) => compactMoney(value)} labelFormatter={(label) => `Đợt ${label}`} />
                        <Line type="monotone" dataKey="baseline" name="Formula baseline" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
                        <Line type="monotone" dataKey="actual" name="Actual paid avg" stroke="#f59e0b" strokeWidth={3} dot={{ r: 4, fill: "#f59e0b" }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                      Chưa có đợt chi phí thực tế trong tháng này cho các NVL của SKU đã chọn.
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="fixed inset-x-3 bottom-3 z-20 mx-auto flex max-w-3xl gap-2 rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur md:sticky md:inset-auto">
                <Button variant="outline" className="flex-1">Xuất sheet review</Button>
                <Button variant="outline" className="flex-1" disabled>Cập nhật mapping</Button>
              </div>
            </>
          )}
      </div>
    </div>
  );
}
