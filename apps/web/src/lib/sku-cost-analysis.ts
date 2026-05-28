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

const numberValue = (value: unknown) => Number(value || 0);

const parsePackSizeInFormulaUnits = (value: string) => {
  const normalized = normalizeIngredientName(value);
  const multiPackKg = normalized.match(/(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*kg/);
  if (multiPackKg) return Number(multiPackKg[1].replace(",", ".")) * Number(multiPackKg[2].replace(",", ".")) * 1000;

  const matches = Array.from(String(value || "").toLowerCase().matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b/g));
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  if (unit === "kg" || unit === "l") return amount * 1000;
  return amount;
};

const parseExplicitDivisorFromNote = (note?: string | null) => {
  const normalizedNote = String(note || "").replace(/,/g, ".");
  const matches = Array.from(normalizedNote.matchAll(/\/\s*(\d+(?:\.\d+)?)/g));
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const inferPurchaseUnitDivisor = (purchase: ActualCostPurchase, ingredientName: string) => {
  const unit = normalizeIngredientName(purchase.unit || "");
  const productText = `${purchase.product_name || ""} ${purchase.product_code || ""}`;
  const combined = normalizeIngredientName(`${productText} ${purchase.unit || ""} ${ingredientName}`);

  // The source unit is the strongest signal: if the PR says kg/l/g/ml, convert that unit directly.
  // Only use mapping notes such as /25000 or /400 for package units (bao/thùng/chai/gói/trứng...).
  if (unit === "kg" || unit === "kilogram") return 1000;
  if (unit === "g" || unit === "gram") return 1;
  if (unit === "l" || unit === "lit" || unit === "liter" || unit === "litre") return 1000;
  if (unit === "ml") return 1;

  const noteDivisor = parseExplicitDivisorFromNote(purchase.unit_conversion_note);
  if (noteDivisor) return noteDivisor;

  const packSize = parsePackSizeInFormulaUnits(productText);
  if (unit.includes("trung") || unit.includes("qua") || unit.includes("cai") || combined.includes("trung") || combined.includes("egg")) return packSize || 60;
  if (packSize) return packSize;
  if (combined.includes("2l x 6") || combined.includes("thung dau huong duong")) return 12000;
  if (combined.includes("0 5x10kg") || combined.includes("men kho ngot mauripan") || combined.includes("men kho")) return 10000;
  if (combined.includes("whipping cream") || combined.includes("whiping cream") || combined.includes("kem sua whipping")) return 1000;
  if (combined.includes("bo buttery") || combined.includes("bo imperial")) return 970;
  if (combined.includes("giam") && combined.includes("chai")) return 400;
  if (combined.includes("kg") || combined.includes("cha bong") || combined.includes("duong") || combined.includes("muoi")) return 1000;
  return 1;
};

const purchaseAmount = (purchase: ActualCostPurchase) => {
  const quantity = numberValue(purchase.quantity) || 1;
  const lineTotal = numberValue(purchase.line_total);
  if (lineTotal > 0) return lineTotal;
  return quantity * numberValue(purchase.unit_price);
};

const purchaseWeightInFormulaUnits = (purchase: ActualCostPurchase, ingredientName: string) => {
  const quantity = numberValue(purchase.quantity) || 1;
  const divisor = inferPurchaseUnitDivisor(purchase, ingredientName);
  const weight = quantity * divisor;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
};

const convertedPurchasePrice = (purchase: ActualCostPurchase, ingredientName: string) => {
  const weight = purchaseWeightInFormulaUnits(purchase, ingredientName);
  if (!weight) return null;
  const converted = purchaseAmount(purchase) / weight;
  return Number.isFinite(converted) && converted > 0 ? converted : null;
};

const averageConvertedPurchasePrice = (actualRows: ActualCostPurchase[], ingredientName: string) => {
  let totalAmount = 0;
  let totalWeight = 0;
  actualRows.forEach((purchase) => {
    const weight = purchaseWeightInFormulaUnits(purchase, ingredientName);
    if (!weight) return;
    totalAmount += purchaseAmount(purchase);
    totalWeight += weight;
  });
  return totalWeight > 0 ? totalAmount / totalWeight : null;
};

const latestConvertedPurchasePrice = (actualRows: ActualCostPurchase[], ingredientName: string, maxDate?: string) => {
  const eligibleRows = actualRows
    .filter((purchase) => !maxDate || String(purchase.paid_at || purchase.created_at || "").slice(0, 10) <= maxDate)
    .sort((a, b) => String(b.paid_at || b.created_at || "").localeCompare(String(a.paid_at || a.created_at || "")));
  for (const purchase of eligibleRows) {
    const converted = convertedPurchasePrice(purchase, ingredientName);
    if (converted !== null) return converted;
  }
  return null;
};

const isSuspiciousPrice = (actualPrice: number | null, formulaPrice: number) => {
  if (actualPrice === null || !Number.isFinite(actualPrice) || formulaPrice <= 0) return false;
  return Math.abs(actualPrice - formulaPrice) / formulaPrice >= 1;
};

const groupFormulaRowsByMaterial = (rows: FormulaRow[], materialContexts: Map<string, MaterialContext>) => {
  const grouped = new Map<string, { rows: FormulaRow[]; totalDosage: number; totalCost: number }>();
  rows.forEach((row) => {
    const materialCode = normalizeMaterialCode(row.material_code);
    const key = materialCode || `name:${normalizeIngredientName(row.ingredient_name)}`;
    const dosage = numberValue(row.dosage_qty) * (1 + numberValue(row.wastage_percent) / 100);
    const current = grouped.get(key) || { rows: [], totalDosage: 0, totalCost: 0 };
    current.rows.push(row);
    current.totalDosage += dosage;
    current.totalCost += numberValue(row.unit_price) * dosage;
    grouped.set(key, current);
  });

  return Array.from(grouped.values()).map(({ rows: groupedRows, totalDosage, totalCost }) => {
    const first = groupedRows[0];
    const materialContext = materialContextForRow(first, materialContexts);
    return {
      ...first,
      ingredient_name: materialContext?.canonicalName || chooseCanonicalFormulaName(groupedRows),
      dosage_qty: totalDosage,
      wastage_percent: 0,
      unit_price: totalDosage > 0 ? totalCost / totalDosage : first.unit_price,
    } satisfies FormulaRow;
  });
};

const isPaidOrControlledCost = (purchase: ActualCostPurchase) => {
  if (purchase.source === "payment_request") return purchase.payment_status === "paid" && Boolean(purchase.paid_at);
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
  source: "Mã NVL/PR" | "Giá CT fallback" | "Cảnh báo mapping/quy đổi";
  warning?: string | null;
  rawActualPrice?: number | null;
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
  const rawSkuFormulas = formulas.filter((row) => row.sku_id === sku.id && !String(row.ingredient_name || "").includes(" > "));
  const materialContexts = buildMaterialContexts(formulas.filter((row) => !String(row.ingredient_name || "").includes(" > ")));
  const skuFormulas = groupFormulaRowsByMaterial(rawSkuFormulas, materialContexts);
  const controlledPurchases = purchases.filter(isPaidOrControlledCost);
  const monthPurchases = controlledPurchases.filter((purchase) => toMonth(purchase.paid_at || purchase.created_at) === period);
  const purchasesForRow = (row: FormulaRow, scope: "month" | "all", maxDate?: string) =>
    (scope === "month" ? monthPurchases : controlledPurchases).filter((purchase) => {
      const purchaseDate = String(purchase.paid_at || purchase.created_at || "").slice(0, 10);
      if (maxDate && purchaseDate > maxDate) return false;
      return purchaseMatchesFormulaRow(purchase, row, materialContexts);
    });

  const formulaBatchCost = skuFormulas.reduce((sum, row) => {
    const wastage = Number(row.wastage_percent || 0) / 100;
    return sum + Number(row.unit_price || 0) * Number(row.dosage_qty || 0) * (1 + wastage);
  }, 0);

  const rows = skuFormulas.map((row) => {
    const materialContext = materialContextForRow(row, materialContexts);
    const actualRows = purchasesForRow(row, "month");
    const purchasePrice = averageConvertedPurchasePrice(actualRows, row.ingredient_name);
    const formulaPrice = Number(row.unit_price || 0);
    const suspicious = isSuspiciousPrice(purchasePrice, formulaPrice);
    const actualPrice = purchasePrice === null || suspicious ? formulaPrice : purchasePrice;
    const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
    const diffCost = (actualPrice - formulaPrice) * dosage;
    const diffPct = formulaPrice === 0 ? null : ((actualPrice - formulaPrice) / formulaPrice) * 100;
    const rawDiffPct = purchasePrice === null || formulaPrice === 0 ? null : ((purchasePrice - formulaPrice) / formulaPrice) * 100;
    const warning = suspicious
      ? `Giá TB mua ${decimalMoney(purchasePrice)} lệch ${pct(rawDiffPct || 0)} so với giá công thức; app đã dùng giá công thức để tránh sai trend. Cần kiểm tra mapping/quy đổi.`
      : null;
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
      sampleCount: purchasePrice !== null ? actualRows.length : 0,
      source: suspicious ? "Cảnh báo mapping/quy đổi" : purchasePrice !== null ? "Mã NVL/PR" : "Giá CT fallback",
      warning,
      rawActualPrice: purchasePrice,
    } satisfies AnalysisRow;
  });

  const actualBatchCost = rows.reduce((sum, row) => sum + row.actualPrice * row.dosage, 0);
  const dateKeys = Array.from(new Set(monthPurchases.filter((purchase) => skuFormulas.some((row) => purchaseMatchesFormulaRow(purchase, row, materialContexts))).map((purchase) => String(purchase.paid_at || purchase.created_at || "").slice(0, 10)))).sort();
  const chartRows = dateKeys.map((dateKey) => {
    let matchedMaterials = 0;
    let usableMaterials = 0;
    const actualAtDate = skuFormulas.reduce((sum, row) => {
      const formulaPrice = Number(row.unit_price || 0);
      const dosage = Number(row.dosage_qty || 0) * (1 + Number(row.wastage_percent || 0) / 100);
      const actualRows = purchasesForRow(row, "all", dateKey).filter((purchase) => toMonth(purchase.paid_at || purchase.created_at) === period);
      const latestPrice = latestConvertedPurchasePrice(actualRows, row.ingredient_name, dateKey);
      if (latestPrice === null) return sum + formulaPrice * dosage;
      matchedMaterials += 1;
      if (isSuspiciousPrice(latestPrice, formulaPrice)) return sum + formulaPrice * dosage;
      usableMaterials += 1;
      return sum + latestPrice * dosage;
    }, 0);
    const coveragePct = skuFormulas.length ? (usableMaterials / skuFormulas.length) * 100 : 0;
    return {
      label: toDayLabel(dateKey),
      actual: actualAtDate / outputQty,
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
    matchedRows: rows.filter((row) => row.source === "Mã NVL/PR").length,
    totalRows: rows.length,
    rows,
    chartRows,
  };
};
