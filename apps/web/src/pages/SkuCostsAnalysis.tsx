/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Info } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormulaRow, useSkuCostBridge } from "@/hooks/useSkuCostBridge";

const money = (v: number) => new Intl.NumberFormat("vi-VN").format(Number(v || 0));
const compactMoney = (v: number) => `${money(Math.round(Number(v || 0)))}đ`;
const decimalMoney = (v: number | null, digits = 2) => (v === null ? "—" : Number(v || 0).toLocaleString("vi-VN", { minimumFractionDigits: 0, maximumFractionDigits: digits }));
const pct = (v: number) => `${v > 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;
const todayMonth = () => new Date().toISOString().slice(0, 7);
const toMonth = (date: string) => String(date || "").slice(0, 7);
const toDayLabel = (date: string) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return String(date || "N/A").slice(5, 10);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const skuCostNavItems = [
  { to: "/sku-costs/dashboard", label: "Tổng quan giá vốn" },
  { to: "/sku-costs/analysis", label: "Xu hướng giá vốn" },
  { to: "/sku-costs/management", label: "Quản trị SKU" },
];

const normalizeIngredientName = (value: string) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[đĐ]/g, "d")
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

const mappedPurchaseAliases: Record<string, string[]> = [
  ["Bột mì 888 Cam (25kg)", ["bot mi 888 cam"]],
  ["Bột mì 888 cam", ["bot mi 888 cam"]],
  ["Bánh bico", ["lam mem banh bico"]],
  ["Chất Làm Mềm Bánh Bico (1kg)", ["lam mem banh bico"]],
  ["Muối hồng Vipep xay nhuyễn 200g", ["muoi say kho", "muoi hong vipep"]],
  ["Muối", ["muoi say kho"]],
  ["Muối (nhân)", ["muoi say kho"]],
  ["Đường RE An Khê", ["duong re an khe"]],
  ["Đường", ["duong re an khe"]],
  ["Đường (nhân)", ["duong re an khe"]],
  ["Phụ Gia Làm Bánh Mì Bico Gold (500g)", ["bico gold"]],
  ["PHỤ GIA NGỌT BICO GOLD-500GR", ["bico gold"]],
  ["PHỤ GIA NGỌT MAURI-1KG", ["phu gia ngot mauri"]],
  ["Phụ gia ngọt Mauri", ["phu gia ngot mauri"]],
  ["Men bánh mì tươi Five Star", ["men kho ngot mauripan", "men kho"]],
  ["Men Tươi 5 Sao", ["men kho ngot mauripan", "men kho"]],
  ["Kem sữa Whiping cream tatua", ["kem sua whipping cream"]],
  ["Kem Sữa Whipping Cream Tatuta 36% 1L / Tatua Whipping Cream 36% 1L", ["kem sua whipping cream"]],
  ["Chicken egg 60gr/ Trứng gà 60gr", ["trung ga", "chicken egg"]],
  ["Trứng gà", ["trung ga", "chicken egg"]],
  ["Trứng gà (nhân)", ["trung ga", "chicken egg"]],
  ["Sữa Bột Béo New Zealand (25kg)", ["sua bot beo new zealand"]],
  ["Nước Vihawa 20L Bình Vòi", ["nuoc vihawa 20l"]],
  ["Nước Vihawa", ["nuoc vihawa 20l"]],
  ["Nước", ["nuoc vihawa 20l"]],
  ["BỘT NGỌT VEYU 25KG F30", ["bot ngot veyu", "bot ngot"]],
  ["Bột ngọt", ["bot ngot veyu", "bot ngot"]],
  ["[Thùng] Dầu Hướng Dương Simply 2L x 6 Chai", ["dau huong duong"]],
  ["Dầu Hướng Dương Simply 2L x 6 Chai", ["dau huong duong"]],
  ["Dầu hướng dương Simply", ["dau huong duong"]],
  ["Giấm gạo Lisa AJINOMOLO - Loại 400ml", ["giam gao ajinomoto"]],
  ["Giấm gạo Lisa AJINOMOLO", ["giam gao ajinomoto"]],
  ["Giấm Gạo Ajinomoto 400ml", ["giam gao ajinomoto"]],
  ["Chà bông", ["cha bong"]],
  ["Chà bông vàng", ["cha bong"]],
  ["BƠ BUTTERY SPREAD IMPERIAL", ["bo imperial", "buttery spread imperial"]],
].reduce<Record<string, string[]>>((acc, [name, aliases]) => {
  acc[normalizeIngredientName(String(name))] = (aliases as string[]).map(normalizeIngredientName);
  return acc;
}, {});

const getMappedPurchaseAliases = (ingredientName: string) => mappedPurchaseAliases[normalizeIngredientName(ingredientName)] || [];

const purchaseMatchesFormulaRow = (purchase: any, row: FormulaRow) => {
  if (row.ingredient_sku_id && purchase.sku_id === row.ingredient_sku_id) return true;
  const purchaseName = normalizeIngredientName(`${purchase.product_name || ""} ${purchase.product_code || ""}`);
  if (!purchaseName) return false;
  return getMappedPurchaseAliases(row.ingredient_name).some((alias) => purchaseName.includes(alias));
};

const inferPurchaseUnitDivisor = (ingredientName: string) => {
  const n = normalizeIngredientName(ingredientName);
  if (n.includes("2l x 6") || n.includes("thung dau huong duong")) return 12000;
  if (n.includes("0 5x10kg") || n.includes("men kho ngot mauripan") || n.includes("men kho")) return 10000;
  if (n.includes("muoi say kho")) return 1000;
  if (n.includes("whipping cream") || n.includes("whiping cream") || n.includes("kem sua whipping")) return 1000;
  if (n.includes("25kg") || n.includes("bot mi 888") || n.includes("sua bot beo") || n.includes("bot ngot veyu")) return 25000;
  if (n.includes("20l") || n.includes("nuoc vihawa") || n.includes("nuoc uong vinh hao")) return 20000;
  if (n.includes("400ml") || n.includes("giam gao")) return 400;
  if (n.includes("500g") || n.includes("bico gold")) return 500;
  if (n.includes("1kg") || n.includes("mauri") || n.includes("bico soft") || n.includes("lam mem banh bico")) return 1000;
  if (n.includes("trung") || n.includes("egg")) return 60;
  if (n.includes("bo buttery") || n.includes("bo imperial")) return 970;
  if (n.includes("kg") || n.includes("cha bong") || n.includes("duong")) return 1000;
  return 1;
};

const toFormulaUnitPurchasePrice = (purchasePrice: number, ingredientName: string) => {
  const divisor = inferPurchaseUnitDivisor(ingredientName);
  const converted = Number(purchasePrice || 0) / divisor;
  return Number.isFinite(converted) && converted > 0 ? converted : null;
};

const averageConvertedPurchasePrice = (actualRows: any[], ingredientName: string) => {
  const prices = actualRows
    .map((purchase) => toFormulaUnitPurchasePrice(Number(purchase.unit_price || 0), `${purchase.product_name || ""} ${purchase.product_code || ""} ${purchase.unit || ""} ${ingredientName}`))
    .filter((value): value is number => value !== null);
  return prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
};

const latestConvertedPurchasePrice = (actualRows: any[], ingredientName: string, maxDate?: string) => {
  const eligibleRows = actualRows
    .filter((purchase) => !maxDate || String(purchase.created_at || "").slice(0, 10) <= maxDate)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  for (const purchase of eligibleRows) {
    const converted = toFormulaUnitPurchasePrice(Number(purchase.unit_price || 0), `${purchase.product_name || ""} ${purchase.product_code || ""} ${purchase.unit || ""} ${ingredientName}`);
    if (converted !== null) return converted;
  }
  return null;
};

const isPaidOrControlledCost = (purchase: any) => {
  if (purchase.source === "payment_request") return purchase.payment_status === "paid" || purchase.status === "approved";
  return true;
};

type AnalysisRow = {
  name: string;
  rawName: string;
  formulaPrice: number;
  actualPrice: number | null;
  dosage: number;
  unit: string;
  diffPct: number | null;
  diffCost: number | null;
  sampleCount: number;
  source: "PR/duyệt chi" | "AI/sheet fallback" | "Giá CT fallback";
};

type SkuAnalysis = {
  skuId: string;
  skuLabel: string;
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
  const controlledPurchases = purchases.filter(isPaidOrControlledCost);
  const monthPurchases = controlledPurchases.filter((purchase) => toMonth(purchase.created_at) === period);
  const purchasesForRow = (row: FormulaRow, scope: "month" | "all", maxDate?: string) =>
    (scope === "month" ? monthPurchases : controlledPurchases).filter((purchase) => {
      if (maxDate && String(purchase.created_at || "").slice(0, 10) > maxDate) return false;
      return purchaseMatchesFormulaRow(purchase, row);
    });
  const periodEndDate = `${period}-31`;

  const formulaBatchCost = skuFormulas.reduce((sum, row) => {
    const wastage = Number(row.wastage_percent || 0) / 100;
    return sum + Number(row.unit_price || 0) * Number(row.dosage_qty || 0) * (1 + wastage);
  }, 0);

  const rows = skuFormulas.map((row) => {
    const actualRows = purchasesForRow(row, "month");
    const allActualRows = purchasesForRow(row, "all", periodEndDate);
    const aiMapping = getAiActualCostMapping(row.ingredient_name);
    const purchasePrice = averageConvertedPurchasePrice(actualRows, row.ingredient_name);
    const latestPurchasePrice = latestConvertedPurchasePrice(allActualRows, row.ingredient_name, periodEndDate);
    const actualPrice = purchasePrice ?? latestPurchasePrice ?? aiMapping?.actualPrice ?? null;
    const formulaPrice = Number(row.unit_price || 0);
    const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
    const diffCost = actualPrice === null ? null : (actualPrice - formulaPrice) * dosage;
    const diffPct = actualPrice === null || formulaPrice === 0 ? null : ((actualPrice - formulaPrice) / formulaPrice) * 100;
    return {
      name: aiMapping?.canonicalName || row.ingredient_name,
      rawName: row.ingredient_name,
      formulaPrice,
      actualPrice,
      dosage,
      unit: row.unit || "",
      diffPct,
      diffCost,
      sampleCount: purchasePrice !== null ? actualRows.length : latestPurchasePrice !== null ? allActualRows.length : aiMapping ? 1 : 0,
      source: purchasePrice !== null ? "PR/duyệt chi" : latestPurchasePrice !== null ? "PR/duyệt chi" : aiMapping ? "AI/sheet fallback" : "Giá CT fallback",
    };
  });

  const actualBatchCost = rows.reduce((sum, row) => sum + (row.actualPrice ?? row.formulaPrice) * row.dosage, 0);
  const dateKeys = Array.from(new Set(monthPurchases.filter((purchase) => skuFormulas.some((row) => purchaseMatchesFormulaRow(purchase, row))).map((purchase) => String(purchase.created_at || "").slice(0, 10)))).sort();
  const chartDateKeys = dateKeys.length ? dateKeys : [`${period}-01`];
  const chartRows = chartDateKeys.map((dateKey) => {
    const actualAtDate = skuFormulas.reduce((sum, row) => {
      const actualRows = purchasesForRow(row, "all", dateKey);
      const aiMapping = getAiActualCostMapping(row.ingredient_name);
      const latestPrice = latestConvertedPurchasePrice(actualRows, row.ingredient_name, dateKey);
      const price = latestPrice ?? aiMapping?.actualPrice ?? Number(row.unit_price || 0);
      const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
      return sum + price * dosage;
    }, 0);
    return { label: toDayLabel(dateKey), actual: actualAtDate / outputQty, baseline: formulaBatchCost / outputQty };
  });

  const formulaCost = formulaBatchCost / outputQty;
  const actualCost = actualBatchCost / outputQty;
  const diff = actualCost - formulaCost;
  return {
    skuId: sku.id,
    skuLabel: `${sku.product_name || "SKU"} - ${sku.sku_code || sku.id}`,
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
    const header = ["SKU", "Tháng", "Tên NVL chuẩn", "Tên NVL công thức", "Giá CT", "Giá TT TB", "Định lượng", "Đơn vị", "Δ cost", "Δ %", "Nguồn", "Số dòng PR/PO"];
    const rows = analysis.rows.map((row) => [analysis.skuLabel, analysis.period, row.name, row.rawName, row.formulaPrice, row.actualPrice ?? "", row.dosage, row.unit, row.diffCost ?? "", row.diffPct ?? "", row.source, row.sampleCount]);
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
                          <div className="mt-0.5 truncate text-[10px] font-semibold text-white/35">{decimalMoney(row.dosage, 2)} {row.unit} · {row.source}</div>
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

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[430px] border-t border-white/10 bg-[#0b0908]/92 px-4 py-3 shadow-[0_-18px_50px_rgba(0,0,0,0.42)] backdrop-blur-xl md:max-w-[520px]">
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
    </div>
  );
}
