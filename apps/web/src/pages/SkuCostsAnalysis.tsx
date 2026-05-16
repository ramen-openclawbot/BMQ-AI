/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { FormulaRow, useSkuCostBridge } from "@/hooks/useSkuCostBridge";
import { useLanguage } from "@/contexts/LanguageContext";
import { ActualLaborCostPanel } from "@/components/sku-costs/ActualLaborCostPanel";

const tabItems = [
  { key: "overview", label: "Tổng quan giá vốn" },
  { key: "trends", label: "Xu hướng giá vốn" },
  { key: "overhead", label: "Phân bổ chi phí chung" },
  { key: "actual-labor", label: "Nhân công thực tế" },
];

const COLORS = ["#16a34a", "#0ea5e9", "#f59e0b", "#ef4444", "#8b5cf6"];
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
    const actualPrice = actualRows.length
      ? actualRows.reduce((sum, purchase) => sum + Number(purchase.unit_price || 0), 0) / actualRows.length
      : null;
    const formulaPrice = Number(row.unit_price || 0);
    const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
    const diffCost = actualPrice === null ? null : (actualPrice - formulaPrice) * dosage;
    const diffPct = actualPrice === null || formulaPrice === 0 ? null : ((actualPrice - formulaPrice) / formulaPrice) * 100;
    return {
      name: row.ingredient_name,
      formulaPrice,
      actualPrice,
      dosage,
      unit: row.unit || "",
      diffPct,
      diffCost,
      sampleCount: actualRows.length,
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
      const price = actualRows.length
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
  const { language } = useLanguage();
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState(todayMonth());
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [analysis, setAnalysis] = useState<SkuAnalysis | null>(null);
  const { data, isLoading } = useSkuCostBridge();

  const items = useMemo(() => data?.items || [], [data?.items]);
  const formulas = useMemo(() => data?.formulas || [], [data?.formulas]);
  const purchases = useMemo(() => data?.purchases || [], [data?.purchases]);
  const copy = {
    filter: language === "vi" ? "Bộ lọc" : "Filters",
    search: language === "vi" ? "Tìm kiếm SKU hoặc sản phẩm" : "Search SKU or product",
    title: language === "vi" ? "Tính chi phí giá vốn hàng bán (SKU thành phẩm)" : "COGS calculation (finished SKUs)",
    loading: language === "vi" ? "Đang tải dữ liệu..." : "Loading data...",
    empty: language === "vi" ? "Chưa có dữ liệu." : "No data yet.",
    breakdownTitle: language === "vi" ? "Tỷ trọng nhóm chi phí" : "Cost mix",
    overheadTitle: language === "vi" ? "Phân bổ chi phí chung" : "Shared overhead allocation",
    overheadDesc: language === "vi" ? "Delivery + Other Production + BH&QL đang được gom vào nhóm chi phí chung trong phân tích tổng quan." : "Delivery, other production, and SG&A are grouped into shared overhead in the overview analysis.",
  };

  const selectedSku = useMemo(() => {
    if (!items.length) return null;
    return items.find((item: any) => item.id === selectedSkuId) || items.find((item: any) => String(item.product_name || "").toLowerCase().includes("chà bông")) || items[0];
  }, [items, selectedSkuId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c: any) => `${c.sku_code} ${c.product_name}`.toLowerCase().includes(q));
  }, [items, search]);

  const breakdown = useMemo(() => {
    if (!filtered.length) return [];
    const sum = filtered.reduce(
      (acc: any, i: any) => {
        acc.ingredient += i.ingredient_cost;
        acc.packaging += i.packaging_cost;
        acc.labor += i.labor_cost;
        acc.overhead += i.delivery_cost + i.other_production_cost + i.sga_cost + i.extra_cost;
        return acc;
      },
      { ingredient: 0, packaging: 0, labor: 0, overhead: 0 }
    );
    return [
      { name: "Nguyên liệu", value: sum.ingredient },
      { name: "Bao bì", value: sum.packaging },
      { name: "Nhân công", value: sum.labor },
      { name: "Chi phí khác", value: sum.overhead },
    ];
  }, [filtered]);

  const runAnalysis = () => {
    if (!selectedSku) return;
    setSelectedSkuId(selectedSku.id);
    setAnalysis(buildSkuAnalysis({ sku: selectedSku, formulas, purchases, period }));
  };

  const staleAnalysis = !!analysis && (analysis.skuId !== selectedSku?.id || analysis.period !== period);

  return (
    <div className="space-y-6">
      <div className="flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
        {tabItems.map((t) => (
          <Button key={t.key} variant={tab === t.key ? "default" : "outline"} onClick={() => setTab(t.key)} className="shrink-0 rounded-full">
            {t.label}
          </Button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{copy.filter}</CardTitle></CardHeader>
            <CardContent><Input placeholder={copy.search} value={search} onChange={(e) => setSearch(e.target.value)} /></CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{copy.title}</CardTitle>
              <p className="text-sm text-muted-foreground">Tổng quan giá vốn theo SKU thành phẩm; chi tiết xu hướng từng SKU nằm ở tab “Xu hướng giá vốn”.</p>
            </CardHeader>
            <CardContent>
              {!filtered.length ? (
                <div className="text-sm text-muted-foreground">{isLoading ? copy.loading : copy.empty}</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Nguyên liệu</TableHead>
                        <TableHead>Bao bì</TableHead>
                        <TableHead>Nhân công</TableHead>
                        <TableHead>Delivery</TableHead>
                        <TableHead>Other Prod.</TableHead>
                        <TableHead>BH&QL</TableHead>
                        <TableHead>Tổng/cái</TableHead>
                        <TableHead>Thành phẩm</TableHead>
                        <TableHead>Giá bán</TableHead>
                        <TableHead>Biên LN</TableHead>
                        <TableHead>Stock NVL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((c: any) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-mono text-xs">{c.sku_code}<div className="text-muted-foreground">{c.product_name}</div></TableCell>
                          <TableCell>{money(c.ingredient_cost)}</TableCell>
                          <TableCell>{money(c.packaging_cost)}</TableCell>
                          <TableCell>{money(c.labor_cost)}</TableCell>
                          <TableCell>{money(c.delivery_cost)}</TableCell>
                          <TableCell>{money(c.other_production_cost)}</TableCell>
                          <TableCell>{money(c.sga_cost + c.extra_cost)}</TableCell>
                          <TableCell className="font-semibold">{money(c.total_cost_per_unit)}</TableCell>
                          <TableCell>{c.finished_output_qty} {c.finished_output_unit}</TableCell>
                          <TableCell>{money(c.selling_price)}</TableCell>
                          <TableCell>{c.margin_percentage?.toFixed?.(2)}%</TableCell>
                          <TableCell>{money(c.estimated_ingredient_stock)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{copy.breakdownTitle}</CardTitle></CardHeader>
            <CardContent className="h-64">
              {breakdown.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={breakdown} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}>
                      {breakdown.map((_: any, idx: number) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(value: number) => compactMoney(value)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-sm text-muted-foreground">{copy.empty}</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "trends" && (
        <div className="space-y-4 pb-20">
          <Card className="border-primary/20 bg-card/95">
            <CardHeader>
              <CardTitle className="text-xl">Xu hướng giá vốn SKU</CardTitle>
              <p className="text-sm text-muted-foreground">Chạy thủ công để so công thức với chi phí thực tế đã thanh toán/ghi nhận trong DB.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-[1fr_160px]">
                <Select value={selectedSku?.id || ""} onValueChange={(value) => { setSelectedSkuId(value); setAnalysis(null); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn SKU thành phẩm" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((item: any) => (
                      <SelectItem key={item.id} value={item.id}>{item.product_name} · {item.sku_code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setAnalysis(null); }} />
              </div>
              <Button onClick={runAnalysis} disabled={!selectedSku || isLoading} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Chạy phân tích SKU
              </Button>
              <div className="text-xs text-muted-foreground">Chưa tự động chạy · chỉ cập nhật khi bấm. {staleAnalysis ? "Thông số đã đổi, bấm chạy lại để cập nhật." : ""}</div>
            </CardContent>
          </Card>

          {!analysis ? (
            <Card className="border-dashed">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Chọn SKU/tháng rồi bấm “Chạy phân tích SKU” để tạo mapping giá vốn và trend theo đợt thanh toán.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground">Cost công thức</div>
                    <div className="mt-1 text-lg font-semibold">{compactMoney(analysis.formulaCost)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground">Cost thực tế TB tháng</div>
                    <div className="mt-1 text-lg font-semibold">{compactMoney(analysis.actualCost)}</div>
                  </CardContent>
                </Card>
                <Card className={analysis.diff <= 0 ? "border-emerald-500/40" : "border-red-500/40"}>
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground">Chênh lệch</div>
                    <div className={analysis.diff <= 0 ? "mt-1 text-lg font-semibold text-emerald-400" : "mt-1 text-lg font-semibold text-red-400"}>
                      {analysis.diff > 0 ? "+" : ""}{compactMoney(analysis.diff)} · {pct(analysis.diffPct)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="text-xs text-muted-foreground">Lần chạy gần nhất</div>
                    <div className="mt-1 text-sm font-medium">{new Date(analysis.runAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</div>
                    <div className="text-xs text-muted-foreground">{analysis.matchedRows}/{analysis.totalRows} NVL có giá TT</div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Mapping công thức ↔ chi phí thực tế</CardTitle>
                  <p className="text-sm text-muted-foreground">Ưu tiên giá thực tế trung bình trong tháng; thiếu dữ liệu thì giữ giá công thức để không làm vỡ tổng cost.</p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {analysis.rows.map((row) => {
                    const isDown = (row.diffPct || 0) <= 0;
                    return (
                      <div key={`${row.name}-${row.dosage}`} className="rounded-xl border border-border/70 bg-muted/20 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium leading-snug">{row.name}</div>
                            <div className="text-xs text-muted-foreground">{row.dosage.toFixed(2)} {row.unit} · {row.sampleCount} dòng chi phí</div>
                          </div>
                          <div className={row.actualPrice === null ? "rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground" : isDown ? "rounded-full bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-400" : "rounded-full bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-400"}>
                            {row.diffPct === null ? "N/A" : pct(row.diffPct)}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                          <div><div className="text-xs text-muted-foreground">Giá CT</div><div>{money(row.formulaPrice)}</div></div>
                          <div><div className="text-xs text-muted-foreground">Giá TT TB</div><div>{row.actualPrice === null ? "—" : money(row.actualPrice)}</div></div>
                          <div><div className="text-xs text-muted-foreground">Δ cost</div><div className={row.diffCost === null ? "" : row.diffCost <= 0 ? "text-emerald-400" : "text-red-400"}>{row.diffCost === null ? "—" : `${row.diffCost > 0 ? "+" : ""}${compactMoney(row.diffCost)}`}</div></div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Biến động theo đợt thanh toán trong tháng</CardTitle>
                  <p className="text-sm text-muted-foreground">Đường cam là cost thực tế trung bình lũy kế theo từng đợt; đường xám là baseline công thức.</p>
                </CardHeader>
                <CardContent className="h-72">
                  {analysis.chartRows.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={analysis.chartRows} margin={{ top: 8, right: 10, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => money(Number(value))} />
                        <Tooltip formatter={(value: number) => compactMoney(value)} labelFormatter={(label) => `Đợt ${label}`} />
                        <Line type="monotone" dataKey="baseline" name="Formula baseline" stroke="#94a3b8" strokeDasharray="5 5" dot={false} />
                        <Line type="monotone" dataKey="actual" name="Actual paid avg" stroke="#f59e0b" strokeWidth={3} dot={{ r: 4 }} />
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
      )}

      {tab === "overhead" && (
        <Card>
          <CardHeader><CardTitle>{copy.overheadTitle}</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {copy.overheadDesc}
          </CardContent>
        </Card>
      )}

      {tab === "actual-labor" && <ActualLaborCostPanel />}
    </div>
  );
}
