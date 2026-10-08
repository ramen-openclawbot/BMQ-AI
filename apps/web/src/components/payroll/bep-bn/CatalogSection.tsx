import { useState } from "react";
import { Loader2, PencilLine, Smartphone, UserPlus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { EmploymentType, PayrollEmployee, PayrollGroup } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnEmployeeContact, BepBnPeriodData } from "./types";
import { formatAdjustmentValue } from "./format";

const GROUPS: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

interface CatalogSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
  /** Payroll editors and the owner: register the phone each employee uses at payroll.banhmique.vn. */
  canManagePhones?: boolean;
}

export function CatalogSection({ data, source, canEdit, canManagePhones = false }: CatalogSectionProps) {
  const [editing, setEditing] = useState<PayrollEmployee | null>(null);
  const [open, setOpen] = useState(false);
  const [phoneFor, setPhoneFor] = useState<PayrollEmployee | null>(null);
  const contactByCode = new Map(source.contacts.map((contact) => [contact.employeeCode, contact]));
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
            {canManagePhones ? " Số điện thoại dùng chung mọi kỳ để nhân viên xem phiếu lương tại payroll.banhmique.vn." : null}
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
                  {canManagePhones ? (
                    <th className="min-w-[170px] px-3 py-2 text-left font-medium">SĐT xem phiếu lương</th>
                  ) : null}
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
                    {canManagePhones ? (
                      <td className="px-3 py-2">
                        <PhoneCell contact={contactByCode.get(employee.code)} onEdit={() => setPhoneFor(employee)} name={employee.name} />
                      </td>
                    ) : null}
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
      {canManagePhones ? (
        <PhoneDialog
          employee={phoneFor}
          contact={phoneFor ? contactByCode.get(phoneFor.code) : undefined}
          source={source}
          onClose={() => setPhoneFor(null)}
        />
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
  const missingPay =
    employee.employmentType === "part_time"
      ? employee.hourlyRate === null || employee.hourlyRate === undefined
      : employee.monthlySalary === null || employee.monthlySalary === undefined;
  if (missingPay) {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
        {employee.employmentType === "part_time" ? "Chưa có đơn giá giờ" : "Chưa có lương"}
      </Badge>
    );
  }
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

/** 84xxxxxxxxx → 0xxx xxx xxx for display. */
function displayPhone(phone: string): string {
  const local = phone.startsWith("84") ? `0${phone.slice(2)}` : phone;
  return local.replace(/^(\d{4})(\d{3})(\d+)$/, "$1 $2 $3");
}

function PhoneCell({ contact, onEdit, name }: { contact?: BepBnEmployeeContact; onEdit: () => void; name: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      {contact ? (
        <div className="min-w-0">
          <div className={cn("whitespace-nowrap tabular-nums", !contact.active && "text-muted-foreground line-through")}>
            {displayPhone(contact.phone)}
          </div>
          {!contact.active ? <div className="text-xs text-muted-foreground">Đang tắt</div> : null}
        </div>
      ) : (
        <span className="text-muted-foreground">Chưa có</span>
      )}
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onEdit} aria-label={`Số điện thoại của ${name}`}>
        <Smartphone className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function PhoneDialog({
  employee,
  contact,
  source,
  onClose,
}: {
  employee: PayrollEmployee | null;
  contact?: BepBnEmployeeContact;
  source: BepBnDataSource;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Re-hydrate the draft every time the dialog opens for an employee.
  if (employee && openedFor !== employee.code) {
    setOpenedFor(employee.code);
    setPhone(contact ? displayPhone(contact.phone) : "");
    setActive(contact?.active ?? true);
    setError(null);
  }
  if (!employee && openedFor !== null) setOpenedFor(null);

  const run = async (action: () => Promise<void>, done: string) => {
    setSaving(true);
    setError(null);
    try {
      await action();
      toast({ title: done });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={employee !== null} onOpenChange={(next) => (!next && !saving ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Số điện thoại xem phiếu lương</DialogTitle>
          <DialogDescription>
            {employee ? `${employee.name} · ${employee.code}. ` : ""}Nhân viên dùng số này để nhận mã OTP qua Zalo tại payroll.banhmique.vn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="payslip-contact-phone">Số điện thoại</Label>
            <Input
              id="payslip-contact-phone"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="09xx xxx xxx"
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <Label htmlFor="payslip-contact-active" className="font-normal">
              Cho phép đăng nhập
              <span className="block text-xs text-muted-foreground">Tắt để chặn ngay, kể cả khi nhân viên đang đăng nhập.</span>
            </Label>
            <Switch id="payslip-contact-active" checked={active} onCheckedChange={setActive} />
          </div>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between sm:gap-0">
          {contact && employee ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={saving}
              onClick={() => void run(() => source.deleteContact(employee.code), "Đã xoá số điện thoại")}
            >
              Xoá số
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Huỷ
            </Button>
            <Button
              className="gap-2"
              disabled={saving || phone.trim() === "" || !employee}
              onClick={() =>
                employee
                  ? void run(() => source.upsertContact({ employeeCode: employee.code, phone, active }), "Đã lưu số điện thoại")
                  : undefined
              }
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Lưu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
