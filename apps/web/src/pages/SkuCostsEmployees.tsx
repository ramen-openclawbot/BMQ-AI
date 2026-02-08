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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input placeholder="Tên hoặc mã" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger><SelectValue placeholder="Vai trò" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả vai trò</SelectItem>
              <SelectItem value="baker">Baker</SelectItem>
              <SelectItem value="assistant">Assistant</SelectItem>
              <SelectItem value="decorator">Decorator</SelectItem>
              <SelectItem value="packer">Packer</SelectItem>
              <SelectItem value="supervisor">Supervisor</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger><SelectValue placeholder="Trạng thái" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Nhân sự</CardTitle>
          <Button onClick={openCreate}>Thêm nhân sự</Button>
        </CardHeader>
        <CardContent>
          {isError && <div className="text-sm text-red-500">Không tải được dữ liệu.</div>}
          {isLoading && <Skeleton className="h-8 w-full" />}
          {!isLoading && filtered && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã NV</TableHead>
                  <TableHead>Tên</TableHead>
                  <TableHead>Vai trò</TableHead>
                  <TableHead>Ngày vào</TableHead>
                  <TableHead>Base rate</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Hành động</TableHead>
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
                      <Button variant="outline" size="sm" onClick={() => openEdit(e)}>Sửa</Button>
                      <Button variant="destructive" size="sm" onClick={() => remove(e.id)}>Xoá</Button>
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
            <DialogTitle>{form.id ? "Cập nhật nhân sự" : "Thêm nhân sự"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder="Mã NV" value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} />
            <Input placeholder="Tên" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger><SelectValue placeholder="Vai trò" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="baker">Baker</SelectItem>
                <SelectItem value="assistant">Assistant</SelectItem>
                <SelectItem value="decorator">Decorator</SelectItem>
                <SelectItem value="packer">Packer</SelectItem>
                <SelectItem value="supervisor">Supervisor</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <Input type="date" value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} />
            <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Select value={form.wage_type} onValueChange={(v) => setForm({ ...form, wage_type: v })}>
              <SelectTrigger><SelectValue placeholder="Loại lương" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="monthly_salary">Monthly Salary</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Base rate" value={form.base_rate} onChange={(e) => setForm({ ...form, base_rate: e.target.value })} />
          </div>
          <DialogFooter>
            <Button onClick={save}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
