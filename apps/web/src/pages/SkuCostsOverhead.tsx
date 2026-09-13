import { useDSkuCopy } from "@/i18n/useDSkuCopy";
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
import { useDjangoOverhead } from "@/hooks/useDjangoOverhead";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

type FormState = {
  id?: number;
  category_id: string;
  category: string;
  amount: string;
  month: string;
};

const emptyForm: FormState = {
  category_id: "",
  category: "",
  amount: "0",
  month: "",
};

export default function SkuCostsOverhead() {
  const s = useDSkuCopy();
  const { data, isLoading, isError, refetch } = useDjangoOverhead();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState("all");

  const categories = Array.from(new Set((data || []).map((o: any) => o.category).filter(Boolean)));
  const months = Array.from(new Set((data || []).map((o: any) => o.month).filter(Boolean)));

  const filtered = useMemo(() => {
    const items = data || [];
    return items.filter((o: any) => {
      const matchCategory = categoryFilter === "all" || o.category === categoryFilter;
      const matchMonth = monthFilter === "all" || o.month === monthFilter;
      return matchCategory && matchMonth;
    });
  }, [data, categoryFilter, monthFilter]);

  const openCreate = () => {
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (o: any) => {
    setForm({
      id: o.id,
      category_id: String(o.category_id || ""),
      category: o.category || "",
      amount: String(o.amount || 0),
      month: o.month || "",
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = {
      category_id: Number(form.category_id || 0),
      amount: Number(form.amount || 0),
      month: form.month || null,
    };
    if (form.id) {
      await fetch(`${API_BASE}/overhead/costs/api/${form.id}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch(`${API_BASE}/overhead/costs/api/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setOpen(false);
    refetch();
  };

  const remove = async (id: number) => {
    await fetch(`${API_BASE}/overhead/costs/api/${id}/`, { method: "DELETE" });
    refetch();
  };

  return (
    <div data-i18n-version="d-sku-v1" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{s.filters}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger><SelectValue placeholder={s.costCategory} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{s.allGroups}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger><SelectValue placeholder={s.month} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{s.allMonths}</SelectItem>
              {months.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{s.overhead}</CardTitle>
          <Button onClick={openCreate}>{s.addCost}</Button>
        </CardHeader>
        <CardContent>
          {isError && <div className="text-sm text-red-500">{s.loadError}</div>}
          {isLoading && <Skeleton className="h-8 w-full" />}
          {!isLoading && filtered && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.group}</TableHead>
                  <TableHead>{s.month}</TableHead>
                  <TableHead>{s.cost}</TableHead>
                  <TableHead>{s.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((o: any) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.category}</TableCell>
                    <TableCell>{o.month || "-"}</TableCell>
                    <TableCell>{new Intl.NumberFormat('vi-VN').format(o.amount)}</TableCell>
                    <TableCell className="space-x-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(o)}>{s.edit}</Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(o.id)}>{s.delete}</Button>
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
            <DialogTitle>{form.id ? s.updateCost : s.addCost}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder={s.categoryId} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} />
            <Input placeholder={s.monthFormat} value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
            <Input placeholder={s.amount} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={save}>{s.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
