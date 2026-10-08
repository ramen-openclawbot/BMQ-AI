import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { PayrollGroup } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource } from "./types";

const GROUPS: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function defaultForm() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    code: `T${month}.${now.getFullYear()}`,
    name: `Kỳ lương tháng ${month}/${now.getFullYear()} — Bếp BN`,
    dateFrom: `${now.getFullYear()}-${month}-01`,
    dateTo: `${now.getFullYear()}-${month}-${String(lastDay).padStart(2, "0")}`,
    standard: { "Văn phòng": "22", "Bếp bánh": "26", "Kho BN": "26" } as Record<PayrollGroup, string>,
    holidays: "",
  };
}

/** Accepts dd/mm/yyyy or yyyy-mm-dd, separated by commas or new lines. */
function parseHolidays(text: string): { dates: string[]; invalid: string[] } {
  const dates: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean)) {
    const dmy = part.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const iso = dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : part;
    if (ISO_DATE.test(iso)) dates.push(iso);
    else invalid.push(part);
  }
  return { dates: [...new Set(dates)].sort(), invalid };
}

export function PeriodDialog({
  open,
  onOpenChange,
  source,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: BepBnDataSource;
  onCreated: (periodId: string) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(defaultForm);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm(defaultForm());
      setTouched(false);
    }
  }

  const holidays = parseHolidays(form.holidays);
  const standard = Object.fromEntries(GROUPS.map((group) => [group, Number(form.standard[group].replace(",", "."))])) as Record<PayrollGroup, number>;
  const errors = {
    code: form.code.trim() === "" ? "Nhập mã kỳ." : null,
    name: form.name.trim() === "" ? "Nhập tên kỳ." : null,
    range: !ISO_DATE.test(form.dateFrom) || !ISO_DATE.test(form.dateTo) || form.dateTo < form.dateFrom ? "Khoảng ngày không hợp lệ." : null,
    standard: GROUPS.some((group) => !Number.isFinite(standard[group]) || standard[group] <= 0) ? "Ngày công chuẩn phải là số lớn hơn 0." : null,
    holidays:
      holidays.invalid.length > 0
        ? `Ngày không hợp lệ: ${holidays.invalid.join(", ")}.`
        : holidays.dates.some((date) => date < form.dateFrom || date > form.dateTo)
          ? "Ngày lễ phải nằm trong kỳ."
          : null,
  };
  const valid = Object.values(errors).every((error) => error === null);
  const show = (error: string | null) => (touched && error ? <p className="text-xs text-destructive">{error}</p> : null);

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    try {
      const id = await source.createPeriod({
        code: form.code.trim(),
        name: form.name.trim(),
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        standardDaysByGroup: standard,
        holidays: holidays.dates,
      });
      toast({ title: "Đã tạo kỳ lương", description: `${form.code.trim()} — thêm danh mục nhân viên cho kỳ này.` });
      onCreated(id);
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Không tạo được kỳ",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tạo kỳ lương Bếp BN</DialogTitle>
          <DialogDescription>Ngày công chuẩn và ngày lễ có lương là tham số riêng của kỳ này.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bep-bn-period-code">Mã kỳ</Label>
            <Input id="bep-bn-period-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
            {show(errors.code)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-period-name">Tên kỳ</Label>
            <Input id="bep-bn-period-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            {show(errors.name)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-period-from">Từ ngày</Label>
            <Input id="bep-bn-period-from" type="date" className="min-w-0" value={form.dateFrom} onChange={(event) => setForm({ ...form, dateFrom: event.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-period-to">Đến ngày</Label>
            <Input id="bep-bn-period-to" type="date" className="min-w-0" value={form.dateTo} onChange={(event) => setForm({ ...form, dateTo: event.target.value })} />
          </div>
          <div className="sm:col-span-2">{show(errors.range)}</div>
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="text-sm font-medium">Ngày công chuẩn</legend>
            <div className="grid grid-cols-3 gap-2">
              {GROUPS.map((group) => (
                <div key={group} className="min-w-0 space-y-1">
                  <Label htmlFor={`bep-bn-standard-${group}`} className="block truncate text-xs text-muted-foreground">
                    {group}
                  </Label>
                  <Input
                    id={`bep-bn-standard-${group}`}
                    inputMode="decimal"
                    value={form.standard[group]}
                    onChange={(event) => setForm({ ...form, standard: { ...form.standard, [group]: event.target.value } })}
                  />
                </div>
              ))}
            </div>
            {show(errors.standard)}
          </fieldset>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="bep-bn-period-holidays">Ngày lễ có lương</Label>
            <Input
              id="bep-bn-period-holidays"
              value={form.holidays}
              onChange={(event) => setForm({ ...form, holidays: event.target.value })}
              placeholder="Ví dụ: 01/09/2026, 02/09/2026"
            />
            {show(errors.holidays)}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Huỷ
          </Button>
          <Button onClick={() => void submit()} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Tạo kỳ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
