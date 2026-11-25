import { useMemo, useState, type ReactNode } from "react";
import {
  Building2,
  ChefHat,
  ChevronDown,
  ChevronRight,
  Loader2,
  PencilLine,
  Smartphone,
  Truck,
  UserPlus,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
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
import { summarizeCatalog, type CatalogEmployeeSummary } from "@/lib/payroll-bn/catalog-summary.ts";
import type { BepBnDataSource, BepBnEmployeeContact, BepBnPeriodData } from "./types";
import { formatAdjustmentValue } from "./format";
import { MissionGiftBar, MissionGiftButton, useMissionGifts } from "./MissionGift";

const GROUPS: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN", "Giao hàng"];

function typeLabel(type: EmploymentType): string {
  return type === "part_time" ? "Part-time" : type === "delivery" ? "Giao hàng" : "Chính thức";
}

interface CatalogSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
  /** Payroll editors and the owner: register the phone each employee uses at luong.banhmique.vn. */
  canManagePhones?: boolean;
}

export function CatalogSection({ data, source, canEdit, canManagePhones = false }: CatalogSectionProps) {
  const [editing, setEditing] = useState<PayrollEmployee | null>(null);
  const [open, setOpen] = useState(false);
  const [phoneFor, setPhoneFor] = useState<PayrollEmployee | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<PayrollGroup | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const contactByCode = new Map(source.contacts.map((contact) => [contact.employeeCode, contact]));
  const shiftByCode = new Map((source.shifts ?? []).map((shift) => [shift.employeeCode, shift.shiftStart]));
  const canChange = canEdit && data.period.status !== "locked";
  const canOpenEditor = canChange || canManagePhones;
  // Gifts follow the active mission campaign, not the period lock.
  const gifts = useMissionGifts(canManagePhones);
  const summary = useMemo(
    () =>
      summarizeCatalog({
        period: data.period,
        employees: data.employees,
        rows: data.rows,
        measures: data.measures,
        adjustments: data.adjustments,
      }),
    [data],
  );
  const selected = summary.groups.find((group) => group.group === selectedGroup) ?? null;

  const openEditor = (employee: PayrollEmployee | null) => {
    setEditing(employee);
    setOpen(true);
  };
  const pickGroup = (group: PayrollGroup) => {
    const next = selectedGroup === group ? null : group;
    setSelectedGroup(next);
    setExpanded(null);
    // Phones: the list opens below the tiles, so bring it into view.
    if (next && typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      window.requestAnimationFrame(() =>
        document.getElementById("catalog-group-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      );
    }
  };

  return (
    <Card className="overflow-hidden" data-employee-catalog>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base">Nhân viên · kỳ {data.period.code}</CardTitle>
          <CardDescription className="text-xs leading-5">
            Lương và đơn giá lưu riêng từng kỳ; sửa kỳ này không ảnh hưởng kỳ đã chốt.
          </CardDescription>
        </div>
        {canChange ? (
          <Button size="sm" className="shrink-0 gap-1.5" onClick={() => openEditor(null)}>
            <UserPlus className="h-4 w-4" />
            <span>Thêm</span>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {data.employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">Kỳ này chưa có nhân viên. Thêm nhân viên trước khi lập bảng lương.</p>
        ) : (
          <>
            <section className="rounded-2xl bg-muted/60 p-4 sm:p-5" data-catalog-summary aria-label="Tổng quan nhân sự">
              <p className="text-xs font-medium text-muted-foreground">Quỹ lương tháng hiện nay</p>
              <p className="mt-0.5 break-all text-[28px] font-semibold leading-tight tabular-nums sm:text-4xl" data-catalog-fund>
                {formatAdjustmentValue(summary.fund)}
                <span className="ml-1 text-base font-normal text-muted-foreground">đ</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                <span className="rounded-full bg-foreground px-2.5 py-1 font-medium text-background tabular-nums" data-catalog-headcount>
                  {summary.activeCount} người đang làm
                </span>
                <span className="rounded-full bg-background px-2.5 py-1 tabular-nums">
                  Cố định <b className="font-semibold">{formatAdjustmentValue(summary.fixed)}</b>
                </span>
                {summary.partTimeCount > 0 ? (
                  <span className="rounded-full bg-background px-2.5 py-1 tabular-nums">
                    {summary.estimateAvailable ? (
                      <>
                        Part-time tạm tính <b className="font-semibold">{formatAdjustmentValue(summary.partTimeEstimate)}</b>
                      </>
                    ) : (
                      "Part-time chưa tạm tính được"
                    )}
                  </span>
                ) : null}
                {summary.upcomingCount > 0 ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
                    {summary.upcomingCount} người bắt đầu kỳ sau
                  </span>
                ) : null}
              </div>
              {summary.partTimeCount > 0 ? (
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  Part-time tính theo giờ đã chấm công từ đầu kỳ đến nay, số cuối tháng sẽ cao hơn.
                </p>
              ) : null}
            </section>

            {canManagePhones ? <MissionGiftBar gifts={gifts} employees={data.employees} /> : null}

            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" role="list" data-catalog-groups>
              {summary.groups.map((group) => {
                const meta = GROUP_META[group.group];
                const Icon = meta.icon;
                const isSelected = selectedGroup === group.group;
                const share = summary.fund > 0 ? Math.round((group.fund / summary.fund) * 100) : 0;
                const extras = [
                  group.partTimeCount > 0 ? `${group.partTimeCount} part-time` : null,
                  group.upcomingCount > 0 ? `${group.upcomingCount} kỳ sau` : null,
                ].filter(Boolean);
                return (
                  <button
                    key={group.group}
                    type="button"
                    role="listitem"
                    onClick={() => pickGroup(group.group)}
                    aria-expanded={isSelected}
                    aria-controls="catalog-group-panel"
                    data-catalog-group={group.group}
                    className={cn(
                      "group flex min-h-[132px] flex-col rounded-2xl border bg-card p-3.5 text-left transition-[border-color,box-shadow,transform] duration-150 active:scale-[0.98] motion-reduce:transform-none",
                      isSelected ? "border-foreground shadow-[0_0_0_1px_hsl(var(--foreground))]" : "hover:border-foreground/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("flex h-8 w-8 items-center justify-center rounded-xl", meta.tile)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      {isSelected ? (
                        <ChevronDown className="h-4 w-4 text-foreground" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                      )}
                    </div>
                    <p className="mt-2.5 text-sm font-semibold">{group.group}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.activeCount} người{extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}
                    </p>
                    {group.fund === 0 && group.upcomingCount > 0 ? (
                      <p className="mt-auto pt-2 text-sm font-medium text-amber-700 dark:text-amber-300">Bắt đầu kỳ sau</p>
                    ) : (
                      <p className="mt-auto pt-2 text-base font-semibold tabular-nums">{formatAdjustmentValue(group.fund)}</p>
                    )}
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={cn("h-full rounded-full", meta.bar)} style={{ width: `${share}%` }} />
                    </div>
                  </button>
                );
              })}
            </div>

            {selected ? (
              <section id="catalog-group-panel" className="rounded-2xl border" data-catalog-group-panel={selected.group}>
                <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{selected.group}</p>
                    <p className="text-xs text-muted-foreground">
                      {selected.employees.length} hồ sơ · quỹ {formatAdjustmentValue(selected.fund)} đ
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setSelectedGroup(null)}>
                    Thu gọn
                  </Button>
                </header>
                {selected.employees.length === 0 ? (
                  <p className="px-4 py-5 text-sm text-muted-foreground">Nhóm này chưa có nhân viên.</p>
                ) : (
                  <ul className="divide-y" data-employee-cards>
                    {selected.employees.map((item) => (
                      <EmployeeRow
                        key={item.employee.code}
                        item={item}
                        open={expanded === item.employee.code}
                        onToggle={() => setExpanded((current) => (current === item.employee.code ? null : item.employee.code))}
                        shift={shiftByCode.get(item.employee.code)}
                        canOpenEditor={canOpenEditor}
                        onEdit={() => openEditor(item.employee)}
                        phone={
                          canManagePhones ? (
                            <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-muted-foreground">SĐT xem phiếu lương</p>
                                <PhoneCell
                                  contact={contactByCode.get(item.employee.code)}
                                  onEdit={() => setPhoneFor(item.employee)}
                                  name={item.employee.name}
                                />
                              </div>
                              <MissionGiftButton gifts={gifts} employee={item.employee} />
                            </div>
                          ) : null
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>
            ) : (
              <p className="text-center text-xs text-muted-foreground">Bấm vào một nhóm để xem và sửa nhân viên.</p>
            )}
          </>
        )}
      </CardContent>
      {canOpenEditor ? (
        <EmployeeDialog
          open={open}
          onOpenChange={setOpen}
          employee={editing}
          data={data}
          source={source}
          canManagePhones={canManagePhones}
          contact={editing ? contactByCode.get(editing.code) : undefined}
          shiftStart={editing ? shiftByCode.get(editing.code) : undefined}
          payrollLocked={!canChange}
        />
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

const GROUP_META: Record<PayrollGroup, { icon: LucideIcon; tile: string; bar: string; avatar: string }> = {
  "Văn phòng": {
    icon: Building2,
    tile: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    bar: "bg-sky-500",
    avatar: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  },
  "Bếp bánh": {
    icon: ChefHat,
    tile: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
    bar: "bg-orange-500",
    avatar: "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-200",
  },
  "Kho BN": {
    icon: Warehouse,
    tile: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
    bar: "bg-violet-500",
    avatar: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200",
  },
  "Giao hàng": {
    icon: Truck,
    tile: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    bar: "bg-emerald-500",
    avatar: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200",
  },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[parts.length - 1]?.[0] ?? "?").toUpperCase();
}

function EmployeeRow({
  item,
  open,
  onToggle,
  shift,
  canOpenEditor,
  onEdit,
  phone,
}: {
  item: CatalogEmployeeSummary;
  open: boolean;
  onToggle: () => void;
  shift?: string;
  canOpenEditor: boolean;
  onEdit: () => void;
  phone: ReactNode;
}) {
  const { employee, state } = item;
  const isPartTime = employee.employmentType === "part_time";
  const pay: [string, number | null | undefined][] = [
    ["Lương chính thức", employee.monthlySalary],
    ["Đơn giá giờ", employee.hourlyRate],
    ["Đơn giá TC", employee.overtimeRate],
    ["Lương cứng tính công", employee.deliveryUnitBase],
    ["Phụ cấp", employee.allowance],
  ];
  const shown = pay.filter(([, value]) => value !== null && value !== undefined && value !== 0);
  const detailId = `employee-detail-${employee.code}`;
  const start = employee.startDate ? employee.startDate.split("-").reverse().slice(0, 2).join("/") : null;

  return (
    <li data-employee-card={employee.code}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40",
          state !== "active" && "opacity-70",
        )}
      >
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
            GROUP_META[employee.group].avatar,
          )}
          aria-hidden
        >
          {initials(employee.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium leading-snug">{employee.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {typeLabel(employee.employmentType)}
            {shift ? ` · Ca ${shift}` : ""} · Mã {employee.code}
          </span>
        </span>
        <span className="shrink-0 text-right">
          {state === "left" ? (
            <Badge variant="secondary" className="font-normal">Nghỉ việc</Badge>
          ) : state === "upcoming" ? (
            <Badge variant="outline" className="border-amber-400 font-normal text-amber-800 dark:text-amber-300">
              Từ {start}
            </Badge>
          ) : isPartTime ? (
            <>
              <span className="block text-sm font-semibold tabular-nums">
                {employee.hourlyRate ? `${formatAdjustmentValue(employee.hourlyRate)}/giờ` : "–"}
              </span>
              {item.partTimeSoFar !== null ? (
                <span className="block text-[11px] text-muted-foreground tabular-nums">
                  tạm {formatAdjustmentValue(item.partTimeSoFar)}
                </span>
              ) : null}
            </>
          ) : (
            <span className="block text-sm font-semibold tabular-nums">{item.fixed ? formatAdjustmentValue(item.fixed) : "–"}</span>
          )}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={detailId} className="space-y-3 px-4 pb-4 pt-1" data-employee-detail={employee.code}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border p-3 text-sm sm:grid-cols-3">
            {shown.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{formatAdjustmentValue(value as number)}</dd>
              </div>
            ))}
            {isPartTime && item.partTimeHours !== null ? (
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Giờ đã chấm đến nay</dt>
                <dd className="tabular-nums">{formatAdjustmentValue(item.partTimeHours)}</dd>
              </div>
            ) : null}
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Trạng thái</dt>
              <dd className="text-xs leading-5"><EmployeeStatus employee={employee} /></dd>
            </div>
          </dl>
          {phone}
          {canOpenEditor ? (
            <Button variant="outline" className="h-10 w-full gap-2" onClick={onEdit}>
              <PencilLine className="h-4 w-4" />
              Sửa hồ sơ {employee.name}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
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
  deliveryUnitBase: string;
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
    deliveryUnitBase: text(employee?.deliveryUnitBase),
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
  canManagePhones = false,
  contact,
  shiftStart,
  payrollLocked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: PayrollEmployee | null;
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canManagePhones?: boolean;
  contact?: BepBnEmployeeContact;
  shiftStart?: string;
  /** Locked period: salary fields are read-only; phone, login and shift stay editable. */
  payrollLocked?: boolean;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<EmployeeForm>(() => toForm(employee));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Login phone + on/off are shared across periods (payroll_bn_employee_contacts).
  const [phone, setPhone] = useState(contact ? displayPhone(contact.phone) : "");
  const [loginActive, setLoginActive] = useState(contact?.active ?? true);
  // Manual shift start shared across periods (payroll_bn_employee_shifts).
  const [shift, setShift] = useState(shiftStart ?? "");

  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm(toForm(employee));
      setTouched(false);
      setPhone(contact ? displayPhone(contact.phone) : "");
      setLoginActive(contact?.active ?? true);
      setShift(shiftStart ?? "");
    }
  }

  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const isPartTime = form.employmentType === "part_time";
  const isDelivery = form.employmentType === "delivery";
  const amounts = {
    monthlySalary: parseAmount(form.monthlySalary),
    hourlyRate: parseAmount(form.hourlyRate),
    overtimeRate: parseAmount(form.overtimeRate),
    allowance: parseAmount(form.allowance),
    deliveryUnitBase: parseAmount(form.deliveryUnitBase),
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
    deliveryUnitBase: amounts.deliveryUnitBase === "invalid" ? "Số không hợp lệ." : null,
    endDate: form.endDate && form.startDate && form.endDate < form.startDate ? "Ngày nghỉ phải sau ngày bắt đầu." : null,
    shift: shift.trim() !== "" && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(shift.trim()) ? "Nhập giờ dạng HH:MM, ví dụ 07:00." : null,
  };
  const valid = Object.values(errors).every((error) => error === null);

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    const number = (value: number | null | "invalid") => (value === "invalid" ? null : value);
    setSaving(true);
    try {
      if (!payrollLocked) await source.upsertEmployee(data.id, {
        code: form.code.trim(),
        name: form.name.trim(),
        group: form.group,
        employmentType: form.employmentType,
        monthlySalary: isPartTime ? null : number(amounts.monthlySalary),
        hourlyRate: isPartTime ? number(amounts.hourlyRate) : null,
        overtimeRate: isPartTime || isDelivery ? null : number(amounts.overtimeRate),
        ...(isDelivery ? { deliveryUnitBase: number(amounts.deliveryUnitBase) } : {}),
        allowance: number(amounts.allowance),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
      });
    } catch (error) {
      toast({
        title: "Không lưu được nhân viên",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
      setSaving(false);
      return;
    }

    // Login phone is saved after the employee row; a phone error keeps the dialog open.
    const code = form.code.trim();
    const trimmedPhone = phone.trim();
    const phoneChanged = contact
      ? trimmedPhone.replace(/\D/g, "") !== displayPhone(contact.phone).replace(/\D/g, "") || loginActive !== contact.active
      : trimmedPhone !== "";
    try {
      if (canManagePhones && phoneChanged) {
        if (trimmedPhone === "" && contact) await source.deleteContact(code);
        else if (trimmedPhone !== "") await source.upsertContact({ employeeCode: code, phone: trimmedPhone, active: loginActive });
      }
      const nextShift = shift.trim();
      if (canManagePhones && nextShift !== (shiftStart ?? "")) {
        if (nextShift === "") await source.deleteShift(code);
        else await source.upsertShift({ employeeCode: code, shiftStart: nextShift });
      }
      toast({ title: employee ? "Đã cập nhật nhân viên" : "Đã thêm nhân viên" });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Đã lưu nhân viên nhưng chưa lưu được số điện thoại hoặc giờ vào ca",
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
        {payrollLocked ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Kỳ {data.period.code} đã chốt: chỉ sửa được giờ vào ca và số điện thoại đăng nhập.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset disabled={payrollLocked} className="contents">
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
            <Select value={form.group} onValueChange={(value) => {
              set("group", value as PayrollGroup);
              if (value === "Giao hàng") set("employmentType", "delivery");
              else if (form.employmentType === "delivery") set("employmentType", "official");
            }}>
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
                <SelectItem value="delivery">Giao hàng</SelectItem>
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
                <Label htmlFor="bep-bn-emp-salary">{isDelivery ? "Lương cố định tháng" : "Lương chính thức"}</Label>
                <Input id="bep-bn-emp-salary" inputMode="numeric" value={form.monthlySalary} onChange={(event) => set("monthlySalary", event.target.value)} placeholder="8.000.000" />
                {show(errors.monthlySalary)}
              </div>
              {isDelivery ? (
                <div className="space-y-2">
                  <Label htmlFor="bep-bn-emp-unit-base">Lương cứng tính công</Label>
                  <Input id="bep-bn-emp-unit-base" inputMode="numeric" value={form.deliveryUnitBase} onChange={(event) => set("deliveryUnitBase", event.target.value)} placeholder="Bỏ trống nếu không tính công" />
                  <p className="text-xs text-muted-foreground">Mỗi công = số này ÷ số ngày của tháng.</p>
                  {show(errors.deliveryUnitBase)}
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="bep-bn-emp-ot">Đơn giá tăng ca / giờ</Label>
                  <Input id="bep-bn-emp-ot" inputMode="numeric" value={form.overtimeRate} onChange={(event) => set("overtimeRate", event.target.value)} placeholder="Bỏ trống nếu không tính TC" />
                  {show(errors.overtimeRate)}
                </div>
              )}
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
          </fieldset>
          {canManagePhones ? (
            <div className="space-y-2">
              <Label htmlFor="bep-bn-emp-shift">Giờ vào ca</Label>
              <Input
                id="bep-bn-emp-shift"
                type="time"
                className="min-w-0"
                value={shift}
                onChange={(event) => setShift(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Dùng chung mọi kỳ; để trống thì tính theo mốc của nhiệm vụ.</p>
              {show(errors.shift)}
            </div>
          ) : null}
          {canManagePhones ? (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3 sm:col-span-2">
              <div>
                <p className="text-sm font-medium">Đăng nhập luong.banhmique.vn</p>
                <p className="text-xs text-muted-foreground">
                  Dùng chung mọi kỳ. Nhân viên nhận mã OTP Zalo qua số này để xem phiếu lương và chấm công.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bep-bn-emp-phone">Số điện thoại</Label>
                <Input
                  id="bep-bn-emp-phone"
                  inputMode="tel"
                  autoComplete="off"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="09xx xxx xxx"
                />
                {contact && phone.trim() === "" ? (
                  <p className="text-xs text-destructive">Để trống rồi Lưu sẽ xoá số đăng nhập của nhân viên này.</p>
                ) : null}
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label htmlFor="bep-bn-emp-login" className="font-normal">
                  Cho phép đăng nhập
                  <span className="block text-xs text-muted-foreground">Tắt để chặn ngay, kể cả khi đang đăng nhập.</span>
                </Label>
                <Switch
                  id="bep-bn-emp-login"
                  checked={loginActive}
                  disabled={phone.trim() === ""}
                  onCheckedChange={setLoginActive}
                />
              </div>
            </div>
          ) : null}
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
            {employee ? `${employee.name} · ${employee.code}. ` : ""}Nhân viên dùng số này để nhận mã OTP qua Zalo tại luong.banhmique.vn.
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
