import { useEffect, useMemo, useState } from "react";
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
import {
  DEFAULT_SKU_COST_TEMPLATE,
  DEFAULT_SKU_COST_VALUES,
  parseCostTemplate,
  parseCostValues,
  toNumber,
} from "@/lib/sku-cost-template";

type SKU = any;
type FormulaRow = any;
type Batch = any;
type Material = any;

const sb = supabase as any;

const pad = (n: number, len: number) => String(n).padStart(len, "0");

const formatYYMMDD = (d: string) => {
  const dt = new Date(d);
  const yy = String(dt.getFullYear()).slice(-2);
  const mm = pad(dt.getMonth() + 1, 2);
  const dd = pad(dt.getDate(), 2);
  return `${yy}${mm}${dd}`;
};

const calcLineCost = (r: FormulaRow) => Number(r.unit_price || 0) * Number(r.dosage_qty || 0);

const vnd = (value: number) => new Intl.NumberFormat("vi-VN").format(value || 0);

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
  const [skuForm, setSkuForm] = useState<any>({
    id: "",
    sku_code: "",
    product_name: "",
    unit: "gói",
    unit_price: 0,
    category: "Thành phẩm",
    base_unit: "gói",
    yield_percent: 100,
    finished_output_qty: 1,
    finished_output_unit: "cái",
    cost_template: DEFAULT_SKU_COST_TEMPLATE,
    cost_values: DEFAULT_SKU_COST_VALUES,
  });

  const [batchForm, setBatchForm] = useState<any>({
    sku_id: "",
    production_date: new Date().toISOString().slice(0, 10),
    expiry_date: "",
    notes: "",
  });

  const activeSku = useMemo(() => skus.find((s) => s.id === activeSkuId) || {}, [skus, activeSkuId]);
  const costTemplate = useMemo(() => parseCostTemplate(activeSku.cost_template), [activeSku.cost_template]);
  const costValues = useMemo(() => parseCostValues(activeSku.cost_values), [activeSku.cost_values]);

  const loadAll = async () => {
    const [skuRes, pRes, bRes] = await Promise.all([
      sb.from("product_skus").select("*").order("updated_at", { ascending: false }),
      sb.from("batch_code_patterns").select("*").order("material_group"),
      sb.from("production_batches").select("*, product_skus(sku_code, product_name)").order("created_at", { ascending: false }),
    ]);

    setSkus(skuRes.data || []);
    setPatterns(pRes.data || []);
    setBatches(bRes.data || []);

    const currentSku = activeSkuId || skuRes.data?.[0]?.id;
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
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const costing = useMemo(() => {
    const outputQty = Math.max(1, Number(activeSku.finished_output_qty || 1));

    const totalMaterialCostBatch = formula.reduce((sum, row) => sum + calcLineCost(row), 0);
    const totalMaterialCost = totalMaterialCostBatch / outputQty;
    const provisionPercent = toNumber(costValues.material_provision_percent, 0);
    const provisionAmount = (totalMaterialCost * provisionPercent) / 100;
    const totalCostNVL = totalMaterialCost + provisionAmount;

    const nonMaterialCost = costTemplate
      .filter((line) => line.mode === "amount" && !["selling_price"].includes(line.key))
      .reduce((sum, line) => sum + toNumber(costValues[line.key], 0), 0);

    const totalCost = totalCostNVL + nonMaterialCost;
    const sellingPrice = toNumber(costValues.selling_price, 0);
    const netProfit = sellingPrice - totalCost;
    const netProfitPct = sellingPrice > 0 ? (netProfit / sellingPrice) * 100 : 0;
    const pctOnCost = (value: number) => (totalCost > 0 ? (value / totalCost) * 100 : 0);

    const groupCosts = {
      nvl: totalCostNVL,
      packaging: toNumber(costValues.packaging_cost),
      labor: toNumber(costValues.labor_cost),
      delivery: toNumber(costValues.delivery_cost),
      otherProduction: toNumber(costValues.other_production_cost),
      sga: toNumber(costValues.sga_cost),
    };

    return {
      outputQty,
      totalMaterialCostBatch,
      totalMaterialCost,
      provisionPercent,
      provisionAmount,
      totalCostNVL,
      totalCost,
      sellingPrice,
      netProfit,
      netProfitPct,
      pctOnCost,
      groupCosts,
    };
  }, [activeSku, formula, costTemplate, costValues]);

  const openCreateSku = () => {
    setSkuForm({
      id: "",
      sku_code: "",
      product_name: "",
      unit: "gói",
      unit_price: 0,
      category: "Thành phẩm",
      base_unit: "gói",
      yield_percent: 100,
      finished_output_qty: 1,
      finished_output_unit: "cái",
      cost_template: DEFAULT_SKU_COST_TEMPLATE,
      cost_values: DEFAULT_SKU_COST_VALUES,
    });
    setDialogOpen(true);
  };

  const openEditSku = (sku: SKU) => {
    setSkuForm({
      ...sku,
      cost_template: parseCostTemplate(sku.cost_template),
      cost_values: parseCostValues(sku.cost_values),
    });
    setDialogOpen(true);
  };

  const saveSku = async () => {
    if (!skuForm.sku_code || !skuForm.product_name) return;
    if (skuForm.id) {
      await sb.from("product_skus").update({ ...skuForm }).eq("id", skuForm.id);
      toast({ title: "Đã cập nhật SKU" });
    } else {
      const { data } = await sb.from("product_skus").insert({ ...skuForm }).select("*").single();
      if (data?.id) setActiveSkuId(data.id);
      toast({ title: "Đã tạo SKU" });
    }
    setDialogOpen(false);
    loadAll();
  };

  const addFormula = async () => {
    if (!activeSkuId) return;
    await sb.from("sku_formulations").insert({
      sku_id: activeSkuId,
      ingredient_name: "NVL mới",
      unit: "kg",
      unit_price: 0,
      dosage_qty: 0,
      wastage_percent: 0,
      sort_order: formula.length + 1,
    });
    loadAll();
  };

  const updateFormulaRow = async (r: any, patch: any) => {
    await sb.from("sku_formulations").update(patch).eq("id", r.id);
    loadAll();
  };

  const removeFormulaRow = async (id: string) => {
    await sb.from("sku_formulations").delete().eq("id", id);
    loadAll();
  };

  const updateCostValue = async (key: string, value: number) => {
    if (!activeSkuId) return;
    const next = { ...costValues, [key]: value };
    await sb.from("product_skus").update({ cost_values: next }).eq("id", activeSkuId);
    setSkus((prev) => prev.map((sku) => (sku.id === activeSkuId ? { ...sku, cost_values: next } : sku)));
  };

  const uploadDoc = async (file: File) => {
    if (!activeSkuId || !file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      await sb.from("sku_trace_documents").insert({
        sku_id: activeSkuId,
        document_type: file.type.includes("image") ? "image" : "document",
        document_name: file.name,
        document_url: String(reader.result),
      });
      toast({ title: "Đã upload hồ sơ" });
      loadAll();
    };
    reader.readAsDataURL(file);
  };

  const savePattern = async (p: any, patch: any) => {
    await sb.from("batch_code_patterns").update(patch).eq("id", p.id);
    loadAll();
  };

  const codeOf = (group: string, date: string, seq: number) => {
    const p = patterns.find((x) => x.material_group === group);
    if (!p) return "";
    return `${p.prefix}${p.separator}${formatYYMMDD(date)}${p.separator}${pad(seq, Number(p.seq_digits || 3))}`;
  };

  const createBatch = async () => {
    if (!batchForm.sku_id) return;
    const seq = (batches.length || 0) + 1;
    const date = batchForm.production_date;
    const finished = codeOf("finished", date, seq);
    const shell = codeOf("shell", date, seq);
    const sauce = codeOf("filling_sauce", date, seq);

    const { data: b } = await sb
      .from("production_batches")
      .insert({
        sku_id: batchForm.sku_id,
        batch_code: finished,
        finished_code: finished,
        shell_code: shell,
        filling_sauce_code: sauce,
        production_date: date,
        expiry_date: batchForm.expiry_date || null,
        notes: batchForm.notes || null,
      })
      .select("*")
      .single();

    const sku = skus.find((s) => s.id === batchForm.sku_id);
    if (b?.id && sku) {
      await sb.from("production_batch_materials").insert(
        formula.map((r, idx) => ({
          batch_id: b.id,
          material_group: "ingredient",
          material_name: r.ingredient_name,
          material_code: r.ingredient_sku_id ? skus.find((x) => x.id === r.ingredient_sku_id)?.sku_code : null,
          material_batch_code: codeOf("ingredient", date, idx + 1),
          quantity: r.dosage_qty,
          unit: r.unit,
          sort_order: idx + 1,
        }))
      );

      await sb.from("production_batch_materials").insert({
        batch_id: b.id,
        material_group: "finished",
        material_name: sku.product_name,
        material_code: sku.sku_code,
        material_batch_code: finished,
        quantity: 1,
        unit: sku.unit || "gói",
        sort_order: 999,
      });
    }

    toast({ title: "Đã tạo batch" });
    setBatchForm({ sku_id: "", production_date: new Date().toISOString().slice(0, 10), expiry_date: "", notes: "" });
    loadAll();
  };

  const loadBatchMaterials = async (batchId: string) => {
    const { data } = await sb.from("production_batch_materials").select("*").eq("batch_id", batchId).order("sort_order");
    setBatchMaterials(data || []);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">SKU Costs theo template thực tế</h1>

      <Tabs defaultValue="sku-admin">
        <TabsList>
          <TabsTrigger value="sku-admin">SKU quản trị + Costing</TabsTrigger>
          <TabsTrigger value="batch-coding">Mã hóa batch</TabsTrigger>
          <TabsTrigger value="trace-links">Link truy xuất</TabsTrigger>
        </TabsList>

        <TabsContent value="sku-admin" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Danh sách SKU thành phẩm</CardTitle>
              <Button onClick={openCreateSku}>Tạo SKU</Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead>Giá bán</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skus.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono">{s.sku_code}</TableCell>
                      <TableCell>
                        <button className="underline" onClick={() => setActiveSkuId(s.id)}>{s.product_name}</button>
                      </TableCell>
                      <TableCell>{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</TableCell>
                      <TableCell><Button variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Template cost sheet (nhập tay 1:1)</CardTitle>
              <Button variant="outline" onClick={addFormula}>+ Dòng NVL</Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>NVL chi tiết</TableHead><TableHead>ĐVT</TableHead><TableHead>Đơn giá</TableHead><TableHead>Định lượng</TableHead><TableHead>Giá vốn</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {formula.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell><Input value={r.ingredient_name || ""} onChange={(e) => updateFormulaRow(r, { ingredient_name: e.target.value })} /></TableCell>
                      <TableCell><Input value={r.unit || ""} onChange={(e) => updateFormulaRow(r, { unit: e.target.value })} /></TableCell>
                      <TableCell><Input type="number" value={r.unit_price || 0} onChange={(e) => updateFormulaRow(r, { unit_price: Number(e.target.value || 0) })} /></TableCell>
                      <TableCell><Input type="number" value={r.dosage_qty || 0} onChange={(e) => updateFormulaRow(r, { dosage_qty: Number(e.target.value || 0) })} /></TableCell>
                      <TableCell>{vnd(calcLineCost(r))}</TableCell>
                      <TableCell><Button variant="destructive" size="sm" onClick={() => removeFormulaRow(r.id)}>Xóa</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="grid md:grid-cols-2 gap-3 text-sm">
                <div className="p-3 rounded border">Total material cost: <b>{vnd(costing.totalMaterialCost)}</b></div>
                <div className="p-3 rounded border flex items-center gap-2">
                  Dự phòng hao hụt/tăng giá (%):
                  <Input
                    className="w-28 h-8"
                    type="number"
                    value={costValues.material_provision_percent || 0}
                    onChange={(e) => updateCostValue("material_provision_percent", Number(e.target.value || 0))}
                  />
                </div>
                <div className="p-3 rounded border">Dự phòng hao hụt/tăng giá (VND): <b>{vnd(costing.provisionAmount)}</b></div>
                <div className="p-3 rounded border">Total cost NVL: <b>{vnd(costing.totalCostNVL)}</b> ({costing.pctOnCost(costing.totalCostNVL).toFixed(1)}%)</div>

                {costTemplate
                  .filter((line) => !["material_provision_percent", "selling_price"].includes(line.key))
                  .map((line) => {
                    const value = toNumber(costValues[line.key], 0);
                    return (
                      <div key={line.key} className="p-3 rounded border flex items-center justify-between gap-2">
                        <span>{line.label}</span>
                        <div className="flex items-center gap-2">
                          <Input
                            className="w-32 h-8"
                            type="number"
                            value={value}
                            onChange={(e) => updateCostValue(line.key, Number(e.target.value || 0))}
                          />
                          <span className="text-muted-foreground">({costing.pctOnCost(value).toFixed(1)}%)</span>
                        </div>
                      </div>
                    );
                  })}

                <div className="p-3 rounded border">Tổng cost: <b>{vnd(costing.totalCost)}</b></div>
                <div className="p-3 rounded border flex items-center gap-2">
                  Giá bán:
                  <Input
                    className="w-32 h-8"
                    type="number"
                    value={costValues.selling_price || 0}
                    onChange={(e) => updateCostValue("selling_price", Number(e.target.value || 0))}
                  />
                </div>
                <div className="p-3 rounded border">Net profit: <b>{vnd(costing.netProfit)}</b></div>
                <div className="p-3 rounded border">Net profit (% trên giá bán): <b>{costing.netProfitPct.toFixed(2)}%</b></div>
              </div>

              <div className="rounded border p-3">
                <h4 className="font-semibold mb-2">Cost (%) theo nhóm</h4>
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Nhóm</TableHead><TableHead>Giá trị</TableHead><TableHead>Tỷ trọng</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow><TableCell>Total cost NVL</TableCell><TableCell>{vnd(costing.groupCosts.nvl)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.nvl).toFixed(1)}%</TableCell></TableRow>
                    <TableRow><TableCell>Cost bao bì</TableCell><TableCell>{vnd(costing.groupCosts.packaging)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.packaging).toFixed(1)}%</TableCell></TableRow>
                    <TableRow><TableCell>Cost nhân công</TableCell><TableCell>{vnd(costing.groupCosts.labor)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.labor).toFixed(1)}%</TableCell></TableRow>
                    <TableRow><TableCell>Delivery cost</TableCell><TableCell>{vnd(costing.groupCosts.delivery)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.delivery).toFixed(1)}%</TableCell></TableRow>
                    <TableRow><TableCell>Other production cost</TableCell><TableCell>{vnd(costing.groupCosts.otherProduction)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.otherProduction).toFixed(1)}%</TableCell></TableRow>
                    <TableRow><TableCell>Chi phí bán hàng & quản lý</TableCell><TableCell>{vnd(costing.groupCosts.sga)}</TableCell><TableCell>{costing.pctOnCost(costing.groupCosts.sga).toFixed(1)}%</TableCell></TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Hồ sơ ảnh/chứng từ truy xuất</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input type="file" onChange={(e) => e.target.files?.[0] && uploadDoc(e.target.files[0])} />
              <div className="grid md:grid-cols-2 gap-3">
                {documents.map((d) => (
                  <a key={d.id} href={d.document_url} target="_blank" rel="noreferrer" className="border rounded p-3 text-sm hover:bg-muted">
                    <div className="font-medium">{d.document_name}</div>
                    <div className="text-muted-foreground">{d.document_type}</div>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="batch-coding" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Rule sinh mã lô theo format</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Nhóm</TableHead><TableHead>Prefix</TableHead><TableHead>Dấu phân cách</TableHead><TableHead>Số chữ số seq</TableHead></TableRow></TableHeader>
                <TableBody>
                  {patterns.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.material_group}</TableCell>
                      <TableCell><Input value={p.prefix} onChange={(e) => savePattern(p, { prefix: e.target.value })} /></TableCell>
                      <TableCell><Input value={p.separator} onChange={(e) => savePattern(p, { separator: e.target.value })} /></TableCell>
                      <TableCell><Input type="number" value={p.seq_digits} onChange={(e) => savePattern(p, { seq_digits: Number(e.target.value || 3) })} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Tạo batch mới</CardTitle></CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-3">
              <div>
                <Label>SKU thành phẩm</Label>
                <select className="w-full border rounded h-10 px-2" value={batchForm.sku_id} onChange={(e) => setBatchForm({ ...batchForm, sku_id: e.target.value })}>
                  <option value="">-- Chọn SKU --</option>
                  {skus.map((s) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}
                </select>
              </div>
              <div>
                <Label>NSX</Label>
                <Input type="date" value={batchForm.production_date} onChange={(e) => setBatchForm({ ...batchForm, production_date: e.target.value })} />
              </div>
              <div>
                <Label>HSD</Label>
                <Input type="date" value={batchForm.expiry_date} onChange={(e) => setBatchForm({ ...batchForm, expiry_date: e.target.value })} />
              </div>
              <div>
                <Label>Ghi chú</Label>
                <Input value={batchForm.notes} onChange={(e) => setBatchForm({ ...batchForm, notes: e.target.value })} />
              </div>
              <div className="md:col-span-2">
                <Button onClick={createBatch}>Sinh batch + mã hóa</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trace-links" className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Danh sách batch truy xuất</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Mã lô</TableHead><TableHead>SKU</TableHead><TableHead>NSX/HSD</TableHead><TableHead>Link đối tác</TableHead><TableHead>Vật tư</TableHead></TableRow></TableHeader>
                <TableBody>
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono">{b.batch_code}</TableCell>
                      <TableCell>{b.product_skus?.sku_code} - {b.product_skus?.product_name}</TableCell>
                      <TableCell>{b.production_date} / {b.expiry_date || "-"}</TableCell>
                      <TableCell>
                        <Link className="underline" to={`/trace/${b.public_token}`} target="_blank">/trace/{b.public_token}</Link>
                      </TableCell>
                      <TableCell><Button size="sm" variant="outline" onClick={() => loadBatchMaterials(b.id)}>Xem</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {!!batchMaterials.length && (
                <div className="mt-4">
                  <h4 className="font-semibold mb-2">Chi tiết NVL batch</h4>
                  <Table>
                    <TableHeader><TableRow><TableHead>Nhóm</TableHead><TableHead>Tên</TableHead><TableHead>Mã</TableHead><TableHead>Mã lô NVL</TableHead><TableHead>SL</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {batchMaterials.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>{m.material_group}</TableCell>
                          <TableCell>{m.material_name}</TableCell>
                          <TableCell>{m.material_code}</TableCell>
                          <TableCell>{m.material_batch_code}</TableCell>
                          <TableCell>{m.quantity} {m.unit}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{skuForm.id ? "Sửa SKU" : "Tạo SKU"}</DialogTitle></DialogHeader>
          <div className="grid md:grid-cols-2 gap-3">
            <Input placeholder="SKU code" value={skuForm.sku_code || ""} onChange={(e) => setSkuForm({ ...skuForm, sku_code: e.target.value })} />
            <Input placeholder="Tên" value={skuForm.product_name || ""} onChange={(e) => setSkuForm({ ...skuForm, product_name: e.target.value })} />
            <Input placeholder="ĐVT" value={skuForm.unit || ""} onChange={(e) => setSkuForm({ ...skuForm, unit: e.target.value })} />
            <Input placeholder="Base unit" value={skuForm.base_unit || ""} onChange={(e) => setSkuForm({ ...skuForm, base_unit: e.target.value })} />
            <Input type="number" placeholder="Yield %" value={skuForm.yield_percent || 100} onChange={(e) => setSkuForm({ ...skuForm, yield_percent: Number(e.target.value || 100) })} />
            <Input placeholder="Danh mục" value={skuForm.category || ""} onChange={(e) => setSkuForm({ ...skuForm, category: e.target.value })} />
            <Input type="number" placeholder="SL thành phẩm" value={skuForm.finished_output_qty || 1} onChange={(e) => setSkuForm({ ...skuForm, finished_output_qty: Number(e.target.value || 1) })} />
            <Input placeholder="DVT thành phẩm" value={skuForm.finished_output_unit || ""} onChange={(e) => setSkuForm({ ...skuForm, finished_output_unit: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={saveSku}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
