import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_SKU_COST_TEMPLATE, DEFAULT_SKU_COST_VALUES, parseCostTemplate, parseCostValues, toNumber } from "@/lib/sku-cost-template";

type SKU = any;
type FormulaRow = any;
type Batch = any;
type Material = any;
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

export default function SkuCostsManagement() {
  const { toast } = useToast();
  const [skus, setSkus] = useState<SKU[]>([]);
  const [formula, setFormula] = useState<FormulaRow[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [patterns, setPatterns] = useState<any[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchMaterials, setBatchMaterials] = useState<Material[]>([]);
  const [activeSkuId, setActiveSkuId] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [priceMode, setPriceMode] = useState<PriceMode>("latest");
  const [searchByRow, setSearchByRow] = useState<Record<string, string>>({});
  const [purchasePoints, setPurchasePoints] = useState<PurchasePoint[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Map<string, number>>(new Map());
  const [isScanningSkuImage, setIsScanningSkuImage] = useState(false);
  const [scanSkuMessage, setScanSkuMessage] = useState<string>("");
  const [importedFormulaDraft, setImportedFormulaDraft] = useState<any[]>([]);
  const skuImageInputRef = useRef<HTMLInputElement | null>(null);

  const [skuForm, setSkuForm] = useState<any>({
    id: "", sku_code: "", product_name: "", unit: "gói", unit_price: 0, category: "Thành phẩm", base_unit: "gói", yield_percent: 100,
    finished_output_qty: 1, finished_output_unit: "cái", cost_template: DEFAULT_SKU_COST_TEMPLATE, cost_values: DEFAULT_SKU_COST_VALUES,
    cost_widgets: {},
  });

  const [batchForm, setBatchForm] = useState<any>({ sku_id: "", production_date: new Date().toISOString().slice(0, 10), expiry_date: "", notes: "" });

  const activeSku = useMemo(() => skus.find((s) => s.id === activeSkuId) || {}, [skus, activeSkuId]);
  const finishedSkus = useMemo(() => skus.filter((s) => String(s.category || "").toLowerCase().includes("thành phẩm")), [skus]);
  const ingredientSkus = useMemo(() => skus.filter((s) => !String(s.category || "").toLowerCase().includes("thành phẩm")), [skus]);
  const costTemplate = useMemo(() => parseCostTemplate(activeSku.cost_template), [activeSku.cost_template]);
  const costValues = useMemo(() => parseCostValues(activeSku.cost_values), [activeSku.cost_values]);
  const widgetValues = useMemo(() => parseWidgets(activeSku.cost_widgets), [activeSku.cost_widgets]);

  const loadAll = async () => {
    const [skuRes, pRes, bRes, poRes, prRes, invRes] = await Promise.all([
      sb.from("product_skus").select("*").order("updated_at", { ascending: false }),
      sb.from("batch_code_patterns").select("*").order("material_group"),
      sb.from("production_batches").select("*, product_skus(sku_code, product_name)").order("created_at", { ascending: false }),
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
    setPatterns(pRes.data || []);
    setBatches(bRes.data || []);

    const firstFinishedSku = (skuRes.data || []).find((s: any) => String(s.category || "").toLowerCase().includes("thành phẩm"));
    const currentSku = activeSkuId || firstFinishedSku?.id || skuRes.data?.[0]?.id;
    if (currentSku) {
      setActiveSkuId(currentSku);
      const [fRes, dRes] = await Promise.all([
        sb.from("sku_formulations").select("*").eq("sku_id", currentSku).order("sort_order"),
        sb.from("sku_trace_documents").select("*").eq("sku_id", currentSku).order("created_at", { ascending: false }),
      ]);
      setFormula(fRes.data || []);
      setDocuments(dRes.data || []);
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
      const [fRes, dRes] = await Promise.all([
        sb.from("sku_formulations").select("*").eq("sku_id", activeSkuId).order("sort_order"),
        sb.from("sku_trace_documents").select("*").eq("sku_id", activeSkuId).order("created_at", { ascending: false }),
      ]);
      setFormula(fRes.data || []);
      setDocuments(dRes.data || []);
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
    const unitPrice = market?.price || toNumber(r.unit_price, 0);
    const dosage = toNumber(r.dosage_qty, 0);
    const lineCost = unitPrice * dosage;
    return {
      ...r,
      displayUnit: selectedSku?.unit || r.unit || "",
      displayName: selectedSku?.product_name || r.ingredient_name || "",
      displayCode: selectedSku?.sku_code || "",
      currentStock: r.ingredient_sku_id ? toNumber(inventoryMap.get(r.ingredient_sku_id), 0) : 0,
      resolvedUnitPrice: unitPrice,
      lineCost,
      source: market?.source,
    };
  }), [formula, skus, priceMap, inventoryMap]);

  const importedMaterialSummary = useMemo(() => {
    const total = importedFormulaDraft.reduce((sum, r) => sum + toNumber(r.unit_price, 0) * toNumber(r.dosage_qty, 0), 0);
    const qty = Math.max(1, toNumber(skuForm.finished_output_qty, 1));
    return { total, perUnit: total / qty };
  }, [importedFormulaDraft, skuForm.finished_output_qty]);

  const missingScanFields = useMemo(() => {
    const missing: string[] = [];
    if (!String(skuForm.product_name || "").trim()) missing.push("Tên món");
    if (!String(skuForm.sku_code || "").trim()) missing.push("Mã SKU");
    if (!toNumber(skuForm.finished_output_qty, 0)) missing.push("Thành phẩm SL");
    if (!String(skuForm.finished_output_unit || "").trim()) missing.push("Thành phẩm ĐVT");
    if (!importedFormulaDraft.length) missing.push("Danh sách nguyên vật liệu");
    if (!toNumber(skuForm.cost_values?.selling_price, 0)) missing.push("Giá bán");
    return missing;
  }, [skuForm, importedFormulaDraft]);

  const costing = useMemo(() => {
    const outputQty = Math.max(1, Number(activeSku.finished_output_qty || 1));
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

  const openCreateSku = () => { setScanSkuMessage(""); setImportedFormulaDraft([]); setSkuForm({ id: "", sku_code: "", product_name: "", unit: "gói", unit_price: 0, category: "Thành phẩm", base_unit: "gói", yield_percent: 100, finished_output_qty: 1, finished_output_unit: "cái", cost_template: DEFAULT_SKU_COST_TEMPLATE, cost_values: DEFAULT_SKU_COST_VALUES, cost_widgets: {} }); setDialogOpen(true); };
  const openEditSku = (sku: SKU) => { setSkuForm({ ...sku, cost_template: parseCostTemplate(sku.cost_template), cost_values: parseCostValues(sku.cost_values), cost_widgets: parseWidgets(sku.cost_widgets) }); setDialogOpen(true); };

  const saveSku = async () => {
    if (!skuForm.sku_code || !skuForm.product_name) return;
    if (skuForm.id) {
      await sb.from("product_skus").update({ ...skuForm }).eq("id", skuForm.id);
      toast({ title: "Đã cập nhật SKU" });
    } else {
      const { data } = await sb.from("product_skus").insert({ ...skuForm }).select("*").single();
      if (data?.id) {
        setActiveSkuId(data.id);

        if (importedFormulaDraft.length > 0) {
          const rows = importedFormulaDraft.map((r: any, idx: number) => {
            const n = String(r.ingredient_name || "").toLowerCase();
            const matched = ingredientSkus.find((s) => {
              const t = `${s.sku_code} ${s.product_name}`.toLowerCase();
              return t.includes(n) || n.includes(String(s.product_name || "").toLowerCase());
            });
            return {
              sku_id: data.id,
              ingredient_sku_id: matched?.id || null,
              ingredient_name: matched?.product_name || r.ingredient_name,
              unit: matched?.unit || r.unit || "g",
              unit_price: toNumber(r.unit_price, 0),
              dosage_qty: toNumber(r.dosage_qty, 0),
              wastage_percent: 0,
              sort_order: idx + 1,
            };
          });
          await sb.from("sku_formulations").insert(rows);
        }
      }
      toast({ title: "SKU đã tạo thành công", description: "Đã cập nhật ngay danh sách SKU thành phẩm." });
      setScanSkuMessage("SKU đã tạo thành công và đã cập nhật danh sách.");
    }
    setDialogOpen(false);
    setImportedFormulaDraft([]);
    loadAll();
  };

  const openCreateSkuFromImage = () => {
    skuImageInputRef.current?.click();
  };

  const handleScanSkuCostImage = async (file?: File | null) => {
    if (!file) return;
    setScanSkuMessage("Đang scan ảnh công thức...");

    // Ensure fresh access token to avoid 401 from Edge Function
    let accessToken = "";
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    if (sessionError || !sessionData.session) {
      toast({ title: "Phiên đăng nhập hết hạn", description: "Vui lòng đăng nhập lại.", variant: "destructive" });
      setScanSkuMessage("Scan thất bại: phiên đăng nhập hết hạn.");
      return;
    }

    const expiresAt = Number(sessionData.session.expires_at || 0) * 1000;
    const shouldRefresh = !expiresAt || expiresAt - Date.now() < 60_000;
    if (shouldRefresh) {
      const { data: refreshed, error: refreshError } = await sb.auth.refreshSession();
      if (refreshError || !refreshed?.session?.access_token) {
        toast({ title: "Phiên đăng nhập hết hạn", description: "Vui lòng đăng nhập lại.", variant: "destructive" });
        setScanSkuMessage("Scan thất bại: không làm mới được phiên đăng nhập.");
        return;
      }
      accessToken = refreshed.session.access_token;
    } else {
      accessToken = sessionData.session.access_token;
    }

    setIsScanningSkuImage(true);
    try {
      const imageBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file);
      });

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(`${supabaseUrl}/functions/v1/scan-sku-cost-sheet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ imageBase64, mimeType: file.type }),
      });

      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        if (response.status === 401) {
          throw new Error("401: phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại rồi scan lại.");
        }
        throw new Error(payload?.error || `Lỗi scan ảnh (${response.status})`);
      }

      const d = payload.data || {};
      const ingredients = Array.isArray(d.ingredients) ? d.ingredients : Array.isArray(d.items) ? d.items : [];
      const draftRows = ingredients.map((r: any) => ({
        ingredient_name: r.ingredient_name || r.name || r.product_name || "",
        unit: r.unit || r.uom || "g",
        unit_price: toNumber(r.unit_price ?? r.price ?? r.don_gia, 0),
        dosage_qty: toNumber(r.dosage_qty ?? r.quantity ?? r.dinh_luong, 0),
      })).filter((x: any) => x.ingredient_name);
      setImportedFormulaDraft(draftRows);

      const productName = d.product_name || d.ten_mon || "SKU từ ảnh";
      const outputQty = toNumber(d.finished_output_qty ?? d.output_qty ?? d.thanh_pham_sl, 1);
      const outputUnit = d.finished_output_unit || d.output_unit || d.thanh_pham_dvt || "cái";

      setSkuForm({
        id: "",
        sku_code: d.sku_code || `TP-${productName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 16) || "AUTO"}-001`,
        product_name: productName,
        unit: outputUnit,
        category: "Thành phẩm",
        base_unit: outputUnit,
        yield_percent: 100,
        finished_output_qty: outputQty,
        finished_output_unit: outputUnit,
        cost_template: DEFAULT_SKU_COST_TEMPLATE,
        cost_values: {
          ...DEFAULT_SKU_COST_VALUES,
          material_provision_percent: toNumber(d.material_provision_percent ?? d.provision_percent, 0),
          packaging_cost: toNumber(d.packaging_cost, 0),
          labor_cost: toNumber(d.labor_cost, 0),
          delivery_cost: toNumber(d.delivery_cost, 0),
          other_production_cost: toNumber(d.other_production_cost, 0),
          sga_cost: toNumber(d.sga_cost ?? d.management_cost, 0),
          selling_price: toNumber(d.selling_price ?? d.sale_price, 0),
        },
        cost_widgets: {},
      });

      setDialogOpen(true);
      setScanSkuMessage(`Đã scan xong: ${draftRows.length} dòng NVL. Kiểm tra form và bấm Lưu SKU.`);
      toast({ title: "Đã scan ảnh công thức", description: `Đọc được ${draftRows.length} dòng NVL. Anh kiểm tra rồi bấm Lưu.` });
    } catch (e: any) {
      const msg = e?.message || "Lỗi không xác định";
      setScanSkuMessage(`Scan thất bại: ${msg}`);
      toast({ title: "Không scan được ảnh", description: msg, variant: "destructive" });
    } finally {
      setIsScanningSkuImage(false);
    }
  };

  const addFormula = async () => { if (!activeSkuId) return; await sb.from("sku_formulations").insert({ sku_id: activeSkuId, ingredient_name: "NVL mới", unit: "kg", unit_price: 0, dosage_qty: 0, wastage_percent: 0, sort_order: formula.length + 1 }); loadAll(); };
  const updateFormulaRow = async (r: any, patch: any) => { await sb.from("sku_formulations").update(patch).eq("id", r.id); loadAll(); };
  const removeFormulaRow = async (id: string) => { await sb.from("sku_formulations").delete().eq("id", id); loadAll(); };

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

  const uploadDoc = async (file: File) => {
    if (!activeSkuId || !file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      await sb.from("sku_trace_documents").insert({ sku_id: activeSkuId, document_type: file.type.includes("image") ? "image" : "document", document_name: file.name, document_url: String(reader.result) });
      toast({ title: "Đã upload hồ sơ" }); loadAll();
    };
    reader.readAsDataURL(file);
  };

  const savePattern = async (p: any, patch: any) => { await sb.from("batch_code_patterns").update(patch).eq("id", p.id); loadAll(); };
  const codeOf = (group: string, date: string, seq: number) => { const p = patterns.find((x) => x.material_group === group); if (!p) return ""; return `${p.prefix}${p.separator}${formatYYMMDD(date)}${p.separator}${pad(seq, Number(p.seq_digits || 3))}`; };

  const createBatch = async () => {
    if (!batchForm.sku_id) return;
    const seq = (batches.length || 0) + 1; const date = batchForm.production_date;
    const finished = codeOf("finished", date, seq); const shell = codeOf("shell", date, seq); const sauce = codeOf("filling_sauce", date, seq);
    const { data: b } = await sb.from("production_batches").insert({ sku_id: batchForm.sku_id, batch_code: finished, finished_code: finished, shell_code: shell, filling_sauce_code: sauce, production_date: date, expiry_date: batchForm.expiry_date || null, notes: batchForm.notes || null }).select("*").single();
    const sku = skus.find((s) => s.id === batchForm.sku_id);
    if (b?.id && sku) {
      await sb.from("production_batch_materials").insert(formula.map((r, idx) => ({ batch_id: b.id, material_group: "ingredient", material_name: r.ingredient_name, material_code: r.ingredient_sku_id ? skus.find((x) => x.id === r.ingredient_sku_id)?.sku_code : null, material_batch_code: codeOf("ingredient", date, idx + 1), quantity: r.dosage_qty, unit: r.unit, sort_order: idx + 1 })));
      await sb.from("production_batch_materials").insert({ batch_id: b.id, material_group: "finished", material_name: sku.product_name, material_code: sku.sku_code, material_batch_code: finished, quantity: 1, unit: sku.unit || "gói", sort_order: 999 });
    }
    toast({ title: "Đã tạo batch" }); setBatchForm({ sku_id: "", production_date: new Date().toISOString().slice(0, 10), expiry_date: "", notes: "" }); loadAll();
  };

  const loadBatchMaterials = async (batchId: string) => { const { data } = await sb.from("production_batch_materials").select("*").eq("batch_id", batchId).order("sort_order"); setBatchMaterials(data || []); };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">SKU Costs theo duyệt anh Tâm (Phase A/B)</h1>
      <Tabs defaultValue="sku-admin">
        <TabsList>
          <TabsTrigger value="sku-admin">SKU quản trị + Costing</TabsTrigger>
          <TabsTrigger value="batch-coding">Mã hóa batch</TabsTrigger>
          <TabsTrigger value="trace-links">Link truy xuất</TabsTrigger>
        </TabsList>

        <TabsContent value="sku-admin" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>Danh sách SKU thành phẩm</CardTitle><div className="flex gap-2"><Button onClick={openCreateSku}>Tạo SKU</Button></div></CardHeader>
            <CardContent>
              {!!scanSkuMessage && <div className="mb-3 text-sm text-muted-foreground">{scanSkuMessage}</div>}
              <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead>Giá bán</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>
                {finishedSkus.map((s) => <TableRow key={s.id}><TableCell className="font-mono">{s.sku_code}</TableCell><TableCell><button className="underline" onClick={() => setActiveSkuId(s.id)}>{s.product_name}</button></TableCell><TableCell>{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</TableCell><TableCell><Button variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button></TableCell></TableRow>)}
                {finishedSkus.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">Chưa có SKU thành phẩm.</TableCell></TableRow>}
              </TableBody></Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>NVL thực tế + chế độ giá</CardTitle>
              <div className="flex items-center gap-2">
                <select className="border rounded h-9 px-2" value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)}>
                  <option value="latest">Giá gần nhất</option>
                  <option value="avg30">Giá TB 30 ngày</option>
                  <option value="avg90">Giá TB 90 ngày</option>
                </select>
                <Button variant="outline" onClick={addFormula}>+ Dòng NVL</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table>
                <TableHeader><TableRow><TableHead>Chọn NVL/SKU</TableHead><TableHead>ĐVT</TableHead><TableHead>Tồn</TableHead><TableHead>Giá thực tế</TableHead><TableHead>Định lượng</TableHead><TableHead>Cost NVL</TableHead><TableHead>Nguồn giá</TableHead><TableHead></TableHead></TableRow></TableHeader>
                <TableBody>
                  {formulaComputed.map((r) => {
                    const q = (searchByRow[r.id] || "").toLowerCase();
                    const options = ingredientSkus.filter((s) => `${s.sku_code} ${s.product_name} ${s.category || ""}`.toLowerCase().includes(q));
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="space-y-1">
                          <Input placeholder="Search mã/tên/nhóm" value={searchByRow[r.id] || ""} onChange={(e) => setSearchByRow((p) => ({ ...p, [r.id]: e.target.value }))} />
                          <select className="w-full border rounded h-9 px-2" value={r.ingredient_sku_id || ""} onChange={(e) => {
                            const selected = skus.find((x) => x.id === e.target.value);
                            updateFormulaRow(r, { ingredient_sku_id: e.target.value || null, ingredient_name: selected?.product_name || r.ingredient_name, unit: selected?.unit || r.unit });
                          }}>
                            <option value="">-- Chọn từ danh sách NVL/SKU --</option>
                            {options.map((s) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name} ({s.category || "Khác"})</option>)}
                          </select>
                        </TableCell>
                        <TableCell>{r.displayUnit || "-"}</TableCell>
                        <TableCell>{vnd(r.currentStock)}</TableCell>
                        <TableCell>{vnd(r.resolvedUnitPrice)}</TableCell>
                        <TableCell><Input type="number" value={r.dosage_qty || 0} onChange={(e) => updateFormulaRow(r, { dosage_qty: Number(e.target.value || 0) })} /></TableCell>
                        <TableCell>{vnd(r.lineCost)}</TableCell>
                        <TableCell className="text-xs">
                          {r.source ? (
                            <div className="space-y-1">
                              <div>{r.source.sourceType.toUpperCase()} · {r.source.sourceLabel}</div>
                              <div>{new Date(r.source.date).toLocaleDateString("vi-VN")}</div>
                              <Link className="underline" to={r.source.sourceType === "po" ? "/purchase-orders" : "/payment-requests"}>Mở nguồn</Link>
                            </div>
                          ) : <span className="text-muted-foreground">Đơn giá SKU</span>}
                        </TableCell>
                        <TableCell><Button variant="destructive" size="sm" onClick={() => removeFormulaRow(r.id)}>Xóa</Button></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="grid md:grid-cols-2 gap-3 text-sm">
                <div className="p-3 rounded border">Total material cost: <b>{vnd(costing.totalMaterialCost)}</b></div>
                <div className="p-3 rounded border flex items-center gap-2">Dự phòng hao hụt/tăng giá (%): <Input className="w-28 h-8" type="number" value={costValues.material_provision_percent || 0} onChange={(e) => updateCostValue("material_provision_percent", Number(e.target.value || 0))} /></div>
                <div className="p-3 rounded border">Dự phòng hao hụt/tăng giá (VND): <b>{vnd(costing.provisionAmount)}</b></div>
                <div className="p-3 rounded border">Total cost NVL: <b>{vnd(costing.totalCostNVL)}</b> ({costing.pctOnCost(costing.totalCostNVL).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Tổng cost: <b>{vnd(costing.totalCost)}</b></div>
                <div className="p-3 rounded border flex items-center gap-2">Giá bán:<Input className="w-32 h-8" type="number" value={costValues.selling_price || 0} onChange={(e) => updateCostValue("selling_price", Number(e.target.value || 0))} /></div>
                <div className="p-3 rounded border">Net profit: <b>{vnd(costing.netProfit)}</b></div>
                <div className="p-3 rounded border">Net profit (% trên giá bán): <b>{costing.netProfitPct.toFixed(2)}%</b></div>
              </div>
            </CardContent>
          </Card>

          {WIDGET_CONFIG.map((w) => {
            const lines = widgetValues[w.key] || [];
            const total = lines.reduce((s, x) => s + toNumber(x.amount), 0);
            return (
              <Card key={w.key}>
                <CardHeader className="flex flex-row items-center justify-between"><CardTitle>{w.label}</CardTitle><Button variant="outline" size="sm" onClick={() => syncWidgetToMain(w.key, [...lines, { name: "", amount: 0 }])}>+ Dòng</Button></CardHeader>
                <CardContent className="space-y-3">
                  <Table><TableHeader><TableRow><TableHead>Hạng mục</TableHead><TableHead>Chi phí kỳ (VND)</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>
                    {lines.map((line, idx) => (
                      <TableRow key={`${w.key}-${idx}`}>
                        <TableCell><Input value={line.name} onChange={(e) => { const next = [...lines]; next[idx] = { ...line, name: e.target.value }; syncWidgetToMain(w.key, next); }} /></TableCell>
                        <TableCell><Input type="number" value={line.amount} onChange={(e) => { const next = [...lines]; next[idx] = { ...line, amount: Number(e.target.value || 0) }; syncWidgetToMain(w.key, next); }} /></TableCell>
                        <TableCell><Button variant="destructive" size="sm" onClick={() => syncWidgetToMain(w.key, lines.filter((_, i) => i !== idx))}>Xoá</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody></Table>
                  <div className="grid md:grid-cols-3 gap-3 text-sm">
                    <div className="p-3 rounded border">Tổng chi phí kỳ: <b>{vnd(total)}</b></div>
                    <div className="p-3 rounded border">Cost/cái: <b>{vnd(total / Math.max(1, costing.outputQty))}</b></div>
                    <div className="p-3 rounded border">Tỷ trọng: <b>{costing.pctOnCost(total).toFixed(2)}%</b></div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardHeader><CardTitle>Hồ sơ ảnh/chứng từ truy xuất</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input type="file" onChange={(e) => e.target.files?.[0] && uploadDoc(e.target.files[0])} />
              <div className="grid md:grid-cols-2 gap-3">{documents.map((d) => <a key={d.id} href={d.document_url} target="_blank" rel="noreferrer" className="border rounded p-3 text-sm hover:bg-muted"><div className="font-medium">{d.document_name}</div><div className="text-muted-foreground">{d.document_type}</div></a>)}</div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="batch-coding" className="space-y-4">
          <Card><CardHeader><CardTitle>Rule sinh mã lô theo format</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Nhóm</TableHead><TableHead>Prefix</TableHead><TableHead>Dấu phân cách</TableHead><TableHead>Số chữ số seq</TableHead></TableRow></TableHeader><TableBody>{patterns.map((p) => <TableRow key={p.id}><TableCell>{p.material_group}</TableCell><TableCell><Input value={p.prefix} onChange={(e) => savePattern(p, { prefix: e.target.value })} /></TableCell><TableCell><Input value={p.separator} onChange={(e) => savePattern(p, { separator: e.target.value })} /></TableCell><TableCell><Input type="number" value={p.seq_digits} onChange={(e) => savePattern(p, { seq_digits: Number(e.target.value || 3) })} /></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
          <Card><CardHeader><CardTitle>Tạo batch mới</CardTitle></CardHeader><CardContent className="grid md:grid-cols-2 gap-3"><div><Label>SKU thành phẩm</Label><select className="w-full border rounded h-10 px-2" value={batchForm.sku_id} onChange={(e) => setBatchForm({ ...batchForm, sku_id: e.target.value })}><option value="">-- Chọn SKU --</option>{finishedSkus.map((s) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}</select></div><div><Label>NSX</Label><Input type="date" value={batchForm.production_date} onChange={(e) => setBatchForm({ ...batchForm, production_date: e.target.value })} /></div><div><Label>HSD</Label><Input type="date" value={batchForm.expiry_date} onChange={(e) => setBatchForm({ ...batchForm, expiry_date: e.target.value })} /></div><div><Label>Ghi chú</Label><Input value={batchForm.notes} onChange={(e) => setBatchForm({ ...batchForm, notes: e.target.value })} /></div><div className="md:col-span-2"><Button onClick={createBatch}>Sinh batch + mã hóa</Button></div></CardContent></Card>
        </TabsContent>

        <TabsContent value="trace-links" className="space-y-4">
          <Card><CardHeader><CardTitle>Danh sách batch truy xuất</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Mã lô</TableHead><TableHead>SKU</TableHead><TableHead>NSX/HSD</TableHead><TableHead>Link đối tác</TableHead><TableHead>Vật tư</TableHead></TableRow></TableHeader><TableBody>{batches.map((b) => <TableRow key={b.id}><TableCell className="font-mono">{b.batch_code}</TableCell><TableCell>{b.product_skus?.sku_code} - {b.product_skus?.product_name}</TableCell><TableCell>{b.production_date} / {b.expiry_date || "-"}</TableCell><TableCell><Link className="underline" to={`/trace/${b.public_token}`} target="_blank">/trace/{b.public_token}</Link></TableCell><TableCell><Button size="sm" variant="outline" onClick={() => loadBatchMaterials(b.id)}>Xem</Button></TableCell></TableRow>)}</TableBody></Table>{!!batchMaterials.length && <div className="mt-4"><h4 className="font-semibold mb-2">Chi tiết NVL batch</h4><Table><TableHeader><TableRow><TableHead>Nhóm</TableHead><TableHead>Tên</TableHead><TableHead>Mã</TableHead><TableHead>Mã lô NVL</TableHead><TableHead>SL</TableHead></TableRow></TableHeader><TableBody>{batchMaterials.map((m) => <TableRow key={m.id}><TableCell>{m.material_group}</TableCell><TableCell>{m.material_name}</TableCell><TableCell>{m.material_code}</TableCell><TableCell>{m.material_batch_code}</TableCell><TableCell>{m.quantity} {m.unit}</TableCell></TableRow>)}</TableBody></Table></div>}</CardContent></Card>
        </TabsContent>
      </Tabs>

      <input
        ref={skuImageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; handleScanSkuCostImage(f); e.currentTarget.value = ""; }}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{skuForm.id ? "Sửa SKU" : "Tạo SKU theo form mẫu"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={openCreateSkuFromImage} disabled={isScanningSkuImage}>
                {isScanningSkuImage ? "Đang scan ảnh..." : "Scan dữ liệu từ ảnh"}
              </Button>
              {!!scanSkuMessage && <span className="text-sm text-muted-foreground">{scanSkuMessage}</span>}
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
              <div><Label>Thành phẩm SL</Label><Input type="number" value={skuForm.finished_output_qty || 1} onChange={(e) => setSkuForm({ ...skuForm, finished_output_qty: Number(e.target.value || 1) })} /></div>
            </div>

            <div className="rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nguyên vật liệu</TableHead><TableHead>ĐVT</TableHead><TableHead>Đơn giá</TableHead><TableHead>Định lượng</TableHead><TableHead>Giá vốn</TableHead><TableHead>Đơn giá vốn/cái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {importedFormulaDraft.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-muted-foreground">Chưa có NVL từ scan ảnh. Anh bấm “Tạo SKU từ ảnh” để nạp dữ liệu.</TableCell></TableRow>
                  )}
                  {importedFormulaDraft.map((r, idx) => {
                    const lineCost = toNumber(r.unit_price, 0) * toNumber(r.dosage_qty, 0);
                    const perUnit = lineCost / Math.max(1, toNumber(skuForm.finished_output_qty, 1));
                    return (
                      <TableRow key={`draft-${idx}`}>
                        <TableCell><Input value={r.ingredient_name || ""} onChange={(e) => { const next = [...importedFormulaDraft]; next[idx] = { ...next[idx], ingredient_name: e.target.value }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell><Input value={r.unit || "g"} onChange={(e) => { const next = [...importedFormulaDraft]; next[idx] = { ...next[idx], unit: e.target.value }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell><Input type="number" value={toNumber(r.unit_price, 0)} onChange={(e) => { const next = [...importedFormulaDraft]; next[idx] = { ...next[idx], unit_price: Number(e.target.value || 0) }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell><Input type="number" value={toNumber(r.dosage_qty, 0)} onChange={(e) => { const next = [...importedFormulaDraft]; next[idx] = { ...next[idx], dosage_qty: Number(e.target.value || 0) }; setImportedFormulaDraft(next); }} /></TableCell>
                        <TableCell>{vnd(lineCost)}</TableCell>
                        <TableCell>{vnd(perUnit)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="grid md:grid-cols-3 gap-3 text-sm">
              <div className="p-3 rounded border bg-muted/30">Total material cost: <b>{vnd(importedMaterialSummary.total)}</b></div>
              <div className="p-3 rounded border bg-muted/30 flex items-center gap-2">Dự phòng hao hụt/tăng giá (%): <Input className="h-8" type="number" value={skuForm.cost_values?.material_provision_percent || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), material_provision_percent: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-yellow-50 text-yellow-900">Total cost NVL/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100))}</b></div>
              <div className="p-3 rounded border flex items-center gap-2">Cost bao bì/cái <Input className="h-8" type="number" value={skuForm.cost_values?.packaging_cost || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), packaging_cost: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">Cost nhân công/cái <Input className="h-8" type="number" value={skuForm.cost_values?.labor_cost || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), labor_cost: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">Delivery/cái <Input className="h-8" type="number" value={skuForm.cost_values?.delivery_cost || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), delivery_cost: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">Other production/cái <Input className="h-8" type="number" value={skuForm.cost_values?.other_production_cost || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), other_production_cost: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border flex items-center gap-2">BH&QL/cái <Input className="h-8" type="number" value={skuForm.cost_values?.sga_cost || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), sga_cost: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-red-50 text-red-700">Tổng cost/cái: <b>{vnd((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0))}</b></div>
              <div className="p-3 rounded border flex items-center gap-2">Giá bán/cái <Input className="h-8" type="number" value={skuForm.cost_values?.selling_price || 0} onChange={(e) => setSkuForm({ ...skuForm, cost_values: { ...(skuForm.cost_values || {}), selling_price: Number(e.target.value || 0) } })} /></div>
              <div className="p-3 rounded border bg-sky-50 text-sky-700">Net profit/cái: <b>{vnd(toNumber(skuForm.cost_values?.selling_price, 0) - ((importedMaterialSummary.perUnit || 0) * (1 + toNumber(skuForm.cost_values?.material_provision_percent, 0) / 100) + toNumber(skuForm.cost_values?.packaging_cost, 0) + toNumber(skuForm.cost_values?.labor_cost, 0) + toNumber(skuForm.cost_values?.delivery_cost, 0) + toNumber(skuForm.cost_values?.other_production_cost, 0) + toNumber(skuForm.cost_values?.sga_cost, 0)))}</b></div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={saveSku}>Lưu SKU</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
