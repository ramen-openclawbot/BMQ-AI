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
import { useDjangoIngredients } from "@/hooks/useDjangoIngredients";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

type FormState = {
  id?: number;
  name: string;
  category: string;
  unit: string;
  current_stock: string;
  minimum_stock: string;
  current_cost_per_unit: string;
};

const emptyForm: FormState = {
  name: "",
  category: "other",
  unit: "kg",
  current_stock: "0",
  minimum_stock: "0",
  current_cost_per_unit: "0",
};

export default function SkuCostsIngredients() {
  const { data, isLoading, isError, refetch } = useDjangoIngredients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [unitFilter, setUnitFilter] = useState("all");

  const categories = Array.from(new Set((data || []).map((i: any) => i.category).filter(Boolean)));
  const units = Array.from(new Set((data || []).map((i: any) => i.unit).filter(Boolean)));

  const filtered = useMemo(() => {
    const items = data || [];
    return items.filter((i: any) => {
      const q = search.toLowerCase();
      const matchSearch = !q || `${i.name}`.toLowerCase().includes(q);
      const matchCategory = categoryFilter === "all" || i.category === categoryFilter;
      const matchUnit = unitFilter === "all" || i.unit === unitFilter;
      return matchSearch && matchCategory && matchUnit;
    });
  }, [data, search, categoryFilter, unitFilter]);

  const openCreate = () => {
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (i: any) => {
    setForm({
      id: i.id,
      name: i.name || "",
      category: i.category || "other",
      unit: i.unit || "kg",
      current_stock: String(i.current_stock || 0),
      minimum_stock: String(i.minimum_stock || 0),
      current_cost_per_unit: String(i.current_cost_per_unit || 0),
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = {
      name: form.name,
      category: form.category,
      unit: form.unit,
      current_stock: Number(form.current_stock || 0),
      minimum_stock: Number(form.minimum_stock || 0),
      current_cost_per_unit: Number(form.current_cost_per_unit || 0),
    };
    if (form.id) {
      await fetch(`${API_BASE}/inventory/ingredients/api/${form.id}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch(`${API_BASE}/inventory/ingredients/api/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setOpen(false);
    refetch();
  };

  const remove = async (id: number) => {
    await fetch(`${API_BASE}/inventory/ingredients/api/${id}/`, { method: "DELETE" });
    refetch();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Nguyên liệu</CardTitle>
          <Button onClick={openCreate}>Thêm nguyên liệu</Button>
        </CardHeader>
        <CardContent>
          {isError && <div className="text-sm text-red-500">Không tải được dữ liệu.</div>}
          {isLoading && <Skeleton className="h-8 w-full" />}
          {!isLoading && filtered && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tên</TableHead>
                  <TableHead>Danh mục</TableHead>
                  <TableHead>Đơn vị</TableHead>
                  <TableHead>Tồn kho</TableHead>
                  <TableHead>Tối thiểu</TableHead>
                  <TableHead>Giá/đv</TableHead>
                  <TableHead>Hành động</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.name}</TableCell>
                    <TableCell>{i.category}</TableCell>
                    <TableCell>{i.unit}</TableCell>
                    <TableCell>{i.current_stock}</TableCell>
                    <TableCell>{i.minimum_stock}</TableCell>
                    <TableCell>{new Intl.NumberFormat('vi-VN').format(i.current_cost_per_unit)}</TableCell>
                    <TableCell className="space-x-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(i)}>Sửa</Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(i.id)}>Xoá</Button>
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
            <DialogTitle>{form.id ? "Cập nhật nguyên liệu" : "Thêm nguyên liệu"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder="Tên" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="Danh mục" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <Input placeholder="Đơn vị" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            <Input placeholder="Tồn kho" value={form.current_stock} onChange={(e) => setForm({ ...form, current_stock: e.target.value })} />
            <Input placeholder="Tối thiểu" value={form.minimum_stock} onChange={(e) => setForm({ ...form, minimum_stock: e.target.value })} />
            <Input placeholder="Giá/đv" value={form.current_cost_per_unit} onChange={(e) => setForm({ ...form, current_cost_per_unit: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={save}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
