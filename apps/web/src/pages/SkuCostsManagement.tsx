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

const calcLineCost = (r: FormulaRow) => {
  const base = Number(r.unit_price || 0) * Number(r.dosage_qty || 0);
  const wastage = Number(r.wastage_percent || 0) / 100;
  return base * (1 + wastage);
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
    packaging_cost_per_unit: 0,
    labor_cost_per_unit: 0,
    delivery_cost_per_unit: 0,
    other_production_cost_per_unit: 0,
    sga_cost_per_unit: 0,
    extra_cost_per_unit: 0,
    selling_price: 0,
  });

  const [batchForm, setBatchForm] = useState<any>({
    sku_id: "",
    production_date: new Date().toISOString().slice(0, 10),
    expiry_date: "",
    notes: "",
  });

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
    const current = skus.find((s) => s.id === activeSkuId) || {};
    const outputQty = Math.max(1, Number(current.finished_output_qty || 1));
    const materialBatchCost = formula.reduce((s, r) => s + calcLineCost(r), 0);
    const materialCost = materialBatchCost / outputQty;
    const packaging = Number(current.packaging_cost_per_unit || 0);
    const labor = Number(current.labor_cost_per_unit || 0);
    const delivery = Number(current.delivery_cost_per_unit || 0);
    const otherProduction = Number(current.other_production_cost_per_unit || 0);
    const sga = Number(current.sga_cost_per_unit || 0);
    const extra = Number(current.extra_cost_per_unit || 0);
    const totalCost = materialCost + packaging + labor + delivery + otherProduction + sga + extra;
    const selling = Number(current.selling_price || 0);
    const netProfit = selling - totalCost;
    const margin = selling > 0 ? (netProfit / selling) * 100 : 0;
    const pct = (v: number) => (totalCost > 0 ? (v / totalCost) * 100 : 0);
    return { materialBatchCost, outputQty, materialCost, packaging, labor, delivery, otherProduction, sga, extra, totalCost, selling, netProfit, margin, pct };
  }, [formula, skus, activeSkuId]);

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
      packaging_cost_per_unit: 0,
      labor_cost_per_unit: 0,
      delivery_cost_per_unit: 0,
      other_production_cost_per_unit: 0,
      sga_cost_per_unit: 0,
      extra_cost_per_unit: 0,
      selling_price: 0,
    });
    setDialogOpen(true);
  };

  const openEditSku = (sku: SKU) => {
    setSkuForm({ ...sku });
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
      <h1 className="text-2xl font-bold">SKU + Batch Coding + Traceability (MVP)</h1>

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
                      <TableCell>{new Intl.NumberFormat("vi-VN").format(Number(s.selling_price || 0))}</TableCell>
                      <TableCell><Button variant="outline" size="sm" onClick={() => openEditSku(s)}>Sửa</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Costing widget</CardTitle>
              <Button variant="outline" onClick={addFormula}>+ Dòng NVL</Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nguyên vật liệu</TableHead><TableHead>ĐVT</TableHead><TableHead>Đơn giá</TableHead><TableHead>Định lượng</TableHead><TableHead>Hao hụt %</TableHead><TableHead>Giá vốn</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {formula.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell><Input value={r.ingredient_name || ""} onChange={(e) => updateFormulaRow(r, { ingredient_name: e.target.value })} /></TableCell>
                      <TableCell><Input value={r.unit || ""} onChange={(e) => updateFormulaRow(r, { unit: e.target.value })} /></TableCell>
                      <TableCell><Input type="number" value={r.unit_price || 0} onChange={(e) => updateFormulaRow(r, { unit_price: Number(e.target.value || 0) })} /></TableCell>
                      <TableCell><Input type="number" value={r.dosage_qty || 0} onChange={(e) => updateFormulaRow(r, { dosage_qty: Number(e.target.value || 0) })} /></TableCell>
                      <TableCell><Input type="number" value={r.wastage_percent || 0} onChange={(e) => updateFormulaRow(r, { wastage_percent: Number(e.target.value || 0) })} /></TableCell>
                      <TableCell>{new Intl.NumberFormat("vi-VN").format(calcLineCost(r))}</TableCell>
                      <TableCell><Button variant="destructive" size="sm" onClick={() => removeFormulaRow(r.id)}>Xóa</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="grid md:grid-cols-2 gap-3 text-sm">
                <div className="p-3 rounded border">Tổng cost NVL/mẻ: <b>{new Intl.NumberFormat("vi-VN").format(costing.materialBatchCost)}</b></div>
                <div className="p-3 rounded border">Thành phẩm: <b>{costing.outputQty}</b> {skus.find((s) => s.id === activeSkuId)?.finished_output_unit || "cái"}</div>
                <div className="p-3 rounded border">Cost NVL/cái: <b>{new Intl.NumberFormat("vi-VN").format(costing.materialCost)}</b> ({costing.pct(costing.materialCost).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Cost bao bì: <b>{new Intl.NumberFormat("vi-VN").format(costing.packaging)}</b> ({costing.pct(costing.packaging).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Cost nhân công: <b>{new Intl.NumberFormat("vi-VN").format(costing.labor)}</b> ({costing.pct(costing.labor).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Delivery cost: <b>{new Intl.NumberFormat("vi-VN").format(costing.delivery)}</b> ({costing.pct(costing.delivery).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Other production: <b>{new Intl.NumberFormat("vi-VN").format(costing.otherProduction)}</b> ({costing.pct(costing.otherProduction).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Chi phí BH&QL: <b>{new Intl.NumberFormat("vi-VN").format(costing.sga)}</b> ({costing.pct(costing.sga).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Chi phí cộng thêm: <b>{new Intl.NumberFormat("vi-VN").format(costing.extra)}</b> ({costing.pct(costing.extra).toFixed(1)}%)</div>
                <div className="p-3 rounded border">Tổng cost/cái: <b>{new Intl.NumberFormat("vi-VN").format(costing.totalCost)}</b></div>
                <div className="p-3 rounded border">Giá bán: <b>{new Intl.NumberFormat("vi-VN").format(costing.selling)}</b></div>
                <div className="p-3 rounded border">Net profit: <b>{new Intl.NumberFormat("vi-VN").format(costing.netProfit)}</b></div>
                <div className="p-3 rounded border">Tỷ trọng lợi nhuận: <b>{costing.margin.toFixed(2)}%</b></div>
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
            <Input type="number" placeholder="Cost bao bì" value={skuForm.packaging_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, packaging_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Cost nhân công" value={skuForm.labor_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, labor_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Delivery cost" value={skuForm.delivery_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, delivery_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Other production cost" value={skuForm.other_production_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, other_production_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Chi phí bán hàng & quản lý" value={skuForm.sga_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, sga_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Chi phí cộng thêm" value={skuForm.extra_cost_per_unit || 0} onChange={(e) => setSkuForm({ ...skuForm, extra_cost_per_unit: Number(e.target.value || 0) })} />
            <Input type="number" placeholder="Giá bán" value={skuForm.selling_price || 0} onChange={(e) => setSkuForm({ ...skuForm, selling_price: Number(e.target.value || 0) })} />
          </div>
          <DialogFooter>
            <Button onClick={saveSku}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
