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
import { useDjangoEmployees } from "@/hooks/useDjangoEmployees";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

type FormState = {
  id?: number;
  employee_id: string;
  name: string;
  role: string;
  hire_date: string;
  phone: string;
  email: string;
  wage_type: string;
  base_rate: string;
};

const emptyForm: FormState = {
  employee_id: "",
  name: "",
  role: "baker",
  hire_date: "",
  phone: "",
  email: "",
  wage_type: "monthly_salary",
  base_rate: "0",
};

export default function SkuCostsEmployees() {
  const s = useDSkuCopy();
  const { data, isLoading, isError, refetch } = useDjangoEmployees();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    const items = data || [];
    return items.filter((e: any) => {
      const q = search.toLowerCase();
      const matchSearch = !q || `${e.employee_id} ${e.name}`.toLowerCase().includes(q);
      const matchRole = roleFilter === "all" || e.role === roleFilter;
      const matchStatus = statusFilter === "all" || e.status === statusFilter;
      return matchSearch && matchRole && matchStatus;
    });
  }, [data, search, roleFilter, statusFilter]);

  const openCreate = () => {
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (e: any) => {
    setForm({
      id: e.id,
      employee_id: e.employee_id || "",
      name: e.name || "",
      role: e.role || "baker",
      hire_date: (e.hire_date || "").slice(0, 10),
      phone: e.phone || "",
      email: e.email || "",
      wage_type: e.wage_type || "monthly_salary",
      base_rate: String(e.base_rate || 0),
    });
    setOpen(true);
  };

  const save = async () => {
    const payload = {
      employee_id: form.employee_id,
      name: form.name,
      role: form.role,
      hire_date: form.hire_date,
      phone: form.phone,
      email: form.email,
      wage_type: form.wage_type,
      base_rate: Number(form.base_rate || 0),
    };
    if (form.id) {
      await fetch(`${API_BASE}/labor/employees/api/${form.id}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch(`${API_BASE}/labor/employees/api/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    setOpen(false);
    refetch();
  };

  const remove = async (id: number) => {
    await fetch(`${API_BASE}/labor/employees/api/${id}/`, { method: "DELETE" });
    refetch();
  };

  return (
    <div data-i18n-version="d-sku-v1" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{s.filters}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input placeholder={s.searchNameCode} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger><SelectValue placeholder={s.role} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{s.allRoles}</SelectItem>
              <SelectItem value="baker">{s.baker}</SelectItem>
              <SelectItem value="assistant">{s.assistant}</SelectItem>
              <SelectItem value="decorator">{s.decorator}</SelectItem>
              <SelectItem value="packer">{s.packer}</SelectItem>
              <SelectItem value="supervisor">{s.supervisor}</SelectItem>
              <SelectItem value="other">{s.other}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger><SelectValue placeholder={s.status} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{s.all}</SelectItem>
              <SelectItem value="active">{s.active}</SelectItem>
              <SelectItem value="inactive">{s.inactive}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{s.employees}</CardTitle>
          <Button onClick={openCreate}>{s.addEmployee}</Button>
        </CardHeader>
        <CardContent>
          {isError && <div className="text-sm text-red-500">{s.loadError}</div>}
          {isLoading && <Skeleton className="h-8 w-full" />}
          {!isLoading && filtered && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.employeeCode}</TableHead>
                  <TableHead>{s.name}</TableHead>
                  <TableHead>{s.role}</TableHead>
                  <TableHead>{s.hireDate}</TableHead>
                  <TableHead>{s.baseRate}</TableHead>
                  <TableHead>{s.status}</TableHead>
                  <TableHead>{s.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.employee_id}</TableCell>
                    <TableCell>{e.name}</TableCell>
                    <TableCell>{e.role}</TableCell>
                    <TableCell>{e.hire_date}</TableCell>
                    <TableCell>{new Intl.NumberFormat('vi-VN').format(e.base_rate || 0)}</TableCell>
                    <TableCell>{e.status}</TableCell>
                    <TableCell className="space-x-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(e)}>{s.edit}</Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(e.id)}>{s.delete}</Button>
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
            <DialogTitle>{form.id ? s.updateEmployee : s.addEmployee}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder={s.employeeCode} value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} />
            <Input placeholder={s.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger><SelectValue placeholder={s.role} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="baker">{s.baker}</SelectItem>
                <SelectItem value="assistant">{s.assistant}</SelectItem>
                <SelectItem value="decorator">{s.decorator}</SelectItem>
                <SelectItem value="packer">{s.packer}</SelectItem>
                <SelectItem value="supervisor">{s.supervisor}</SelectItem>
                <SelectItem value="other">{s.other}</SelectItem>
              </SelectContent>
            </Select>
            <Input type="date" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} />
            <Input placeholder={s.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder={s.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Select value={form.wage_type} onValueChange={(v) => setForm({ ...form, wage_type: v })}>
              <SelectTrigger><SelectValue placeholder={s.wageType} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">{s.hourly}</SelectItem>
                <SelectItem value="monthly_salary">{s.monthlySalary}</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder={s.baseRate} value={form.base_rate} onChange={(e) => setForm({ ...form, base_rate: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={save}>{s.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
