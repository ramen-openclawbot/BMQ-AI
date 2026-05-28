import type { ActualCostPurchase, FormulaRow } from "@/hooks/useSkuCostBridge";

export const money = (v: number) => new Intl.NumberFormat("vi-VN").format(Number(v || 0));
export const compactMoney = (v: number) => `${money(Math.round(Number(v || 0)))}đ`;
export const decimalMoney = (v: number | null, digits = 2) => (v === null ? "—" : Number(v || 0).toLocaleString("vi-VN", { minimumFractionDigits: 0, maximumFractionDigits: digits }));
export const pct = (v: number) => `${v > 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;
export const todayMonth = () => new Date().toISOString().slice(0, 7);
export const toMonth = (date: string) => String(date || "").slice(0, 7);
export const toDayLabel = (date: string) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return String(date || "N/A").slice(5, 10);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const normalizeIngredientName = (value: string) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[đĐ]/g, "d")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normalizeMaterialCode = (value?: string | null) =>
  String(value || "")
    .trim()
    .toUpperCase();

const purchaseStandardCostCodes = (purchase: ActualCostPurchase) =>
  [purchase.confirmed_standard_cost_code, purchase.suggested_standard_cost_code, purchase.standard_cost_code]
    .map(normalizeMaterialCode)
    .filter(Boolean);

type MaterialContext = {
  materialCode: string;
  canonicalName: string;
  skuIds: Set<string>;
  aliases: Set<string>;
};

const chooseCanonicalFormulaName = (rows: FormulaRow[]) => {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const name = String(row.ingredient_name || "").trim();
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || rows[0]?.ingredient_name || "NVL";
};

export const buildMaterialContexts = (formulas: FormulaRow[]) => {
  const rowsByMaterialCode = new Map<string, FormulaRow[]>();
  formulas.forEach((row) => {
    const code = normalizeMaterialCode(row.material_code);
    if (!code) return;
    const rows = rowsByMaterialCode.get(code) || [];
    rows.push(row);
    rowsByMaterialCode.set(code, rows);
  });

  const contexts = new Map<string, MaterialContext>();
  rowsByMaterialCode.forEach((rows, materialCode) => {
    const aliases = new Set<string>();
    const skuIds = new Set<string>();
    rows.forEach((row) => {
      const normalizedName = normalizeIngredientName(row.ingredient_name);
      if (normalizedName) aliases.add(normalizedName);
      if (row.ingredient_sku_id) skuIds.add(row.ingredient_sku_id);
    });
    contexts.set(materialCode, {
      materialCode,
      canonicalName: chooseCanonicalFormulaName(rows),
      skuIds,
      aliases,
    });
  });
  return contexts;
};

const materialContextForRow = (row: FormulaRow, materialContexts: Map<string, MaterialContext>) => {
  const materialCode = normalizeMaterialCode(row.material_code);
  return materialCode ? materialContexts.get(materialCode) || null : null;
};

const purchaseMatchesFormulaRow = (purchase: ActualCostPurchase, row: FormulaRow, materialContexts: Map<string, MaterialContext>) => {
  const materialContext = materialContextForRow(row, materialContexts);
  const rowMaterialCode = normalizeMaterialCode(row.material_code);
  const purchaseCodes = purchaseStandardCostCodes(purchase);
  if (rowMaterialCode && purchaseCodes.includes(rowMaterialCode)) return true;
  if (row.ingredient_sku_id && purchase.sku_id === row.ingredient_sku_id) return true;
  if (materialContext && purchase.sku_id && materialContext.skuIds.has(purchase.sku_id)) return true;

  const purchaseName = normalizeIngredientName(`${purchase.canonical_cost_item_name || ""} ${purchase.product_name || ""} ${purchase.product_code || ""}`);
  if (!purchaseName) return false;

  if (materialContext) {
    return Array.from(materialContext.aliases).some((alias) => alias.length >= 4 && purchaseName.includes(alias));
  }

  const fallbackAlias = normalizeIngredientName(row.ingredient_name);
  return fallbackAlias.length >= 4 && purchaseName.includes(fallbackAlias);
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

const averageConvertedPurchasePrice = (actualRows: ActualCostPurchase[], ingredientName: string) => {
  const prices = actualRows
    .map((purchase) => toFormulaUnitPurchasePrice(Number(purchase.unit_price || 0), `${purchase.product_name || ""} ${purchase.product_code || ""} ${purchase.unit || ""} ${ingredientName}`))
    .filter((value): value is number => value !== null);
  return prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
};

const latestConvertedPurchasePrice = (actualRows: ActualCostPurchase[], ingredientName: string, maxDate?: string) => {
  const eligibleRows = actualRows
    .filter((purchase) => !maxDate || String(purchase.created_at || "").slice(0, 10) <= maxDate)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  for (const purchase of eligibleRows) {
    const converted = toFormulaUnitPurchasePrice(Number(purchase.unit_price || 0), `${purchase.product_name || ""} ${purchase.product_code || ""} ${purchase.unit || ""} ${ingredientName}`);
    if (converted !== null) return converted;
  }
  return null;
};

const isPaidOrControlledCost = (purchase: ActualCostPurchase) => {
  if (purchase.source === "payment_request") return purchase.payment_status === "paid" || purchase.status === "approved";
  return true;
};

export type AnalysisRow = {
  name: string;
  rawName: string;
  materialCode: string | null;
  formulaPrice: number;
  actualPrice: number | null;
  dosage: number;
  unit: string;
  diffPct: number | null;
  diffCost: number | null;
  sampleCount: number;
  source: "Mã NVL/PR" | "Giá CT fallback";
};

export type SkuAnalysis = {
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
  chartRows: Array<{ label: string; actual: number | null; baseline: number; coveragePct: number; matchedMaterials: number; totalMaterials: number }>;
};

type SkuAnalysisInput = {
  id: string;
  product_name?: string | null;
  sku_code?: string | null;
  finished_output_qty?: number | string | null;
};

export const buildSkuAnalysis = ({ sku, formulas, purchases, period }: { sku: SkuAnalysisInput; formulas: FormulaRow[]; purchases: ActualCostPurchase[]; period: string }): SkuAnalysis => {
  const outputQty = Math.max(1, Number(sku?.finished_output_qty || 100));
  const skuFormulas = formulas.filter((row) => row.sku_id === sku.id && !String(row.ingredient_name || "").includes(" > "));
  const materialContexts = buildMaterialContexts(formulas.filter((row) => !String(row.ingredient_name || "").includes(" > ")));
  const controlledPurchases = purchases.filter(isPaidOrControlledCost);
  const monthPurchases = controlledPurchases.filter((purchase) => toMonth(purchase.created_at) === period);
  const purchasesForRow = (row: FormulaRow, scope: "month" | "all", maxDate?: string) =>
    (scope === "month" ? monthPurchases : controlledPurchases).filter((purchase) => {
      if (maxDate && String(purchase.created_at || "").slice(0, 10) > maxDate) return false;
      return purchaseMatchesFormulaRow(purchase, row, materialContexts);
    });
  const periodEndDate = `${period}-31`;

  const formulaBatchCost = skuFormulas.reduce((sum, row) => {
    const wastage = Number(row.wastage_percent || 0) / 100;
    return sum + Number(row.unit_price || 0) * Number(row.dosage_qty || 0) * (1 + wastage);
  }, 0);

  const rows = skuFormulas.map((row) => {
    const materialContext = materialContextForRow(row, materialContexts);
    const actualRows = purchasesForRow(row, "month");
    const allActualRows = purchasesForRow(row, "all", periodEndDate);
    const purchasePrice = averageConvertedPurchasePrice(actualRows, row.ingredient_name);
    const latestPurchasePrice = latestConvertedPurchasePrice(allActualRows, row.ingredient_name, periodEndDate);
    const actualPrice = purchasePrice ?? latestPurchasePrice ?? null;
    const formulaPrice = Number(row.unit_price || 0);
    const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
    const diffCost = actualPrice === null ? null : (actualPrice - formulaPrice) * dosage;
    const diffPct = actualPrice === null || formulaPrice === 0 ? null : ((actualPrice - formulaPrice) / formulaPrice) * 100;
    return {
      name: materialContext?.canonicalName || row.ingredient_name,
      rawName: row.ingredient_name,
      materialCode: normalizeMaterialCode(row.material_code) || null,
      formulaPrice,
      actualPrice,
      dosage,
      unit: row.unit || "",
      diffPct,
      diffCost,
      sampleCount: purchasePrice !== null ? actualRows.length : latestPurchasePrice !== null ? allActualRows.length : 0,
      source: purchasePrice !== null || latestPurchasePrice !== null ? "Mã NVL/PR" : "Giá CT fallback",
    } satisfies AnalysisRow;
  });

  const actualBatchCost = rows.reduce((sum, row) => sum + (row.actualPrice ?? row.formulaPrice) * row.dosage, 0);
  const dateKeys = Array.from(new Set(monthPurchases.filter((purchase) => skuFormulas.some((row) => purchaseMatchesFormulaRow(purchase, row, materialContexts))).map((purchase) => String(purchase.created_at || "").slice(0, 10)))).sort();
  const chartRows = dateKeys.map((dateKey) => {
    let matchedMaterials = 0;
    const actualAtDate = skuFormulas.reduce((sum, row) => {
      const actualRows = purchasesForRow(row, "all", dateKey);
      const latestPrice = latestConvertedPurchasePrice(actualRows, row.ingredient_name, dateKey);
      if (latestPrice === null) return sum;
      matchedMaterials += 1;
      const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
      return sum + latestPrice * dosage;
    }, 0);
    const coveragePct = skuFormulas.length ? (matchedMaterials / skuFormulas.length) * 100 : 0;
    return {
      label: toDayLabel(dateKey),
      actual: matchedMaterials > 0 ? actualAtDate / outputQty : null,
      baseline: formulaBatchCost / outputQty,
      coveragePct,
      matchedMaterials,
      totalMaterials: skuFormulas.length,
    };
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
