import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkuCostMenuBar } from "@/components/sku-costs/SkuCostMenuBar";
import { useDjangoProducts } from "@/hooks/useDjangoProducts";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

const formatVnd = (value: unknown) => new Intl.NumberFormat("vi-VN").format(Number(value || 0));
const statusTone = (status?: string) => {
  if (status === "active") return "bg-emerald-100 text-emerald-800 ring-emerald-200";
  if (status === "development") return "bg-amber-100 text-amber-800 ring-amber-200";
  if (status === "discontinued") return "bg-slate-100 text-slate-700 ring-slate-200";
  return "bg-muted text-muted-foreground ring-border";
};

type FormState = {
  id?: number;
  sku_code: string;
  name: string;
  category: string;
  unit: string;
  selling_price: string;
  status: string;
};

const emptyForm: FormState = {
  sku_code: "",
  name: "",
  category: "other",
  unit: "piece",
  selling_price: "0",
  status: "active",
};

export default function SkuCostsProducts() {
  const { data, isLoading, isError, refetch } = useDjangoProducts();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [unitFilter, setUnitFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const categories = Array.from(new Set((data || []).map((p: any) => p.category).filter(Boolean)));
  const units = Array.from(new Set((data || []).map((p: any) => p.unit).filter(Boolean)));

  const filtered = useMemo(() => {
    const items = data || [];
    return items.filter((p: any) => {
      const q = search.toLowerCase();
      const matchSearch = !q || `${p.sku_code} ${p.name}`.toLowerCase().includes(q);
      const matchCategory = categoryFilter === "all" || p.category === categoryFilter;
      const matchUnit = unitFilter === "all" || p.unit === unitFilter;
      const matchStatus = statusFilter === "all" || p.status === statusFilter;
      return matchSearch && matchCategory && matchUnit && matchStatus;
    });
  }, [data, search, categoryFilter, unitFilter, statusFilter]);

  const openCreate = () => {
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (p: any) => {
    setForm({
      id: p.id,
      sku_code: p.sku_code || "",
      name: p.name || "",
      category: p.category || "other",
      unit: p.unit || "piece",
      selling_price: String(p.selling_price || 0),
      status: p.status || "active",
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = {
      sku_code: form.sku_code,
      name: form.name,
      category: form.category,
      unit: form.unit,
      selling_price: Number(form.selling_price || 0),
      status: form.status,
    };
    if (form.id) {
      await fetch(`${API_BASE}/products/api/${form.id}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch(`${API_BASE}/products/api/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setOpen(false);
    refetch();
  };

  const remove = async (id: number) => {
    await fetch(`${API_BASE}/products/api/${id}/`, { method: "DELETE" });
    refetch();
  };

  return (
    <div className="space-y-4 px-1 sm:space-y-6 sm:px-0">
      <SkuCostMenuBar />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary/70">SKU Costs</p>
          <h1 className="mt-1 text-xl font-bold tracking-[-0.02em] sm:text-2xl">SKU thành phẩm</h1>
          <p className="mt-1 text-sm text-muted-foreground">Quản lý mã, giá bán, danh mục và trạng thái sản phẩm.</p>
        </div>
        <Button className="h-11 w-full sm:w-auto" onClick={openCreate}>Thêm sản phẩm</Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base sm:text-lg">Bộ lọc</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input className="h-11" placeholder="Tìm kiếm SKU hoặc tên" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-11"><SelectValue placeholder="Danh mục" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả danh mục</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={unitFilter} onValueChange={setUnitFilter}>
            <SelectTrigger className="h-11"><SelectValue placeholder="Đơn vị" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả đơn vị</SelectItem>
              {units.map((u) => (
                <SelectItem key={u} value={u}>{u}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-11"><SelectValue placeholder="Trạng thái" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="development">Development</SelectItem>
              <SelectItem value="discontinued">Discontinued</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div>
            <CardTitle className="text-base sm:text-lg">Sản phẩm</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{filtered.length} / {(data || []).length} SKU</p>
          </div>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {isError && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">Không tải được dữ liệu.</div>}
          {isLoading && <Skeleton className="h-24 w-full rounded-2xl" />}
          {!isLoading && filtered && (
            <>
              <div className="hidden overflow-x-auto rounded-xl border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Tên</TableHead>
                      <TableHead>Danh mục</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead>Giá bán</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="text-right">Hành động</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Không tìm thấy SKU phù hợp.</TableCell></TableRow>}
                    {filtered.map((p: any) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.sku_code}</TableCell>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>{p.category}</TableCell>
                        <TableCell>{p.unit || "-"}</TableCell>
                        <TableCell>{formatVnd(p.selling_price)}</TableCell>
                        <TableCell>{p.status}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => openEdit(p)}>Sửa</Button>
                            <Button variant="destructive" size="sm" onClick={() => remove(p.id)}>Xoá</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-3 md:hidden">
                {filtered.length === 0 && <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Không tìm thấy SKU phù hợp.</div>}
                {filtered.map((p: any) => (
                  <article key={p.id} className="rounded-2xl border bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-[11px] font-bold text-muted-foreground">{p.sku_code || p.id}</p>
                        <h2 className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug">{p.name}</h2>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusTone(p.status)}`}>{p.status || "—"}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl bg-muted/45 p-2">
                        <div className="text-muted-foreground">Giá bán</div>
                        <div className="mt-1 text-base font-bold text-primary">{formatVnd(p.selling_price)}</div>
                      </div>
                      <div className="rounded-xl bg-muted/45 p-2">
                        <div className="text-muted-foreground">Đơn vị</div>
                        <div className="mt-1 font-semibold">{p.unit || "-"}</div>
                      </div>
                      <div className="col-span-2 rounded-xl bg-muted/45 p-2">
                        <div className="text-muted-foreground">Danh mục</div>
                        <div className="mt-1 font-semibold break-words">{p.category || "-"}</div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button className="h-10" variant="outline" size="sm" onClick={() => openEdit(p)}>Sửa</Button>
                      <Button className="h-10" variant="destructive" size="sm" onClick={() => remove(p.id)}>Xoá</Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl p-4 sm:max-w-2xl sm:p-6">
          <DialogHeader>
            <DialogTitle>{form.id ? "Cập nhật sản phẩm" : "Thêm sản phẩm"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input className="h-11" placeholder="SKU" value={form.sku_code} onChange={(e) => setForm({ ...form, sku_code: e.target.value })} />
            <Input className="h-11" placeholder="Tên" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input className="h-11" placeholder="Danh mục" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <Input className="h-11" placeholder="Đơn vị" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            <Input className="h-11" placeholder="Giá bán" value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} />
            <Input className="h-11" placeholder="Trạng thái" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button className="w-full sm:w-auto" onClick={save}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
