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
    cost_widgets: {},
  });


  const activeSku = useMemo(() => skus.find((s) => s.id === activeSkuId) || {}, [skus, activeSkuId]);
  const finishedSkus = useMemo(() => skus.filter((s) => isFinishedSku(s as any)), [skus]);
  const ingredientSkus = useMemo(() => skus.filter((s) => !isFinishedSku(s as any)), [skus]);
  const costTemplate = useMemo(() => parseCostTemplate(activeSku.cost_template), [activeSku.cost_template]);
  const costValues = useMemo(() => parseCostValues(activeSku.cost_values), [activeSku.cost_values]);
  const widgetValues = useMemo(() => parseWidgets(activeSku.cost_widgets), [activeSku.cost_widgets]);

  const loadAll = async () => {
    const [skuRes, poRes, prRes, invRes] = await Promise.all([
      sb.from("product_skus").select("*").order("updated_at", { ascending: false }),
      sb.from("purchase_order_items").select("sku_id, unit_price, created_at, purchase_order_id, purchase_orders(po_number, order_date)").not("sku_id", "is", null),
      sb.from("payment_request_items").select("sku_id, unit_price, created_at, payment_request_id, payment_requests(request_number)").not("sku_id", "is", null),
      sb.from("inventory_batches").select("sku_id, quantity").not("sku_id", "is", null),
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

    const firstFinishedSku = (skuRes.data || []).find((s: any) => isFinishedSku(s));
    const currentSku = activeSkuId || firstFinishedSku?.id || skuRes.data?.[0]?.id;
    if (currentSku) {
      setActiveSkuId(currentSku);
      const { data: fRows } = await sb.from("sku_formulations").select("*").eq("sku_id", currentSku).order("sort_order");
      setFormula(fRows || []);
    }
  };

  useEffect(() => {
    (async () => {
      try { await sb.rpc("snapshot_sku_costs_daily", { p_snapshot_date: new Date().toISOString().slice(0, 10) }); } catch (_) {}
      try { await ensureBmcbSampleSku(); } catch (e) { console.error("ensureBmcbSampleSku failed", e); }
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

  const formulaComputed = useMemo(() => formula.map((r) => {
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

  const importedMaterialSummary = useMemo(() => {
    const total = importedFormulaDraft.reduce((sum, r) => {
      const name = String(r.level2_name || r.level1_name || r.ingredient_name || "").trim();
      if (!name) return sum;
      const lineCost = toNumber(r.line_cost, toNumber(r.unit_price, 0) * toNumber(r.dosage_qty, 0));
      return sum + lineCost;
    }, 0);

    return { total, perUnit: Math.round(total / importedOutputQty) };
  }, [importedFormulaDraft, importedOutputQty]);

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

  const openCreateSku = () => { setScanSkuMessage(""); setSaveSkuError(""); setImportedFormulaDraft([]); setSkuForm({ id: "", sku_code: "", product_name: "", unit: "gói", unit_price: 0, category: "Thành phẩm", base_unit: "gói", yield_percent: 100, finished_output_qty: FORMULA_BASE_QTY, finished_output_unit: "cái", cost_template: DEFAULT_SKU_COST_TEMPLATE, cost_values: DEFAULT_SKU_COST_VALUES, cost_widgets: {} }); setDialogOpen(true); };
  const openSkuDetail = (sku: SKU) => { setActiveSkuId(sku.id); setDetailOpen(true); };

  const buildFormulaRowsFromDraft = (skuId: string) => {
    const rowsToSave = importedFormulaDraft.filter((r: any, idx: number) => {
      const level1 = String(r.level1_name || "").trim();
      if (r.is_level2) return !!String(r.level2_name || "").trim();
      if (!level1) return false;
      const hasChildren = importedFormulaDraft.some((x: any, j: number) => j !== idx && x.is_level2 && String(x.level1_name || "").trim() === level1);
      return !hasChildren;
    });

    return rowsToSave.map((r: any, idx: number) => {
      const level1 = String(r.level1_name || r.ingredient_name || "").trim();
      const level2 = String(r.level2_name || "").trim();
      const ingredientLabel = level2 ? `${level1} > ${level2}` : level1;
      const n = ingredientLabel.toLowerCase();
      const matched = ingredientSkus.find((s) => s.id === (r.ingredient_sku_id || r.level1_sku_id)) || ingredientSkus.find((s) => {
        const t = `${s.sku_code} ${s.product_name}`.toLowerCase();
        return t.includes(n) || n.includes(String(s.product_name || "").toLowerCase());
      });

      return {
        sku_id: skuId,
        ingredient_sku_id: matched?.id || null,
        ingredient_name: matched?.product_name || ingredientLabel,
        unit: "g",
        unit_price: toNumber(r.unit_price, 0),
        dosage_qty: parseDosageGramInput(r.dosage_input ?? r.dosage_qty, 0),
        wastage_percent: 0,
        sort_order: idx + 1,
      };
    });
  };

  const openEditSku = async (sku: SKU) => {
    setSaveSkuError("");
    setSkuForm({ ...sku, cost_template: parseCostTemplate(sku.cost_template), cost_values: parseCostValues(sku.cost_values), cost_widgets: parseWidgets(sku.cost_widgets) });
    const { data } = await sb.from("sku_formulations").select("*").eq("sku_id", sku.id).order("sort_order");
    const draft = (data || []).map((r: any) => ({
      is_level2: false,
      level1_sku_id: r.ingredient_sku_id || "",
      ingredient_sku_id: r.ingredient_sku_id || "",
      level1_name: r.ingredient_name || "",
      level2_name: "",
      ingredient_name: r.ingredient_name || "",
      unit: r.unit || "g",
      unit_price: toNumber(r.unit_price, 0),
      unit_price_input: toNumber(r.unit_price, 0) === 0 ? "" : String(toNumber(r.unit_price, 0)),
      dosage_qty: parseDosageGramInput(r.dosage_qty, 0),
      dosage_input: parseDosageGramInput(r.dosage_qty, 0) === 0 ? "" : String(parseDosageGramInput(r.dosage_qty, 0)).replace(".", ","),
      line_cost: toNumber(r.unit_price, 0) * parseDosageGramInput(r.dosage_qty, 0),
    }));
    setImportedFormulaDraft(draft);
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

  const ensureBmcbSampleSku = async () => {
    const skuCode = "bmcb-2026-v1";
    const { data: existing } = await sb.from("product_skus").select("id").eq("sku_code", skuCode).maybeSingle();
    if (existing?.id) return;

    const { data: created, error } = await sb.from("product_skus").insert({
      sku_code: skuCode,
      product_name: "Bánh mì chà bông",
      unit: "cái",
      unit_price: 0,
      category: "Thành phẩm",
      sku_type: "finished_good",
      base_unit: "cái",
      yield_percent: 100,
      finished_output_qty: FORMULA_BASE_QTY,
      finished_output_unit: "cái",
      cost_template: DEFAULT_SKU_COST_TEMPLATE,
      cost_values: {
        ...DEFAULT_SKU_COST_VALUES,
        material_provision_percent: 10,
        packaging_cost: 1280,
        labor_cost: 3077,
        delivery_cost: 1000,
        other_production_cost: 1100,
        sga_cost: 1100,
        selling_price: 11000,
      },
      cost_widgets: {},
    }).select("id").single();

    if (error || !created?.id) return;

    const sampleRows = [
      ["Bột mì 888 cam", 18, 2662], ["Chất Làm Mềm Bánh Bico (1kg)", 69, 17], ["Muối", 6, 35], ["Đường", 20, 482],
      ["Phụ Gia Làm Bánh Mì Bico Gold (500g)", 88, 17], ["Phụ gia ngọt Mauri", 106, 17], ["Men bánh mì tươi Five Star", 150, 70],
      ["Kem sữa Whiping cream tatua", 149, 158], ["Trứng gà", 51, 333], ["Sữa Bột Béo New Zealand", 130, 149], ["Nước", 3, 1226],
      ["Trứng gà (nhân)", 51, 180], ["Bột ngọt", 48, 2], ["Muối (nhân)", 6, 6], ["Đường (nhân)", 20, 23],
      ["Dầu hướng dương Simply", 60, 1303], ["Giấm gạo Lisa AJINOMOLO", 51, 16], ["Chà bông vàng", 140, 1250],
    ];

    await sb.from("sku_formulations").insert(sampleRows.map(([name, unitPrice, dosage], idx) => ({
      sku_id: created.id,
      ingredient_name: String(name),
      unit: "g",
      unit_price: Number(unitPrice),
      dosage_qty: Number(dosage),
      wastage_percent: 0,
      sort_order: idx + 1,
    })));

    await sb.from("sku_trace_documents").insert({
      sku_id: created.id,
      document_type: "audit",
      document_name: `CREATE_SAMPLE_${new Date().toISOString()}`,
      document_url: `audit://sku/${created.id}/create-sample`,
    });
  };

  const addDraftMaterialRow = () => {
    setImportedFormulaDraft((prev) => [
      ...prev,
      { is_level2: false, level1_sku_id: "", ingredient_sku_id: "", level1_name: "", level2_name: "", ingredient_name: "", unit: "g", unit_price: 0, dosage_qty: 0, dosage_input: "", line_cost: 0 },
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

      next.splice(insertIdx, 0, { is_level2: true, level1_sku_id: "", ingredient_sku_id: "", level1_name: parentLevel1, level2_name: "", ingredient_name: `${parentLevel1} > `, unit: "g", unit_price: 0, dosage_qty: 0, dosage_input: "", line_cost: 0 });
      return next;
    });
  };

  const applyScannedDataToForm = (d: any) => {
    const ingredients = Array.isArray(d.ingredients) ? d.ingredients : Array.isArray(d.items) ? d.items : [];
    const draftRows = ingredients
      .map((r: any) => normalizeScannedIngredient(r))
      .filter((x: any) => x.ingredient_name)
      .map((x: any) => ({ ...x, is_level2: false, level1_name: x.ingredient_name, level2_name: "", dosage_input: String(x.dosage_qty).replace(".", ",") }));
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

  const addFormula = async () => { if (!activeSkuId) return; await sb.from("sku_formulations").insert({ sku_id: activeSkuId, ingredient_name: "NVL mới", unit: "kg", unit_price: 0, dosage_qty: 0, wastage_percent: 0, sort_order: formula.length + 1 }); loadAll(); };
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
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tính chi phí giá vốn hàng bán (SKU thành phẩm)</h1>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Danh sách SKU thành phẩm</CardTitle><div className="flex gap-2"><Button onClick={openCreateSku}>Tạo SKU</Button></div></CardHeader>
        <CardContent>
          <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead>Giá bán</TableHead><TableHead>Chỉnh sửa lúc</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>
            {finishedSkus.map((s) => <TableRow key={s.id}><TableCell className="font-mono">{s.sku_code}</TableCell><TableCell><button className="text-left underline decoration-dotted underline-offset-4 hover:text-primary transition-colors" onClick={() => openSkuDetail(s)}>{s.product_name}</button></TableCell><TableCell>{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</TableCell><TableCell className="text-xs">{s.updated_at ? new Date(s.updated_at).toLocaleString("vi-VN") : "-"}</TableCell><TableCell><div className="flex gap-2 justify-end"><Button variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button><Button variant="destructive" size="sm" onClick={() => removeSku(s)}>Xóa</Button></div></TableCell></TableRow>)}
            {finishedSkus.length === 0 && <TableRow><TableCell colSpan={5} className="text-muted-foreground">Chưa có SKU thành phẩm.</TableCell></TableRow>}
          </TableBody></Table>
        </CardContent>
      </Card>

      {/* Đã tắt scan ảnh theo yêu cầu: nhập NVL thủ công */}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chi tiết SKU</DialogTitle>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-3 text-sm">
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Tên SKU</div><div className="font-semibold mt-1">{activeSku.product_name || "-"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Mã SKU</div><div className="font-mono mt-1">{activeSku.sku_code || "-"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Thành phẩm</div><div className="mt-1">{toNumber(activeSku.finished_output_qty, FORMULA_BASE_QTY)} {activeSku.finished_output_unit || "cái"}</div></div>
            <div className="rounded border p-3 bg-muted/30"><div className="text-muted-foreground">Giá bán/cái</div><div className="font-semibold mt-1">{vnd(toNumber(costValues.selling_price, 0))}</div></div>
          </div>

          <div className="rounded border mt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>NVL</TableHead>
                  <TableHead>ĐVT</TableHead>
                  <TableHead>Đơn giá</TableHead>
                  <TableHead>Định lượng</TableHead>
                  <TableHead>Cost NVL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {formulaComputed.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground">Chưa có dữ liệu NVL</TableCell></TableRow>
                ) : formulaComputed.map((r: any) => (
                  <TableRow key={r.id || `${r.ingredient_name}-${r.sort_order}`}>
                    <TableCell>{r.displayName || r.ingredient_name || "-"}</TableCell>
                    <TableCell>{r.unit || "g"}</TableCell>
                    <TableCell>{vnd(toNumber(r.unit_price, 0))}</TableCell>
                    <TableCell>{toNumber(r.dosage_qty, 0)}</TableCell>
                    <TableCell>{vnd(toNumber(r.standardLineCost, 0))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="grid md:grid-cols-3 gap-3 text-sm mt-4">
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
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{skuForm.id ? "Sửa SKU" : "Tạo SKU theo form mẫu"}</DialogTitle>
            {skuForm.id && <div className="text-xs text-muted-foreground">Lần chỉnh sửa gần nhất: {skuForm.updated_at ? new Date(skuForm.updated_at).toLocaleString("vi-VN") : "-"}</div>}
          </DialogHeader>

          <div className="space-y-4">
            <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border rounded p-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={addDraftMaterialRow}>+ Thêm NVL cấp 1</Button>
              {level1Options.length > 0 && (
                <Button type="button" variant="outline" onClick={addDraftMaterialLevel2Row}>+ Thêm NVL cấp 2</Button>
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
            <div className="grid md:grid-cols-4 gap-3">
              <div className="md:col-span-1"><Label>Tên món</Label><Input value={skuForm.product_name || ""} onChange={(e) => setSkuForm({ ...skuForm, product_name: e.target.value })} /></div>
              <div><Label>Mã SKU thành phẩm</Label><Input value={skuForm.sku_code || ""} onChange={(e) => setSkuForm({ ...skuForm, sku_code: e.target.value })} /></div>
              <div><Label>Thành phẩm ĐVT</Label><Input value={skuForm.finished_output_unit || "cái"} onChange={(e) => setSkuForm({ ...skuForm, finished_output_unit: e.target.value })} /></div>
              <div><Label>Sản lượng thành phẩm / mẻ</Label><Input type="number" min={1} value={skuForm.finished_output_qty ?? FORMULA_BASE_QTY} onChange={(e) => setSkuForm({ ...skuForm, finished_output_qty: Math.max(1, Number(e.target.value || FORMULA_BASE_QTY)) })} /></div>
            </div>

            <div className="rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Loại</TableHead><TableHead>Tên NVL</TableHead><TableHead>Đơn giá (VNĐ)</TableHead><TableHead>Định lượng</TableHead><TableHead>Giá vốn (VNĐ)</TableHead><TableHead>Đơn giá vốn/cái (VNĐ)</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedFormulaDraft.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-muted-foreground">Chưa có dòng NVL. Anh bấm “+ Thêm NVL cấp 1” để nhập thủ công.</TableCell></TableRow>
                  )}
                  {importedFormulaDraft.map((r, idx) => {
                    const level1 = String(r.level1_name || "").trim();
                    const isLevel1Row = !r.is_level2;
                    const childRows = importedFormulaDraft.filter((x, j) => j !== idx && x.is_level2 && String(x.level1_name || "").trim() === level1);
                    const hasChildren = isLevel1Row && level1 && childRows.length > 0;

                    const aggregatedDosage = hasChildren ? childRows.reduce((s, c) => s + toNumber(c.dosage_qty, 0), 0) : toNumber(r.dosage_qty, 0);
                    const aggregatedLineCost = hasChildren ? childRows.reduce((s, c) => s + toNumber(c.line_cost, toNumber(c.unit_price, 0) * toNumber(c.dosage_qty, 0)), 0) : toNumber(r.line_cost, toNumber(r.unit_price, 0) * toNumber(r.dosage_qty, 0));
                    const aggregatedUnitPrice = aggregatedDosage > 0 ? aggregatedLineCost / aggregatedDosage : (hasChildren ? 0 : toNumber(r.unit_price, 0));

                    const lineCost = aggregatedLineCost;
                    const perUnit = Math.round(lineCost / importedOutputQty);

                    return (
                      <TableRow key={`draft-${idx}`} className={isLevel1Row ? "" : "bg-muted/30"}>
                        <TableCell>{isLevel1Row ? "NVL cấp 1" : <span className="pl-5">↳ NVL cấp 2 ({r.level1_name || "-"})</span>}</TableCell>
                        <TableCell>
                          <Input
                            list={isLevel1Row ? `level1-sku-options-${idx}` : `level2-sku-options-${idx}`}
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
                          <datalist id={isLevel1Row ? `level1-sku-options-${idx}` : `level2-sku-options-${idx}`}>
                            {ingredientSkus.map((s) => <option key={s.id} value={`${s.sku_code} - ${s.product_name}`} />)}
                          </datalist>
                        </TableCell>
                        {/* DVT cố định gram theo nghiệp vụ */}
                        <TableCell><Input disabled={hasChildren} value={hasChildren ? String(Math.round(aggregatedUnitPrice * 1000) / 1000) : (r.unit_price_input ?? (toNumber(r.unit_price, 0) === 0 ? "" : String(toNumber(r.unit_price, 0))))} onChange={(e) => { const next = [...importedFormulaDraft]; const unit_price_input = e.target.value; const unit_price = unit_price_input === "" ? 0 : Number(unit_price_input); const dosage_qty = toNumber(next[idx].dosage_qty, 0); next[idx] = { ...next[idx], unit_price_input, unit_price: Number.isFinite(unit_price) ? unit_price : 0, line_cost: (Number.isFinite(unit_price) ? unit_price : 0) * dosage_qty }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell><Input disabled={hasChildren} value={hasChildren ? String(aggregatedDosage).replace(".", ",") : (r.dosage_input ?? (toNumber(r.dosage_qty, 0) === 0 ? "" : String(toNumber(r.dosage_qty, 0)).replace(".", ",")))} onChange={(e) => { const next = [...importedFormulaDraft]; const dosage_input = e.target.value; const dosage_qty = dosage_input === "" ? 0 : parseDosageGramInput(dosage_input, 0); const unit_price = toNumber(next[idx].unit_price, 0); next[idx] = { ...next[idx], dosage_input, dosage_qty, line_cost: unit_price * dosage_qty }; setImportedFormulaDraft(next); }} /></TableCell>
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
            </div>
            <div className="text-sm text-muted-foreground">Ghi chú: NVL được tính bằng Gram. Sản lượng thành phẩm / mẻ mặc định là 100 nhưng có thể chỉnh theo từng SKU. Chi phí NVL tổng hợp tự động cộng toàn bộ dòng NVL hợp lệ.</div>

            <div className="grid md:grid-cols-3 gap-3 text-sm">
              <div className="p-3 rounded border bg-muted/30">Chi phí NVL tổng hợp: <b>{vnd(importedMaterialSummary.total)}</b></div>
              <div className="p-3 rounded border bg-muted/30 flex items-center gap-2">Dự phòng hao hụt/tăng giá (%): <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.material_provision_percent, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.material_provision_percent, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), material_provision_percent: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-yellow-50 text-yellow-900">Total cost NVL/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) + ((importedMaterialSummary.perUnit || 0) * toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100))}</b></div>
              <div className="p-3 rounded border flex items-center gap-2">Cost bao bì/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.packaging_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.packaging_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), packaging_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">Cost nhân công/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.labor_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.labor_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), labor_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /> <Button type="button" variant="outline" size="sm" onClick={() => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), labor_cost: suggestedLaborCost } })}>Lấy từ quản trị</Button></div>
              <div className="p-3 rounded border flex items-center gap-2">Delivery/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.delivery_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.delivery_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), delivery_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">Other production/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.other_production_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.other_production_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), other_production_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">BH&QL/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.sga_cost, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.sga_cost, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), sga_cost: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-red-50 text-red-700">Tổng cost/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0))}</b></div>
              <div className="p-3 rounded border flex items-center gap-2">Giá bán/cái <Input className="h-8" type="number" value={toNumber(skuForm.cost_values?.selling_price, 0) === 0 ? "" : String(toNumber(skuForm.cost_values?.selling_price, 0))} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), selling_price: e.target.value === "" ? 0 : Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-sky-50 text-sky-700">Net profit/cái: <b>{vnd(toNumber(skuForm.cost_values?.selling_price, 0) - ((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0)))}</b></div>
            </div>
          </div>

          {saveSkuError && (
            <div className="text-sm rounded border border-red-300 bg-red-50 text-red-700 px-3 py-2">
              Lưu SKU lỗi: {saveSkuError}
            </div>
          )}

          <DialogFooter>
            <Button type="button" onClick={saveSku} disabled={isSavingSku}>
              {isSavingSku ? "Đang lưu..." : "Lưu SKU"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
