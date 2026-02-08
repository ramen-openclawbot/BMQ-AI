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
import { useDjangoProducts } from "@/hooks/useDjangoProducts";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input placeholder="Tìm kiếm" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger><SelectValue placeholder="Danh mục" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả danh mục</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={unitFilter} onValueChange={setUnitFilter}>
            <SelectTrigger><SelectValue placeholder="Đơn vị" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả đơn vị</SelectItem>
              {units.map((u) => (
                <SelectItem key={u} value={u}>{u}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger><SelectValue placeholder="Trạng thái" /></SelectTrigger>
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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Sản phẩm</CardTitle>
          <Button onClick={openCreate}>Thêm sản phẩm</Button>
        </CardHeader>
        <CardContent>
          {isError && <div className="text-sm text-red-500">Không tải được dữ liệu.</div>}
          {isLoading && <Skeleton className="h-8 w-full" />}
          {!isLoading && filtered && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Tên</TableHead>
                  <TableHead>Danh mục</TableHead>
                  <TableHead>Đơn vị</TableHead>
                  <TableHead>Giá bán</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Hành động</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.sku_code}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.category}</TableCell>
                    <TableCell>{p.unit || "-"}</TableCell>
                    <TableCell>{new Intl.NumberFormat('vi-VN').format(p.selling_price || 0)}</TableCell>
                    <TableCell>{p.status}</TableCell>
                    <TableCell className="space-x-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(p)}>Sửa</Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(p.id)}>Xoá</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Cập nhật sản phẩm" : "Thêm sản phẩm"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder="SKU" value={form.sku_code} onChange={(e) => setForm({ ...form, sku_code: e.target.value })} />
            <Input placeholder="Tên" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="Danh mục" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <Input placeholder="Đơn vị" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            <Input placeholder="Giá bán" value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} />
            <Input placeholder="Trạng thái" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={save}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
