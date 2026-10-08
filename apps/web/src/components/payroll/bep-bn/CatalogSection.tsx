import { useState } from "react";
import { Loader2, PencilLine, UserPlus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { EmploymentType, PayrollEmployee, PayrollGroup } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";
import { formatAdjustmentValue } from "./format";

const GROUPS: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

interface CatalogSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
}

export function CatalogSection({ data, source, canEdit }: CatalogSectionProps) {
  const [editing, setEditing] = useState<PayrollEmployee | null>(null);
  const [open, setOpen] = useState(false);
  const canChange = canEdit && data.period.status !== "locked";

  const openEditor = (employee: PayrollEmployee | null) => {
    setEditing(employee);
    setOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Danh mục nhân viên kỳ {data.period.code}</CardTitle>
          <CardDescription>
            Mã chấm công, nhóm, loại, lương và đơn giá lưu riêng cho từng kỳ; sửa kỳ này không ảnh hưởng kỳ khác.
          </CardDescription>
        </div>
        {canChange ? (
          <Button variant="outline" className="gap-2 self-start" onClick={() => openEditor(null)}>
            <UserPlus className="h-4 w-4" />
            Thêm nhân viên
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {data.employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kỳ này chưa có nhân viên. Thêm nhân viên trước khi lập bảng lương.</p>
        ) : (
          <div className="max-h-[520px] overflow-auto rounded-md border">
            <table className="w-max min-w-full border-collapse text-sm">
              <thead className="text-xs [&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-card [&_th]:shadow-[inset_0_-1px_0_hsl(var(--border))] [&_th:first-child]:z-30">
                <tr>
                  <th className="left-0 min-w-[132px] px-3 py-2 text-left font-medium sm:min-w-[180px]">Nhân viên</th>
                  <th className="px-3 py-2 text-left font-medium">Nhóm</th>
                  <th className="px-3 py-2 text-left font-medium">Loại</th>
                  <th className="min-w-[110px] px-3 py-2 text-right font-medium">Lương chính thức</th>
                  <th className="min-w-[96px] px-3 py-2 text-right font-medium">Đơn giá giờ</th>
                  <th className="min-w-[96px] px-3 py-2 text-right font-medium">Đơn giá TC</th>
                  <th className="min-w-[96px] px-3 py-2 text-right font-medium">Phụ cấp</th>
                  <th className="min-w-[150px] px-3 py-2 text-left font-medium">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr key={employee.code} className="border-t">
                    <td className="sticky left-0 z-10 max-w-[150px] bg-card px-3 py-2 sm:max-w-none">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate">{employee.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{employee.code}</div>
                        </div>
                        {canChange ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={() => openEditor(employee)}
                            aria-label={`Sửa ${employee.name}`}
                          >
                            <PencilLine className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{employee.group}</td>
                    <td className="whitespace-nowrap px-3 py-2">{employee.employmentType === "part_time" ? "Part-time" : "Chính thức"}</td>
                    <MoneyCell value={employee.monthlySalary} />
                    <MoneyCell value={employee.hourlyRate} />
                    <MoneyCell value={employee.overtimeRate} />
                    <MoneyCell value={employee.allowance} />
                    <td className="px-3 py-2 text-xs">
                      <EmployeeStatus employee={employee} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {canChange ? (
        <EmployeeDialog open={open} onOpenChange={setOpen} employee={editing} data={data} source={source} />
      ) : null}
    </Card>
  );
}

function MoneyCell({ value }: { value: number | null | undefined }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      {value === null || value === undefined || value === 0 ? "–" : formatAdjustmentValue(value)}
    </td>
  );
}

function EmployeeStatus({ employee }: { employee: PayrollEmployee }) {
  if (employee.terminated) return <Badge variant="secondary">Nghỉ việc</Badge>;
  const parts: string[] = [];
  if (employee.startDate) parts.push(`Từ ${employee.startDate.split("-").reverse().join("/")}`);
  if (employee.endDate) parts.push(`đến ${employee.endDate.split("-").reverse().join("/")}`);
  return <span className="text-muted-foreground">{parts.length > 0 ? parts.join(" ") : "Đang làm"}</span>;
}

interface EmployeeForm {
  code: string;
  name: string;
  group: PayrollGroup;
  employmentType: EmploymentType;
  monthlySalary: string;
  hourlyRate: string;
  overtimeRate: string;
  allowance: string;
  startDate: string;
  endDate: string;
}

function toForm(employee: PayrollEmployee | null): EmployeeForm {
  const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
  return {
    code: employee?.code ?? "",
    name: employee?.name ?? "",
    group: employee?.group ?? "Bếp bánh",
    employmentType: employee?.employmentType ?? "official",
    monthlySalary: text(employee?.monthlySalary),
    hourlyRate: text(employee?.hourlyRate),
    overtimeRate: text(employee?.overtimeRate),
    allowance: text(employee?.allowance),
    startDate: employee?.startDate ?? "",
    endDate: employee?.endDate ?? "",
  };
}

function parseAmount(value: string): number | null | "invalid" {
  const cleaned = value.replace(/[.\s]/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? number : "invalid";
}

function EmployeeDialog({
  open,
  onOpenChange,
  employee,
  data,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: PayrollEmployee | null;
  data: BepBnPeriodData;
  source: BepBnDataSource;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<EmployeeForm>(() => toForm(employee));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm(toForm(employee));
      setTouched(false);
    }
  }

  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const isPartTime = form.employmentType === "part_time";
  const amounts = {
    monthlySalary: parseAmount(form.monthlySalary),
    hourlyRate: parseAmount(form.hourlyRate),
    overtimeRate: parseAmount(form.overtimeRate),
    allowance: parseAmount(form.allowance),
  };
  const duplicate = !employee && data.employees.some((item) => item.code === form.code.trim());
  const errors = {
    code: form.code.trim() === "" ? "Nhập mã chấm công." : duplicate ? "Mã này đã có trong kỳ." : null,
    name: form.name.trim() === "" ? "Nhập họ tên." : null,
    monthlySalary:
      amounts.monthlySalary === "invalid" ? "Số không hợp lệ." : !isPartTime && amounts.monthlySalary === null ? "Nhập lương chính thức." : null,
    hourlyRate:
      amounts.hourlyRate === "invalid" ? "Số không hợp lệ." : isPartTime && amounts.hourlyRate === null ? "Nhập đơn giá giờ." : null,
    overtimeRate: amounts.overtimeRate === "invalid" ? "Số không hợp lệ." : null,
    allowance: amounts.allowance === "invalid" ? "Số không hợp lệ." : null,
    endDate: form.endDate && form.startDate && form.endDate < form.startDate ? "Ngày nghỉ phải sau ngày bắt đầu." : null,
  };
  const valid = Object.values(errors).every((error) => error === null);

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    const number = (value: number | null | "invalid") => (value === "invalid" ? null : value);
    setSaving(true);
    try {
      await source.upsertEmployee(data.id, {
        code: form.code.trim(),
        name: form.name.trim(),
        group: form.group,
        employmentType: form.employmentType,
        monthlySalary: isPartTime ? null : number(amounts.monthlySalary),
        hourlyRate: isPartTime ? number(amounts.hourlyRate) : null,
        overtimeRate: isPartTime ? null : number(amounts.overtimeRate),
        allowance: number(amounts.allowance),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
      });
      toast({ title: employee ? "Đã cập nhật nhân viên" : "Đã thêm nhân viên" });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Không lưu được nhân viên",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const show = (error: string | null) => (touched && error ? <p className="text-xs text-destructive">{error}</p> : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{employee ? `Sửa ${employee.name}` : "Thêm nhân viên vào kỳ"}</DialogTitle>
          <DialogDescription>Chỉ áp dụng cho kỳ {data.period.code}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-code">Mã chấm công</Label>
            <Input id="bep-bn-emp-code" value={form.code} disabled={Boolean(employee)} onChange={(event) => set("code", event.target.value)} placeholder="00001" />
            {show(errors.code)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-name">Họ tên</Label>
            <Input id="bep-bn-emp-name" value={form.name} onChange={(event) => set("name", event.target.value)} />
            {show(errors.name)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-group">Nhóm</Label>
            <Select value={form.group} onValueChange={(value) => set("group", value as PayrollGroup)}>
              <SelectTrigger id="bep-bn-emp-group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map((group) => (
                  <SelectItem key={group} value={group}>
                    {group}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-type">Loại</Label>
            <Select value={form.employmentType} onValueChange={(value) => set("employmentType", value as EmploymentType)}>
              <SelectTrigger id="bep-bn-emp-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="official">Chính thức</SelectItem>
                <SelectItem value="part_time">Part-time</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isPartTime ? (
            <div className="space-y-2">
              <Label htmlFor="bep-bn-emp-hourly">Đơn giá giờ</Label>
              <Input id="bep-bn-emp-hourly" inputMode="numeric" value={form.hourlyRate} onChange={(event) => set("hourlyRate", event.target.value)} placeholder="25.000" />
              {show(errors.hourlyRate)}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="bep-bn-emp-salary">Lương chính thức</Label>
                <Input id="bep-bn-emp-salary" inputMode="numeric" value={form.monthlySalary} onChange={(event) => set("monthlySalary", event.target.value)} placeholder="8.000.000" />
                {show(errors.monthlySalary)}
              </div>
              <div className="space-y-2">
                <Label htmlFor="bep-bn-emp-ot">Đơn giá tăng ca / giờ</Label>
                <Input id="bep-bn-emp-ot" inputMode="numeric" value={form.overtimeRate} onChange={(event) => set("overtimeRate", event.target.value)} placeholder="Bỏ trống nếu không tính TC" />
                {show(errors.overtimeRate)}
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-allowance">Phụ cấp</Label>
            <Input id="bep-bn-emp-allowance" inputMode="numeric" value={form.allowance} onChange={(event) => set("allowance", event.target.value)} placeholder="0" />
            {show(errors.allowance)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-start">Bắt đầu làm từ</Label>
            <Input id="bep-bn-emp-start" type="date" className="min-w-0" value={form.startDate} onChange={(event) => set("startDate", event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-emp-end">Nghỉ việc từ sau ngày</Label>
            <Input id="bep-bn-emp-end" type="date" className="min-w-0" value={form.endDate} onChange={(event) => set("endDate", event.target.value)} />
            {show(errors.endDate)}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Huỷ
          </Button>
          <Button onClick={() => void submit()} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
