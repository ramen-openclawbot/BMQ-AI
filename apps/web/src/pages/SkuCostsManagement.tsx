import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_SKU_COST_TEMPLATE, DEFAULT_SKU_COST_VALUES, parseCostTemplate, parseCostValues, toNumber } from "@/lib/sku-cost-template";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { isFinishedSku } from "@/lib/skuType";
import { SkuCostMenuBar } from "@/components/sku-costs/SkuCostMenuBar";

type SKU = any;
type FormulaRow = any;
type PriceMode = "latest" | "avg30" | "avg90";
type WidgetLine = { name: string; amount: number };

type PurchasePoint = {
  sku_id: string;
  unit_price: number;
  date: string;
  sourceType: "po" | "pr";
  sourceId: string;
  sourceLabel: string;
};

const sb = supabase as any;
const vnd = (value: number) => new Intl.NumberFormat("vi-VN").format(value || 0);
const pad = (n: number, len: number) => String(n).padStart(len, "0");
const formatYYMMDD = (d: string) => {
  const dt = new Date(d);
  return `${String(dt.getFullYear()).slice(-2)}${pad(dt.getMonth() + 1, 2)}${pad(dt.getDate(), 2)}`;
};

const WIDGET_CONFIG = [
  { key: "packaging", label: "Bao bì", targetCostKey: "packaging_cost" },
  { key: "direct_labor", label: "Nhân công trực tiếp sản xuất", targetCostKey: "labor_cost" },
  { key: "management", label: "Nhân sự quản lý", targetCostKey: "sga_cost" },
  { key: "delivery", label: "Giao hàng", targetCostKey: "delivery_cost" },
  { key: "other", label: "Chi phí khác", targetCostKey: "other_production_cost" },
] as const;

const parseWidgets = (raw: any) => {
  const data = raw && typeof raw === "object" ? raw : {};
  const out: Record<string, WidgetLine[]> = {};
  WIDGET_CONFIG.forEach((w) => {
    const arr = Array.isArray(data[w.key]) ? data[w.key] : [];
    out[w.key] = arr.map((x: any) => ({ name: String(x?.name || ""), amount: toNumber(x?.amount, 0) }));
  });
  return out;
};

const pickPrice = (points: PurchasePoint[], mode: PriceMode) => {
  if (!points.length) return { price: 0, source: null as PurchasePoint | null };
  const sorted = [...points].sort((a, b) => +new Date(b.date) - +new Date(a.date));
  if (mode === "latest") return { price: toNumber(sorted[0].unit_price), source: sorted[0] };
  const days = mode === "avg30" ? 30 : 90;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = sorted.filter((p) => +new Date(p.date) >= cutoff);
  const base = inWindow.length ? inWindow : sorted;
  return {
    price: base.reduce((s, p) => s + toNumber(p.unit_price), 0) / Math.max(1, base.length),
    source: sorted[0],
  };
};

const parseLocaleNumber = (value: unknown, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (value === null || value === undefined) return fallback;

  let s = String(value).trim();
  if (!s) return fallback;
  s = s.replace(/\s+/g, "");

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(/,/g, ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  } else if (hasDot) {
    s = /\.\d{3}$/.test(s) ? s.replace(/\./g, "") : s;
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeUnitName = (u: unknown) => String(u || "").trim().toLowerCase();

const buildMaterialCode = (name: unknown) => {
  const normalized = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return `NVL-${normalized || "CHUA-DAT-TEN"}`;
};

const convertAmountByUnit = (amount: number, fromUnit: unknown, toUnit: unknown) => {
  const from = normalizeUnitName(fromUnit);
  const to = normalizeUnitName(toUnit);
  if (!from || !to || from === to) return amount;

  const weightToGram: Record<string, number> = { kg: 1000, kí: 1000, ký: 1000, g: 1, gram: 1 };
  const volumeToMl: Record<string, number> = { l: 1000, lit: 1000, litre: 1000, ml: 1 };

  if (weightToGram[from] && weightToGram[to]) {
    return amount * (weightToGram[from] / weightToGram[to]);
  }
  if (volumeToMl[from] && volumeToMl[to]) {
    return amount * (volumeToMl[from] / volumeToMl[to]);
  }
  return amount;
};

const FORMULA_BASE_QTY = 100;

const parseDosageGramInput = (value: unknown, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;

  // Rule nghiệp vụ: có dấu phẩy => số thập phân gram (2,234 => 2.234g)
  if (raw.includes(",")) {
    const normalized = raw.replace(/\./g, "").replace(/,/g, ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : fallback;
  }

  // Không có phẩy => hiểu là số nguyên gram (2234 => 2234g)
  const normalized = raw.replace(/[.,]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeScannedIngredient = (row: any) => {
  let unit = normalizeUnitName(row.unit || row.uom || "g");
  let unitPrice = parseLocaleNumber(row.unit_price ?? row.price ?? row.don_gia, 0);
  let dosageQty = parseDosageGramInput(row.dosage_qty ?? row.quantity ?? row.dinh_luong, 0);
  let lineCost = parseLocaleNumber(row.line_cost ?? row.gia_von ?? row.cost, 0);

  // Heuristic: OCR often swaps Đơn giá and Định lượng for this sheet
  if (unit === "g" && unitPrice > 500 && dosageQty > 0 && dosageQty < 200) {
    const tmp = unitPrice;
    unitPrice = dosageQty;
    dosageQty = tmp;
  }

  if (unit === "kg" || unit === "kilogram" || unit === "kí" || unit === "ký") {
    dosageQty = convertAmountByUnit(dosageQty, unit, "g");
    unitPrice = unitPrice / 1000;
    unit = "g";
  }

  // If unit is gram but price looks like price/kg, convert to VND/g
  if (unit === "g" && unitPrice >= 1000) unitPrice = unitPrice / 1000;

  // Use line cost to repair unit price when OCR reads line_cost into đơn giá (e.g. Muối 210)
  if (lineCost > 0 && dosageQty > 0) {
    const expected = unitPrice * dosageQty;
    const mismatch = Math.abs(expected - lineCost) / Math.max(1, lineCost);
    if (mismatch > 0.2) {
      unitPrice = lineCost / dosageQty;
    }
  }

  if (lineCost <= 0) lineCost = unitPrice * dosageQty;

  return {
    ingredient_name: row.ingredient_name || row.name || row.product_name || "",
    unit,
    unit_price: unitPrice,
    dosage_qty: dosageQty,
    line_cost: lineCost,
  };
};

const LEVEL2_SEPARATOR = " > ";

const splitStoredFormulaName = (name: unknown) => {
  const raw = String(name || "").trim();
  const idx = raw.indexOf(LEVEL2_SEPARATOR);
  if (idx <= 0) return null;
  const level1 = raw.slice(0, idx).trim();
  const level2 = raw.slice(idx + LEVEL2_SEPARATOR.length).trim();
  if (!level1 || !level2) return null;
  return { level1, level2 };
};

const isStoredLevel2FormulaRow = (row: any) => !!splitStoredFormulaName(row?.ingredient_name);

const computeDraftLineCost = (row: any) => toNumber(row?.line_cost, toNumber(row?.unit_price, 0) * toNumber(row?.dosage_qty, 0));

const toDraftRow = (row: any, overrides: Record<string, any> = {}) => {
  const dosageQty = parseDosageGramInput(overrides.dosage_qty ?? row?.dosage_qty, 0);
  const unitPrice = toNumber(overrides.unit_price ?? row?.unit_price, 0);
  const lineCost = toNumber(overrides.line_cost, unitPrice * dosageQty);
  return {
    is_level2: overrides.is_level2 ?? false,
    level1_sku_id: overrides.level1_sku_id ?? row?.ingredient_sku_id ?? "",
    ingredient_sku_id: overrides.ingredient_sku_id ?? row?.ingredient_sku_id ?? "",
    level1_name: overrides.level1_name ?? row?.ingredient_name ?? "",
    level2_name: overrides.level2_name ?? "",
    ingredient_name: overrides.ingredient_name ?? row?.ingredient_name ?? "",
    material_code: overrides.material_code ?? row?.material_code ?? buildMaterialCode(overrides.ingredient_name ?? row?.ingredient_name),
    unit: overrides.unit ?? row?.unit ?? "g",
    unit_price: unitPrice,
    unit_price_input: overrides.unit_price_input ?? (unitPrice === 0 ? "" : String(unitPrice)),
    dosage_qty: dosageQty,
    dosage_input: overrides.dosage_input ?? (dosageQty === 0 ? "" : String(dosageQty).replace(".", ",")),
    line_cost: lineCost,
  };
};

const buildDraftFromStoredRows = (rows: any[]) => {
  const groups = new Map<string, { order: number; parent: any | null; children: any[] }>();

  rows.forEach((row: any, idx: number) => {
    const parsed = splitStoredFormulaName(row?.ingredient_name);
    const level1 = parsed?.level1 || String(row?.ingredient_name || "").trim();
    if (!level1) return;
    const group = groups.get(level1) || { order: toNumber(row?.sort_order, idx + 1), parent: null, children: [] };
    group.order = Math.min(group.order, toNumber(row?.sort_order, idx + 1));
    if (parsed) {
      group.children.push({ ...row, level2_name: parsed.level2 });
    } else {
      group.parent = row;
    }
    groups.set(level1, group);
  });

  return Array.from(groups.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .flatMap(([level1, group]) => {
      const childRows = [...group.children].sort((a, b) => toNumber(a?.sort_order, 0) - toNumber(b?.sort_order, 0));
      const childBatchQty = childRows.reduce((sum, row) => sum + parseDosageGramInput(row?.dosage_qty, 0), 0);
      const childBatchCost = childRows.reduce((sum, row) => sum + toNumber(row?.unit_price, 0) * parseDosageGramInput(row?.dosage_qty, 0), 0);
      const parentUnitPrice = childBatchQty > 0 ? childBatchCost / childBatchQty : toNumber(group.parent?.unit_price, 0);
      const parentDosage = group.parent ? parseDosageGramInput(group.parent?.dosage_qty, 0) : childBatchQty;

      const parentRow = toDraftRow(group.parent || {}, {
        is_level2: false,
        level1_sku_id: group.parent?.ingredient_sku_id || "",
        ingredient_sku_id: group.parent?.ingredient_sku_id || "",
        level1_name: level1,
        ingredient_name: level1,
        unit: group.parent?.unit || "g",
        unit_price: parentUnitPrice,
        dosage_qty: parentDosage,
        line_cost: parentUnitPrice * parentDosage,
      });

      const draftChildren = childRows.map((row) => toDraftRow(row, {
        is_level2: true,
        ingredient_sku_id: row?.ingredient_sku_id || "",
        level1_name: level1,
        level2_name: row?.level2_name || "",
        ingredient_name: `${level1}${row?.level2_name ? `${LEVEL2_SEPARATOR}${row.level2_name}` : ""}`,
        unit: row?.unit || "g",
        unit_price: toNumber(row?.unit_price, 0),
        dosage_qty: parseDosageGramInput(row?.dosage_qty, 0),
      }));

      return [parentRow, ...draftChildren];
    });
};

export default function SkuCostsManagement() {
  const { toast } = useToast();
  const [skus, setSkus] = useState<SKU[]>([]);
  const [formula, setFormula] = useState<FormulaRow[]>([]);
  const [activeSkuId, setActiveSkuId] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [priceMode, setPriceMode] = useState<PriceMode>("latest");
  const [searchByRow, setSearchByRow] = useState<Record<string, string>>({});
  const [purchasePoints, setPurchasePoints] = useState<PurchasePoint[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<string, number>>(new Map());
  const [isScanningSkuImage, setIsScanningSkuImage] = useState(false);
  const [scanSkuMessage, setScanSkuMessage] = useState<string>("");
  const [importedFormulaDraft, setImportedFormulaDraft] = useState<any[]>([]);
  const [isSavingSku, setIsSavingSku] = useState(false);
  const [saveSkuError, setSaveSkuError] = useState<string>("");
  const skuImageInputRef = useRef<HTMLInputElement | null>(null);

  const [skuForm, setSkuForm] = useState<any>({
    id: "", sku_code: "", product_name: "", unit: "gói", unit_price: 0, category: "Thành phẩm", base_unit: "gói", yield_percent: 100,
    finished_output_qty: FORMULA_BASE_QTY, finished_output_unit: "cái", cost_template: DEFAULT_SKU_COST_TEMPLATE, cost_values: DEFAULT_SKU_COST_VALUES,
    cost_widgets: {}, hide_from_dealer_portal: false,
  });


  const activeSku = useMemo(() => skus.find((s) => s.id === activeSkuId) || {}, [skus, activeSkuId]);
  const finishedSkus = useMemo(() => skus.filter((s) => isFinishedSku(s as any)), [skus]);
  const ingredientSkus = useMemo(() => skus.filter((s) => !isFinishedSku(s as any)), [skus]);
  const costTemplate = useMemo(() => parseCostTemplate(activeSku.cost_template), [activeSku.cost_template]);
  const costValues = useMemo(() => parseCostValues(activeSku.cost_values), [activeSku.cost_values]);
  const widgetValues = useMemo(() => parseWidgets(activeSku.cost_widgets), [activeSku.cost_widgets]);

  const loadAll = async () => {
    const [skuRes, poRes, prRes, invRes] = await Promise.all([
      sb.from("product_skus").select("id,sku_code,product_name,category,unit,unit_price,updated_at,supplier_id,sku_type,notes,cost_values,cost_widgets,cost_template,finished_output_qty,finished_output_unit,created_at,created_by,hide_from_dealer_portal").order("updated_at", { ascending: false }),
      sb.from("purchase_order_items").select("sku_id, unit_price, created_at, purchase_order_id, purchase_orders(po_number, order_date)").not("sku_id", "is", null).limit(500),
      sb.from("payment_request_items").select("sku_id, unit_price, created_at, payment_request_id, payment_requests(request_number)").not("sku_id", "is", null).limit(500),
      sb.from("inventory_batches").select("sku_id, quantity").not("sku_id", "is", null).limit(500),
    ]);

    const pp: PurchasePoint[] = [
      ...((poRes.data || []).map((x: any) => ({
        sku_id: x.sku_id, unit_price: toNumber(x.unit_price), date: x.purchase_orders?.order_date || x.created_at,
        sourceType: "po" as const, sourceId: x.purchase_order_id, sourceLabel: x.purchase_orders?.po_number || x.purchase_order_id,
      }))),
      ...((prRes.data || []).map((x: any) => ({
        sku_id: x.sku_id, unit_price: toNumber(x.unit_price), date: x.created_at,
        sourceType: "pr" as const, sourceId: x.payment_request_id, sourceLabel: x.payment_requests?.request_number || x.payment_request_id,
      }))),
    ].filter((x) => x.sku_id);

    const inv = new Map<string, number>();
    (invRes.data || []).forEach((x: any) => inv.set(x.sku_id, (inv.get(x.sku_id) || 0) + toNumber(x.quantity, 0)));

    setPurchasePoints(pp);
    setInventoryMap(inv);
    setSkus(skuRes.data || []);

    const requestedSkuId = new URLSearchParams(window.location.search).get("sku") || "";
    const firstFinishedSku = (skuRes.data || []).find((s: any) => isFinishedSku(s));
    const requestedSku = requestedSkuId ? (skuRes.data || []).find((s: SKU) => s.id === requestedSkuId) : null;
    const currentSku = requestedSku?.id || activeSkuId || firstFinishedSku?.id || skuRes.data?.[0]?.id;
    if (currentSku) {
      setActiveSkuId(currentSku);
      if (requestedSku?.id) setDetailOpen(true);
      const { data: fRows } = await sb.from("sku_formulations").select("*").eq("sku_id", currentSku).order("sort_order");
      setFormula(fRows || []);
    }
  };

  useEffect(() => {
    (async () => {
      try { await sb.rpc("snapshot_sku_costs_daily", { p_snapshot_date: new Date().toISOString().slice(0, 10) }); } catch (_) {}
      loadAll();
    })();
    /* eslint-disable-next-line */
  }, []);
  useEffect(() => {
    if (!activeSkuId) return;
    (async () => {
      const { data: fRows } = await sb.from("sku_formulations").select("*").eq("sku_id", activeSkuId).order("sort_order");
      setFormula(fRows || []);
    })();
  }, [activeSkuId]);

  const priceMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof pickPrice>>();
    skus.forEach((s) => {
      const points = purchasePoints.filter((p) => p.sku_id === s.id);
      map.set(s.id, pickPrice(points, priceMode));
    });
    return map;
  }, [skus, purchasePoints, priceMode]);

  const formulaComputed = useMemo(() => formula
    .filter((r) => !isStoredLevel2FormulaRow(r))
    .map((r) => {
      const selectedSku = skus.find((s) => s.id === r.ingredient_sku_id);
      const market = r.ingredient_sku_id ? priceMap.get(r.ingredient_sku_id) : null;
      const standardUnitPrice = toNumber(r.unit_price, 0);
      const actualUnitPrice = market?.price || standardUnitPrice;
      const dosage = toNumber(r.dosage_qty, 0);

      const priceUnit = selectedSku?.unit || r.unit || "";
      const dosageInPriceUnit = convertAmountByUnit(dosage, r.unit || "", priceUnit);
      const standardLineCost = standardUnitPrice * dosageInPriceUnit;
      const actualLineCost = actualUnitPrice * dosageInPriceUnit;

      return {
        ...r,
        displayUnit: priceUnit,
        displayName: selectedSku?.product_name || r.ingredient_name || "",
        displayCode: selectedSku?.sku_code || "",
        currentStock: r.ingredient_sku_id ? toNumber(inventoryMap.get(r.ingredient_sku_id), 0) : 0,
        standardUnitPrice,
        resolvedUnitPrice: actualUnitPrice,
        standardLineCost,
        lineCost: actualLineCost,
        varianceLineCost: actualLineCost - standardLineCost,
        source: market?.source,
      };
    }), [formula, skus, priceMap, inventoryMap]);

  const importedOutputQty = Math.max(1, toNumber(skuForm.finished_output_qty, FORMULA_BASE_QTY));

  const importedDraftComputed = useMemo(() => importedFormulaDraft.map((r, idx) => {
    const level1 = String(r.level1_name || "").trim();
    const isLevel1Row = !r.is_level2;
    const childRows = importedFormulaDraft.filter((x, j) => j !== idx && x.is_level2 && String(x.level1_name || "").trim() === level1);
    const hasChildren = isLevel1Row && level1 && childRows.length > 0;

    const childBatchQty = childRows.reduce((sum, child) => sum + toNumber(child.dosage_qty, 0), 0);
    const childBatchCost = childRows.reduce((sum, child) => sum + computeDraftLineCost(child), 0);
    const parentDosage = toNumber(r.dosage_qty, 0);
    const derivedUnitPrice = childBatchQty > 0 ? childBatchCost / childBatchQty : 0;
    const displayUnitPrice = hasChildren ? derivedUnitPrice : toNumber(r.unit_price, 0);
    const displayDosage = parentDosage;
    const lineCost = hasChildren ? displayUnitPrice * displayDosage : computeDraftLineCost(r);
    const perUnit = Math.round(lineCost / importedOutputQty);

    return {
      ...r,
      level1,
      isLevel1Row,
      childRows,
      hasChildren,
      childBatchQty,
      childBatchCost,
      displayUnitPrice,
      displayDosage,
      lineCost,
      perUnit,
    };
  }), [importedFormulaDraft, importedOutputQty]);

  const importedMaterialSummary = useMemo(() => {
    const total = importedDraftComputed.reduce((sum, row) => {
      if (!row.isLevel1Row) return sum;
      const name = String(row.level1_name || row.ingredient_name || "").trim();
      if (!name) return sum;
      return sum + row.lineCost;
    }, 0);

    return { total, perUnit: Math.round(total / importedOutputQty) };
  }, [importedDraftComputed, importedOutputQty]);

  const level1Options = useMemo(() => {
    const seen = new Set<string>();
    return importedFormulaDraft
      .filter((r) => !r.is_level2)
      .map((r) => String(r.level1_name || "").trim())
      .filter((name) => {
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
  }, [importedFormulaDraft]);

  const selectedLevel1ForLevel2 = level1Options[level1Options.length - 1] || "";
  const suggestedLaborCost = toNumber(costValues?.labor_cost, 0);

  const missingScanFields = useMemo(() => {
    const missing: string[] = [];
    if (!String(skuForm.product_name || "").trim()) missing.push("Tên món");
    if (!String(skuForm.sku_code || "").trim()) missing.push("Mã SKU");
    if (!toNumber(skuForm.finished_output_qty, 0)) missing.push("Thành phẩm SL");
    if (!String(skuForm.finished_output_unit || "").trim()) missing.push("Thành phẩm ĐVT");
    if (!importedFormulaDraft.length) missing.push("Danh sách nguyên vật liệu");
    // Giá bán có thể nhập sau, không chặn lưu SKU
    return missing;
  }, [skuForm, importedFormulaDraft]);

  const costing = useMemo(() => {
    const outputQty = Math.max(1, Number(activeSku.finished_output_qty || FORMULA_BASE_QTY));
    const totalMaterialCostBatch = formulaComputed.reduce((sum, row) => sum + row.lineCost, 0);
    const totalMaterialCost = totalMaterialCostBatch / outputQty;
    const provisionPercent = toNumber(costValues.material_provision_percent, 0);
    const provisionAmount = (totalMaterialCost * provisionPercent) / 100;
    const totalCostNVL = totalMaterialCost + provisionAmount;
    const nonMaterialCost = costTemplate.filter((l) => l.mode === "amount" && l.key !== "selling_price").reduce((sum, l) => sum + toNumber(costValues[l.key], 0), 0);
    const totalCost = totalCostNVL + nonMaterialCost;
    const sellingPrice = toNumber(costValues.selling_price, 0);
    const netProfit = sellingPrice - totalCost;
    const netProfitPct = sellingPrice > 0 ? (netProfit / sellingPrice) * 100 : 0;
    const pctOnCost = (v: number) => (totalCost > 0 ? (v / totalCost) * 100 : 0);
    return { outputQty, totalMaterialCost, provisionAmount, totalCostNVL, totalCost, sellingPrice, netProfit, netProfitPct, pctOnCost };
  }, [activeSku, formulaComputed, costTemplate, costValues]);

  const detailCosting = useMemo(() => {
    const outputQty = Math.max(1, Number(activeSku.finished_output_qty || FORMULA_BASE_QTY));
    const materialBatch = formulaComputed.reduce((sum, row) => sum + toNumber(row.standardLineCost, 0), 0);
    const materialPerUnit = Math.round(materialBatch / outputQty);
    const provisionPercent = toNumber(costValues.material_provision_percent, 0);
    const totalCostNVLPerUnit = materialPerUnit * (1 + provisionPercent / 100);
    const totalCostPerUnit = totalCostNVLPerUnit
      + toNumber(costValues.packaging_cost, 0)
      + toNumber(costValues.labor_cost, 0)
      + toNumber(costValues.delivery_cost, 0)
      + toNumber(costValues.other_production_cost, 0)
      + toNumber(costValues.sga_cost, 0);
    const sellingPrice = toNumber(costValues.selling_price, 0);
    const netProfitPerUnit = sellingPrice - totalCostPerUnit;
    const netProfitPct = sellingPrice > 0 ? (netProfitPerUnit / sellingPrice) * 100 : 0;

    return {
      outputQty,
      materialBatch,
      materialPerUnit,
      totalCostNVLPerUnit,
      totalCostPerUnit,
      sellingPrice,
      netProfitPerUnit,
      netProfitPct,
    };
  }, [activeSku.finished_output_qty, formulaComputed, costValues]);

  const standardVsActual = useMemo(() => {
    const outputQty = Math.max(1, Number(activeSku.finished_output_qty || FORMULA_BASE_QTY));
    const standardBatch = formulaComputed.reduce((sum, row) => sum + toNumber(row.standardLineCost, 0), 0);
    const actualBatch = formulaComputed.reduce((sum, row) => sum + toNumber(row.lineCost, 0), 0);
    const standardPerUnit = standardBatch / outputQty;
    const actualPerUnit = actualBatch / outputQty;
    return {
      standardPerUnit,
      actualPerUnit,
      variancePerUnit: actualPerUnit - standardPerUnit,
    };
  }, [activeSku.finished_output_qty, formulaComputed]);

  const openCreateSku = () => { setScanSkuMessage(""); setSaveSkuError(""); setImportedFormulaDraft([]); setSkuForm({ id: "", sku_code: "", product_name: "", unit: "gói", unit_price: 0, category: "Thành phẩm", base_unit: "gói", yield_percent: 100, finished_output_qty: FORMULA_BASE_QTY, finished_output_unit: "cái", cost_template: DEFAULT_SKU_COST_TEMPLATE, cost_values: DEFAULT_SKU_COST_VALUES, cost_widgets: {}, hide_from_dealer_portal: false }); setDialogOpen(true); };
  const openSkuDetail = (sku: SKU) => { setActiveSkuId(sku.id); setDetailOpen(true); };

  const buildFormulaRowsFromDraft = (skuId: string) => {
    const rows: any[] = [];
    const level1Rows = importedFormulaDraft.filter((r: any) => !r.is_level2 && String(r.level1_name || r.ingredient_name || "").trim());

    level1Rows.forEach((r: any) => {
      const level1 = String(r.level1_name || r.ingredient_name || "").trim();
      const childRows = importedFormulaDraft.filter((x: any) => x.is_level2 && String(x.level1_name || "").trim() === level1 && String(x.level2_name || "").trim());
      const matchLevel1 = ingredientSkus.find((s) => s.id === (r.level1_sku_id || r.ingredient_sku_id)) || ingredientSkus.find((s) => {
        const n = level1.toLowerCase();
        const t = `${s.sku_code} ${s.product_name}`.toLowerCase();
        return t.includes(n) || n.includes(String(s.product_name || "").toLowerCase());
      });

      if (childRows.length > 0) {
        const childBatchQty = childRows.reduce((sum: number, child: any) => sum + parseDosageGramInput(child.dosage_input ?? child.dosage_qty, 0), 0);
        const childBatchCost = childRows.reduce((sum: number, child: any) => sum + computeDraftLineCost(child), 0);
        const parentUnitPrice = childBatchQty > 0 ? childBatchCost / childBatchQty : toNumber(r.unit_price, 0);
        const parentDosageQty = parseDosageGramInput(r.dosage_input ?? r.dosage_qty, 0);

        const parentIngredientName = matchLevel1?.product_name || level1;
        rows.push({
          sku_id: skuId,
          ingredient_sku_id: matchLevel1?.id || null,
          ingredient_name: parentIngredientName,
          material_code: buildMaterialCode(parentIngredientName),
          unit: "g",
          unit_price: parentUnitPrice,
          dosage_qty: parentDosageQty,
          wastage_percent: 0,
          sort_order: rows.length + 1,
        });

        childRows.forEach((child: any) => {
          const level2 = String(child.level2_name || "").trim();
          const ingredientLabel = `${level1}${LEVEL2_SEPARATOR}${level2}`;
          const matchedChild = ingredientSkus.find((s) => s.id === child.ingredient_sku_id) || ingredientSkus.find((s) => {
            const n = ingredientLabel.toLowerCase();
            const t = `${s.sku_code} ${s.product_name}`.toLowerCase();
            return t.includes(n) || n.includes(String(s.product_name || "").toLowerCase());
          });

          rows.push({
            sku_id: skuId,
            ingredient_sku_id: matchedChild?.id || null,
            ingredient_name: ingredientLabel,
            material_code: buildMaterialCode(ingredientLabel),
            unit: "g",
            unit_price: toNumber(child.unit_price, 0),
            dosage_qty: parseDosageGramInput(child.dosage_input ?? child.dosage_qty, 0),
            wastage_percent: 0,
            sort_order: rows.length + 1,
          });
        });
        return;
      }

      const ingredientName = matchLevel1?.product_name || level1;
      rows.push({
        sku_id: skuId,
        ingredient_sku_id: matchLevel1?.id || null,
        ingredient_name: ingredientName,
        material_code: buildMaterialCode(ingredientName),
        unit: "g",
        unit_price: toNumber(r.unit_price, 0),
        dosage_qty: parseDosageGramInput(r.dosage_input ?? r.dosage_qty, 0),
        wastage_percent: 0,
        sort_order: rows.length + 1,
      });
    });

    return rows;
  };

  const openEditSku = async (sku: SKU) => {
    setSaveSkuError("");
    setSkuForm({ ...sku, hide_from_dealer_portal: Boolean(sku.hide_from_dealer_portal), cost_template: parseCostTemplate(sku.cost_template), cost_values: parseCostValues(sku.cost_values), cost_widgets: parseWidgets(sku.cost_widgets) });
    const { data } = await sb.from("sku_formulations").select("*").eq("sku_id", sku.id).order("sort_order");
    setImportedFormulaDraft(buildDraftFromStoredRows(data || []));
    setDialogOpen(true);
  };

  const saveSku = async () => {
    if (isSavingSku) return;
    setSaveSkuError("");

    if (!skuForm.sku_code || !skuForm.product_name) {
      const msg = "Cần có mã SKU và tên món để lưu.";
      setSaveSkuError(msg);
      toast({ title: "Thiếu dữ liệu", description: msg });
      return;
    }

    setIsSavingSku(true);

    try {
      if (skuForm.id) {
        const { error } = await sb.from("product_skus").update({ ...skuForm, sku_type: "finished_good" }).eq("id", skuForm.id);
        if (error) throw error;

        const rows = buildFormulaRowsFromDraft(skuForm.id);
        const { error: deleteFormulaError } = await sb.from("sku_formulations").delete().eq("sku_id", skuForm.id);
        if (deleteFormulaError) throw deleteFormulaError;
        if (rows.length > 0) {
          const { error: formulaError } = await sb.from("sku_formulations").insert(rows);
          if (formulaError) throw formulaError;
        }

        try {
          await sb.from("sku_trace_documents").insert({
            sku_id: skuForm.id,
            document_type: "audit",
            document_name: `EDIT_COST_${new Date().toISOString()}`,
            document_url: `audit://sku/${skuForm.id}/edit`,
          });
        } catch (_) {}

        toast({ title: "Đã cập nhật SKU" });
      } else {
        const { id: _unusedId, ...skuInsertPayload } = skuForm;
        const { data, error } = await sb.from("product_skus").insert({ ...skuInsertPayload, sku_type: "finished_good" }).select("*").single();
        if (error) throw error;

        if (data?.id) {
          setActiveSkuId(data.id);
          try {
            await sb.from("sku_trace_documents").insert({
              sku_id: data.id,
              document_type: "audit",
              document_name: `CREATE_COST_${new Date().toISOString()}`,
              document_url: `audit://sku/${data.id}/create`,
            });
          } catch (_) {}

          const rows = buildFormulaRowsFromDraft(data.id);
          if (rows.length > 0) {
            const { error: formulaError } = await sb.from("sku_formulations").insert(rows);
            if (formulaError) throw formulaError;
          }
        }

        toast({ title: "SKU đã tạo thành công", description: "Đã cập nhật ngay danh sách SKU thành phẩm." });
        setScanSkuMessage("SKU đã tạo thành công và đã cập nhật danh sách.");
      }

      setDialogOpen(false);
      setImportedFormulaDraft([]);
      loadAll();
    } catch (e: any) {
      const msg = e?.message || "Có lỗi khi lưu dữ liệu, anh thử lại giúp Ramen.";
      setSaveSkuError(msg);
      console.error("saveSku failed", e);
      toast({ title: "Lưu SKU thất bại", description: msg });
    } finally {
      setIsSavingSku(false);
    }
  };

  const openCreateSkuFromImage = () => {
    skuImageInputRef.current?.click();
  };

  const addDraftMaterialRow = () => {
    setImportedFormulaDraft((prev) => [
      ...prev,
      { is_level2: false, level1_sku_id: "", ingredient_sku_id: "", level1_name: "", level2_name: "", ingredient_name: "", material_code: buildMaterialCode(""), unit: "g", unit_price: 0, dosage_qty: 0, dosage_input: "", line_cost: 0 },
    ]);
  };

  const addDraftMaterialLevel2Row = () => {
    const parentLevel1 = (selectedLevel1ForLevel2 || level1Options[0] || "").trim();
    if (!parentLevel1) return;
    setImportedFormulaDraft((prev) => {
      const next = [...prev];
      const parentIdx = next.findIndex((x) => !x.is_level2 && String(x.level1_name || "").trim() === parentLevel1);
      const insertIdx = parentIdx >= 0
        ? next.reduce((last, row, i) => (String(row.level1_name || "").trim() === parentLevel1 ? i : last), parentIdx) + 1
        : next.length;

      next.splice(insertIdx, 0, { is_level2: true, level1_sku_id: "", ingredient_sku_id: "", level1_name: parentLevel1, level2_name: "", ingredient_name: `${parentLevel1} > `, material_code: buildMaterialCode(`${parentLevel1} > `), unit: "g", unit_price: 0, dosage_qty: 0, dosage_input: "", line_cost: 0 });
      return next;
    });
  };

  const applyScannedDataToForm = (d: any) => {
    const ingredients = Array.isArray(d.ingredients) ? d.ingredients : Array.isArray(d.items) ? d.items : [];
    const draftRows = ingredients
      .map((r: any) => normalizeScannedIngredient(r))
      .filter((x: any) => x.ingredient_name)
      .map((x: any) => ({ ...x, is_level2: false, level1_name: x.ingredient_name, level2_name: "", material_code: buildMaterialCode(x.ingredient_name), dosage_input: String(x.dosage_qty).replace(".", ",") }));
    setImportedFormulaDraft(draftRows);

    const productName = d.product_name || d.ten_mon || "SKU từ ảnh";
    const scannedOutputQty = parseLocaleNumber(d.finished_output_qty ?? d.output_qty ?? d.thanh_pham_sl, 1);
    const outputUnit = d.finished_output_unit || d.output_unit || d.thanh_pham_dvt || "cái";

    // Auto-correct common OCR miss: missing "SL thành phẩm" causes cost/unit inflated
    const estimatedTotalMaterial = draftRows.reduce((s: number, r: any) => s + toNumber(r.line_cost, toNumber(r.unit_price, 0) * toNumber(r.dosage_qty, 0)), 0);
    const outputQty = scannedOutputQty <= 1 && estimatedTotalMaterial >= 10000 ? 100 : scannedOutputQty;

    setSkuForm({
      id: "",
      sku_code: d.sku_code || `TP-${productName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 16) || "AUTO"}-001`,
      product_name: productName,
      unit: outputUnit,
      category: "Thành phẩm",
      sku_type: "finished_good",
      base_unit: outputUnit,
      yield_percent: 100,
      finished_output_qty: outputQty,
      finished_output_unit: outputUnit,
      cost_template: DEFAULT_SKU_COST_TEMPLATE,
      cost_values: {
        ...DEFAULT_SKU_COST_VALUES,
        material_provision_percent: parseLocaleNumber(d.material_provision_percent ?? d.provision_percent, 0),
        packaging_cost: parseLocaleNumber(d.packaging_cost, 0),
        labor_cost: parseLocaleNumber(d.labor_cost, 0),
        delivery_cost: parseLocaleNumber(d.delivery_cost, 0),
        other_production_cost: parseLocaleNumber(d.other_production_cost, 0),
        sga_cost: parseLocaleNumber(d.sga_cost ?? d.management_cost, 0),
        selling_price: parseLocaleNumber(d.selling_price ?? d.sale_price, 0),
      },
      cost_widgets: {},
    });

    setDialogOpen(true);
    setScanSkuMessage("");
  };

  const handleScanSkuCostImage = async (file?: File | null) => {
    if (!file) return;
    setScanSkuMessage("");

    // Optional session: use token if available, otherwise call as anon
    let accessToken = "";
    const { data: sessionData } = await sb.auth.getSession();
    if (sessionData.session) {
      const expiresAt = Number(sessionData.session.expires_at || 0) * 1000;
      const shouldRefresh = !expiresAt || expiresAt - Date.now() < 60_000;
      if (shouldRefresh) {
        const { data: refreshed } = await sb.auth.refreshSession();
        accessToken = refreshed?.session?.access_token || "";
      } else {
        accessToken = sessionData.session.access_token;
      }
    }

    setIsScanningSkuImage(true);
    try {
      const imageBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file);
      });

      const edge = await callEdgeFunction<any>(
        "scan-sku-cost-sheet",
        { imageBase64, mimeType: file.type },
        accessToken,
        90000
      );

      if (edge.error || !edge.data?.success) {
        throw new Error(edge.error || "Load failed");
      }

      const data = edge.data.data || {};
      applyScannedDataToForm({
        product_name: data.product_name || "SKU từ ảnh",
        sku_code: data.sku_code,
        finished_output_qty: data.finished_output_qty,
        finished_output_unit: data.finished_output_unit,
        material_provision_percent: data.material_provision_percent,
        packaging_cost: data.packaging_cost,
        labor_cost: data.labor_cost,
        delivery_cost: data.delivery_cost,
        other_production_cost: data.other_production_cost,
        sga_cost: data.sga_cost,
        selling_price: data.selling_price,
        ingredients: (data.ingredients || []).map((x: any) => ({
          ingredient_name: x.ingredient_name,
          unit: x.unit,
          unit_price: x.unit_price,
          dosage_qty: x.dosage_qty,
          line_cost: x.line_cost,
        })),
      });
    } catch (e: any) {
      const raw = String(e?.message || "Lỗi không xác định");
      const msg = raw.includes("CONFIG_MISSING_OPENAI_API_KEY") || raw.includes("OPENAI_API_KEY")
        ? "Thiếu AI key trên server (OPENAI_API_KEY). Vui lòng cấu hình để dùng scan ảnh."
        : raw;
      setScanSkuMessage(`Scan thất bại: ${msg}`);
      toast({ title: "Không scan được ảnh", description: msg, variant: "destructive" });
    } finally {
      setIsScanningSkuImage(false);
    }
  };

  const addFormula = async () => { if (!activeSkuId) return; await sb.from("sku_formulations").insert({ sku_id: activeSkuId, ingredient_name: "NVL mới", material_code: buildMaterialCode("NVL mới"), unit: "kg", unit_price: 0, dosage_qty: 0, wastage_percent: 0, sort_order: formula.length + 1 }); loadAll(); };
  const updateFormulaRow = async (r: any, patch: any) => { await sb.from("sku_formulations").update(patch).eq("id", r.id); loadAll(); };
  const removeFormulaRow = async (id: string) => { await sb.from("sku_formulations").delete().eq("id", id); loadAll(); };
  const removeSku = async (sku: any) => {
    if (!window.confirm(`Xóa SKU ${sku.sku_code} - ${sku.product_name}?`)) return;
    await sb.from("sku_formulations").delete().eq("sku_id", sku.id);
    await sb.from("sku_trace_documents").insert({
      sku_id: sku.id,
      document_type: "audit",
      document_name: `DELETE_SKU_${new Date().toISOString()}`,
      document_url: `audit://sku/${sku.id}/delete`,
    });
    await sb.from("product_skus").delete().eq("id", sku.id);
    toast({ title: "Đã xóa SKU" });
    loadAll();
  };

  const updateCostValue = async (key: string, value: number) => {
    if (!activeSkuId) return;
    const next = { ...costValues, [key]: value };
    await sb.from("product_skus").update({ cost_values: next }).eq("id", activeSkuId);
    setSkus((prev) => prev.map((sku) => (sku.id === activeSkuId ? { ...sku, cost_values: next } : sku)));
  };

  const syncWidgetToMain = async (widgetKey: string, lines: WidgetLine[]) => {
    const conf = WIDGET_CONFIG.find((w) => w.key === widgetKey);
    if (!conf || !activeSkuId) return;
    const sum = lines.reduce((s, x) => s + toNumber(x.amount), 0);
    const nextWidgets = { ...widgetValues, [widgetKey]: lines };
    const nextCostValues = { ...costValues, [conf.targetCostKey]: sum };
    await sb.from("product_skus").update({ cost_widgets: nextWidgets, cost_values: nextCostValues }).eq("id", activeSkuId);
    setSkus((prev) => prev.map((sku) => sku.id === activeSkuId ? { ...sku, cost_widgets: nextWidgets, cost_values: nextCostValues } : sku));
  };

  return (
    <div className="space-y-4 px-1 sm:space-y-6 sm:px-0">
      <SkuCostMenuBar />
      <h1 className="text-xl font-bold tracking-[-0.02em] sm:text-2xl">Quản trị SKU thành phẩm</h1>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-lg sm:text-xl">Danh sách SKU thành phẩm</CardTitle>
          <div className="flex gap-2"><Button className="h-11 w-full sm:h-10 sm:w-auto" onClick={openCreateSku}>Tạo SKU</Button></div>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          <div className="hidden md:block">
            <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead>Giá bán</TableHead><TableHead>Trang đặt hàng</TableHead><TableHead>Chỉnh sửa lúc</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>
              {finishedSkus.map((s) => <TableRow key={s.id}><TableCell className="font-mono">{s.sku_code}</TableCell><TableCell><button className="text-left underline decoration-dotted underline-offset-4 hover:text-primary transition-colors" onClick={() => openSkuDetail(s)}>{s.product_name}</button></TableCell><TableCell>{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</TableCell><TableCell className="text-xs">{s.hide_from_dealer_portal ? <span className="rounded bg-muted px-2 py-1 text-muted-foreground">Đang ẩn</span> : <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-800">Đang hiện</span>}</TableCell><TableCell className="text-xs">{s.updated_at ? new Date(s.updated_at).toLocaleString("vi-VN") : "-"}</TableCell><TableCell><div className="flex gap-2 justify-end"><Button variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button><Button variant="destructive" size="sm" onClick={() => removeSku(s)}>Xóa</Button></div></TableCell></TableRow>)}
              {finishedSkus.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">Chưa có SKU thành phẩm.</TableCell></TableRow>}
            </TableBody></Table>
          </div>
          <div className="space-y-3 md:hidden">
            {finishedSkus.map((s) => {
              const sellingPrice = toNumber(parseCostValues(s.cost_values).selling_price, 0);
              return (
                <article key={s.id} className="rounded-2xl border bg-card p-3 shadow-sm">
                  <button className="block w-full text-left" onClick={() => openSkuDetail(s)}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[11px] font-bold text-muted-foreground">{s.sku_code || s.id}</p>
                        <h2 className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug text-foreground">{s.product_name}</h2>
                      </div>
                      {s.hide_from_dealer_portal ? <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">Đang ẩn</span> : <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">Đang hiện</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl bg-muted/45 p-2">
                        <div className="text-muted-foreground">Giá bán</div>
                        <div className="mt-1 text-base font-bold text-primary">{vnd(sellingPrice)}</div>
                      </div>
                      <div className="rounded-xl bg-muted/45 p-2">
                        <div className="text-muted-foreground">Cập nhật</div>
                        <div className="mt-1 font-semibold text-foreground">{s.updated_at ? new Date(s.updated_at).toLocaleString("vi-VN") : "-"}</div>
                      </div>
                    </div>
                  </button>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button className="h-10" variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button>
                    <Button className="h-10" variant="destructive" size="sm" onClick={() => removeSku(s)}>Xóa</Button>
                  </div>
                </article>
              );
            })}
            {finishedSkus.length === 0 && <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Chưa có SKU thành phẩm.</div>}
          </div>
        </CardContent>
      </Card>

      {/* Đã tắt scan ảnh theo yêu cầu: nhập NVL thủ công */}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl p-4 sm:max-w-6xl sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-lg leading-tight sm:text-xl">Chi tiết SKU</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-4">
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Tên SKU</div><div className="font-semibold mt-1 leading-snug break-words">{activeSku.product_name || "-"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Mã SKU</div><div className="font-mono mt-1 break-all">{activeSku.sku_code || "-"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Thành phẩm</div><div className="mt-1">{toNumber(activeSku.finished_output_qty, FORMULA_BASE_QTY)} {activeSku.finished_output_unit || "cái"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Giá bán/cái</div><div className="font-semibold mt-1">{vnd(toNumber(costValues.selling_price, 0))}</div></div>
          </div>

          <div className="mt-4 rounded border">
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Mã NVL</TableHead>
                  <TableHead>NVL</TableHead>
                  <TableHead>ĐVT</TableHead>
                  <TableHead>Đơn giá</TableHead>
                  <TableHead>Định lượng</TableHead>
                  <TableHead>Cost NVL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {formulaComputed.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">Chưa có dữ liệu NVL</TableCell></TableRow>
                ) : formulaComputed.map((r: any) => (
                  <TableRow key={r.id || `${r.ingredient_name}-${r.sort_order}`}>
                    <TableCell className="font-mono text-xs">{r.material_code || buildMaterialCode(r.displayName || r.ingredient_name)}</TableCell>
                    <TableCell>{r.displayName || r.ingredient_name || "-"}</TableCell>
                    <TableCell>{r.unit || "g"}</TableCell>
                    <TableCell>{vnd(toNumber(r.unit_price, 0))}</TableCell>
                    <TableCell>{toNumber(r.dosage_qty, 0)}</TableCell>
                    <TableCell>{vnd(toNumber(r.standardLineCost, 0))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="space-y-3 p-3 md:hidden">
              {formulaComputed.length === 0 ? (
                <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">Chưa có dữ liệu NVL</div>
              ) : formulaComputed.map((r) => {
                const materialCode = r.material_code || buildMaterialCode(r.displayName || r.ingredient_name);
                return (
                  <article key={r.id || `${r.ingredient_name}-${r.sort_order}`} className="rounded-2xl border bg-card p-3 text-sm shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-[11px] font-semibold text-muted-foreground">{materialCode}</p>
                        <h3 className="mt-1 line-clamp-2 font-semibold leading-snug text-foreground">{r.displayName || r.ingredient_name || "-"}</h3>
                      </div>
                      <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">{r.unit || "g"}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl bg-muted/45 p-2"><div className="text-muted-foreground">Đơn giá</div><div className="mt-1 font-bold text-foreground">{vnd(toNumber(r.unit_price, 0))}</div></div>
                      <div className="rounded-xl bg-muted/45 p-2"><div className="text-muted-foreground">Định lượng</div><div className="mt-1 font-bold text-foreground">{toNumber(r.dosage_qty, 0)}</div></div>
                      <div className="col-span-2 rounded-xl bg-primary/10 p-2"><div className="text-primary/80">Cost NVL</div><div className="mt-1 text-base font-bold text-primary">{vnd(toNumber(r.standardLineCost, 0))}</div></div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 text-sm mt-4 sm:grid-cols-2 md:grid-cols-3">
            <div className="rounded border p-3">Total material cost/mẻ: <b>{vnd(detailCosting.materialBatch)}</b></div>
            <div className="rounded border p-3">Total material cost/cái: <b>{vnd(detailCosting.materialPerUnit)}</b></div>
            <div className="rounded border p-3">Total cost NVL/cái: <b>{vnd(detailCosting.totalCostNVLPerUnit)}</b></div>
            <div className="rounded border p-3">Tổng cost/cái: <b>{vnd(detailCosting.totalCostPerUnit)}</b></div>
            <div className="rounded border p-3">Net profit/cái: <b>{vnd(detailCosting.netProfitPerUnit)}</b></div>
            <div className="rounded border p-3">Net profit (%): <b>{Number(detailCosting.netProfitPct || 0).toFixed(2)}%</b></div>
            <div className="rounded border p-3">Cập nhật: <b>{activeSku.updated_at ? new Date(activeSku.updated_at).toLocaleString("vi-VN") : "-"}</b></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl p-4 sm:max-w-5xl sm:p-6">
          <DialogHeader>
            <DialogTitle>{skuForm.id ? "Sửa SKU" : "Tạo SKU theo form mẫu"}</DialogTitle>
            {skuForm.id && <div className="text-xs text-muted-foreground">Lần chỉnh sửa gần nhất: {skuForm.updated_at ? new Date(skuForm.updated_at).toLocaleString("vi-VN") : "-"}</div>}
          </DialogHeader>

          <div className="space-y-4">
            <div className="sticky top-0 z-20 flex flex-col gap-2 rounded-xl border bg-background/95 p-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:flex-wrap sm:items-center">
              <Button type="button" className="h-11 w-full sm:h-10 sm:w-auto" variant="outline" onClick={addDraftMaterialRow}>+ Thêm NVL cấp 1</Button>
              {level1Options.length > 0 && (
                <Button type="button" className="h-11 w-full sm:h-10 sm:w-auto" variant="outline" onClick={addDraftMaterialLevel2Row}>+ Thêm NVL cấp 2</Button>
              )}
            </div>
            {missingScanFields.length > 0 ? (
              <div className="text-sm rounded border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
                Thiếu dữ liệu: {missingScanFields.join(", ")}. Anh có thể nhập tay rồi bấm Lưu SKU.
              </div>
            ) : (
              <div className="text-sm rounded border border-emerald-300 bg-emerald-50 text-emerald-800 px-3 py-2">
                Dữ liệu đã đủ để tạo SKU. Anh kiểm tra lại và bấm Lưu SKU.
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div className="space-y-1 md:col-span-1"><Label>Tên món</Label><Input className="h-11" value={skuForm.product_name || ""} onChange={(e) => setSkuForm({ ...skuForm, product_name: e.target.value })} /></div>
              <div className="space-y-1"><Label>Mã SKU thành phẩm</Label><Input className="h-11" value={skuForm.sku_code || ""} onChange={(e) => setSkuForm({ ...skuForm, sku_code: e.target.value })} /></div>
              <div className="space-y-1"><Label>Thành phẩm ĐVT</Label><Input className="h-11" value={skuForm.finished_output_unit || "cái"} onChange={(e) => setSkuForm({ ...skuForm, finished_output_unit: e.target.value })} /></div>
              <div className="space-y-1"><Label>Sản lượng thành phẩm / mẻ</Label><Input className="h-11" type="number" min={1} value={skuForm.finished_output_qty ?? FORMULA_BASE_QTY} onChange={(e) => setSkuForm({ ...skuForm, finished_output_qty: Math.max(1, Number(e.target.value || FORMULA_BASE_QTY)) })} /></div>
            </div>
            <label className="flex items-start gap-3 rounded border bg-muted/30 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-primary"
                checked={Boolean(skuForm.hide_from_dealer_portal)}
                onChange={(event) => setSkuForm({ ...skuForm, hide_from_dealer_portal: event.target.checked })}
              />
              <span>
                <span className="block font-medium">Ẩn SKU này trên trang đặt hàng đại lý</span>
                <span className="mt-1 block text-muted-foreground">Khi bật, SKU vẫn còn trong Giá vốn nhưng không xuất hiện trên dathang.banhmique.vn.</span>
              </span>
            </label>

            <div className="rounded border">
              <Table className="hidden md:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Loại</TableHead><TableHead>Mã NVL</TableHead><TableHead>Tên NVL</TableHead><TableHead>Đơn giá (VNĐ)</TableHead><TableHead>Định lượng</TableHead><TableHead>Giá vốn (VNĐ)</TableHead><TableHead>Đơn giá vốn/cái (VNĐ)</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedFormulaDraft.length === 0 && (
                    <TableRow><TableCell colSpan={8} className="text-muted-foreground">Chưa có dòng NVL. Anh bấm “+ Thêm NVL cấp 1” để nhập thủ công.</TableCell></TableRow>
                  )}
                  {importedDraftComputed.map((row, idx) => {
                    const r = row;
                    const isLevel1Row = row.isLevel1Row;
                    const hasChildren = row.hasChildren;
                    const displayUnitPrice = row.displayUnitPrice;
                    const displayDosage = row.displayDosage;
                    const lineCost = row.lineCost;
                    const perUnit = row.perUnit;

                    return (
                      <TableRow key={`draft-table-${idx}`} className={isLevel1Row ? "" : "bg-muted/30"}>
                        <TableCell>{isLevel1Row ? "NVL cấp 1" : <span className="pl-5">↳ NVL cấp 2 ({r.level1_name || "-"})</span>}</TableCell>
                        <TableCell className="font-mono text-xs">{buildMaterialCode(isLevel1Row ? (r.level1_name || r.ingredient_name) : `${r.level1_name || ""}${r.level2_name ? `${LEVEL2_SEPARATOR}${r.level2_name}` : ""}`)}</TableCell>
                        <TableCell>
                          <Input
                            list={isLevel1Row ? `level1-sku-options-table-${idx}` : `level2-sku-options-table-${idx}`}
                            value={isLevel1Row ? (r.level1_name || "") : (r.level2_name || "")}
                            className={isLevel1Row ? "" : "ml-5"}
                            placeholder={isLevel1Row ? "Gõ để tìm NVL cấp 1" : "Gõ để tìm NVL cấp 2"}
                            onChange={(e) => {
                              const keyword = e.target.value;
                              const picked = ingredientSkus.find((s) => `${s.sku_code} - ${s.product_name}` === keyword || s.product_name === keyword || s.sku_code === keyword);
                              const next = [...importedFormulaDraft];

                              if (isLevel1Row) {
                                const level1Name = picked?.product_name || keyword;
                                next[idx] = {
                                  ...next[idx],
                                  level1_sku_id: picked?.id || "",
                                  level1_name: level1Name,
                                  ingredient_name: level1Name,
                                };
                              } else {
                                const level2Name = picked?.product_name || keyword;
                                const unit = String(picked?.unit || r.unit || "g");
                                next[idx] = {
                                  ...next[idx],
                                  ingredient_sku_id: picked?.id || "",
                                  level2_name: level2Name,
                                  ingredient_name: `${next[idx].level1_name || ""}${level2Name ? ` > ${level2Name}` : ""}`,
                                  unit,
                                };
                              }

                              setImportedFormulaDraft(next);
                            }}
                          />
                          <datalist id={isLevel1Row ? `level1-sku-options-table-${idx}` : `level2-sku-options-table-${idx}`}>
                            {ingredientSkus.map((s) => <option key={s.id} value={`${s.sku_code} - ${s.product_name}`} />)}
                          </datalist>
                        </TableCell>
                        {/* DVT cố định gram theo nghiệp vụ */}
                        <TableCell><Input disabled={hasChildren} value={hasChildren ? String(Math.round(displayUnitPrice * 1000) / 1000) : (r.unit_price_input ?? (toNumber(r.unit_price, 0) === 0 ? "" : String(toNumber(r.unit_price, 0))))} onChange={(e) => { const next = [...importedFormulaDraft]; const unit_price_input = e.target.value; const unit_price = unit_price_input === "" ? 0 : Number(unit_price_input); const dosage_qty = toNumber(next[idx].dosage_qty, 0); next[idx] = { ...next[idx], unit_price_input, unit_price: Number.isFinite(unit_price) ? unit_price : 0, line_cost: (Number.isFinite(unit_price) ? unit_price : 0) * dosage_qty }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell><Input value={displayDosage === 0 ? "" : String(displayDosage).replace(".", ",")} onChange={(e) => { const next = [...importedFormulaDraft]; const dosage_input = e.target.value; const dosage_qty = dosage_input === "" ? 0 : parseDosageGramInput(dosage_input, 0); const unit_price = toNumber(next[idx].unit_price, 0); next[idx] = { ...next[idx], dosage_input, dosage_qty, line_cost: unit_price * dosage_qty }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell>{vnd(lineCost)}</TableCell>
                        <TableCell>{vnd(perUnit)}</TableCell>
                        <TableCell>
                          <Button type="button" size="sm" variant="destructive" onClick={() => setImportedFormulaDraft((prev) => prev.filter((_, i) => i !== idx))}>Xóa</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="space-y-3 p-3 md:hidden">
                {importedFormulaDraft.length === 0 && (
                  <div className="text-sm text-muted-foreground">Chưa có dòng NVL. Anh bấm “+ Thêm NVL cấp 1” để nhập thủ công.</div>
                )}
                {importedDraftComputed.map((row, idx) => {
                  const r = row;
                  const isLevel1Row = row.isLevel1Row;
                  const hasChildren = row.hasChildren;
                  const displayUnitPrice = row.displayUnitPrice;
                  const displayDosage = row.displayDosage;
                  const lineCost = row.lineCost;
                  const perUnit = row.perUnit;

                  return (
                    <div key={`draft-card-${idx}`} className={`rounded-2xl border p-3 shadow-sm ${isLevel1Row ? "bg-background" : "bg-muted/30"}`}>
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                          {isLevel1Row ? "NVL cấp 1" : `NVL cấp 2 · ${r.level1_name || "-"}`}
                        </span>
                        <span className="min-w-0 flex-1 break-all rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                          {buildMaterialCode(isLevel1Row ? (r.level1_name || r.ingredient_name) : `${r.level1_name || ""}${r.level2_name ? `${LEVEL2_SEPARATOR}${r.level2_name}` : ""}`)}
                        </span>
                        <Button type="button" className="h-9 shrink-0" size="sm" variant="destructive" onClick={() => setImportedFormulaDraft((prev) => prev.filter((_, i) => i !== idx))}>Xóa</Button>
                      </div>

                      <div className="space-y-1">
                        <Label>Tên NVL</Label>
                        <Input
                          className="h-11"
                          list={isLevel1Row ? `level1-sku-options-mobile-${idx}` : `level2-sku-options-mobile-${idx}`}
                          value={isLevel1Row ? (r.level1_name || "") : (r.level2_name || "")}
                          placeholder={isLevel1Row ? "Gõ để tìm NVL cấp 1" : "Gõ để tìm NVL cấp 2"}
                          onChange={(e) => {
                            const keyword = e.target.value;
                            const picked = ingredientSkus.find((s) => `${s.sku_code} - ${s.product_name}` === keyword || s.product_name === keyword || s.sku_code === keyword);
                            const next = [...importedFormulaDraft];

                            if (isLevel1Row) {
                              const level1Name = picked?.product_name || keyword;
                              next[idx] = {
                                ...next[idx],
                                level1_sku_id: picked?.id || "",
                                level1_name: level1Name,
                                ingredient_name: level1Name,
                              };
                            } else {
                              const level2Name = picked?.product_name || keyword;
                              const unit = String(picked?.unit || r.unit || "g");
                              next[idx] = {
                                ...next[idx],
                                ingredient_sku_id: picked?.id || "",
                                level2_name: level2Name,
                                ingredient_name: `${next[idx].level1_name || ""}${level2Name ? ` > ${level2Name}` : ""}`,
                                unit,
                              };
                            }

                            setImportedFormulaDraft(next);
                          }}
                        />
                        <datalist id={isLevel1Row ? `level1-sku-options-mobile-${idx}` : `level2-sku-options-mobile-${idx}`}>
                          {ingredientSkus.map((s) => <option key={s.id} value={`${s.sku_code} - ${s.product_name}`} />)}
                        </datalist>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label>Đơn giá (VNĐ)</Label>
                          <Input className="h-11" disabled={hasChildren} value={hasChildren ? String(Math.round(displayUnitPrice * 1000) / 1000) : (r.unit_price_input ?? (toNumber(r.unit_price, 0) === 0 ? "" : String(toNumber(r.unit_price, 0))))} onChange={(e) => { const next = [...importedFormulaDraft]; const unit_price_input = e.target.value; const unit_price = unit_price_input === "" ? 0 : Number(unit_price_input); const dosage_qty = toNumber(next[idx].dosage_qty, 0); next[idx] = { ...next[idx], unit_price_input, unit_price: Number.isFinite(unit_price) ? unit_price : 0, line_cost: (Number.isFinite(unit_price) ? unit_price : 0) * dosage_qty }; setImportedFormulaDraft(next); }} />
                        </div>
                        <div className="space-y-1">
                          <Label>Định lượng</Label>
                          <Input className="h-11" value={displayDosage === 0 ? "" : String(displayDosage).replace(".", ",")} onChange={(e) => { const next = [...importedFormulaDraft]; const dosage_input = e.target.value; const dosage_qty = dosage_input === "" ? 0 : parseDosageGramInput(dosage_input, 0); const unit_price = toNumber(next[idx].unit_price, 0); next[idx] = { ...next[idx], dosage_input, dosage_qty, line_cost: unit_price * dosage_qty }; setImportedFormulaDraft(next); }} />
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                        <div className="rounded-md bg-muted/50 p-2">
                          <div className="text-xs text-muted-foreground">Giá vốn</div>
                          <div className="font-semibold">{vnd(lineCost)}</div>
                        </div>
                        <div className="rounded-md bg-muted/50 p-2">
                          <div className="text-xs text-muted-foreground">Đơn giá vốn/cái</div>
                          <div className="font-semibold">{vnd(perUnit)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="text-sm text-muted-foreground">Ghi chú: NVL được tính bằng Gram. Sản lượng thành phẩm / mẻ mặc định là 100 nhưng có thể chỉnh theo từng SKU. Chi phí NVL tổng hợp tự động cộng toàn bộ dòng NVL hợp lệ.</div>

            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
              <div className="p-3 rounded border bg-muted/30">Chi phí NVL tổng hợp: <b>{vnd(importedMaterialSummary.total)}</b></div>
              <div className="space-y-2 p-3 rounded border bg-muted/30"><Label>Dự phòng hao hụt/tăng giá (%)</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.material_provision_percent, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.material_provision_percent, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), material_provision_percent: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-yellow-50 text-yellow-900">Total cost NVL/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) + ((importedMaterialSummary.perUnit || 0) * toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100))}</b></div>
              <div className="space-y-2 p-3 rounded border"><Label>Cost bao bì/cái</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.packaging_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.packaging_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), packaging_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="space-y-2 p-3 rounded border"><div className="flex flex-wrap items-center justify-between gap-2"><Label>Cost nhân công/cái</Label><Button type="button" variant="outline" size="sm" onClick={() => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), labor_cost: suggestedLaborCost } })}>Lấy từ quản trị</Button></div><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.labor_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.labor_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), labor_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="space-y-2 p-3 rounded border"><Label>Delivery/cái</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.delivery_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.delivery_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), delivery_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="space-y-2 p-3 rounded border"><Label>Other production/cái</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.other_production_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.other_production_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), other_production_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="space-y-2 p-3 rounded border"><Label>BH&QL/cái</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.sga_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.sga_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), sga_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-red-50 text-red-700">Tổng cost/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0))}</b></div>
              <div className="space-y-2 p-3 rounded border"><Label>Giá bán/cái</Label><Input className="h-11 md:h-8" type="number" value={toNumber(skuForm.cost_values?.selling_price, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.selling_price, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), selling_price: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-sky-50 text-sky-700">Net profit/cái: <b>{vnd(toNumber(skuForm.cost_values?.selling_price, 0) - ((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0)))}</b></div>
            </div>
          </div>

          {saveSkuError && (
            <div className="text-sm rounded border border-red-300 bg-red-50 text-red-700 px-3 py-2">
              Lưu SKU lỗi: {saveSkuError}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" className="h-11 w-full sm:w-auto" onClick={saveSku} disabled={isSavingSku}>
              {isSavingSku ? "Đang lưu..." : "Lưu SKU"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
