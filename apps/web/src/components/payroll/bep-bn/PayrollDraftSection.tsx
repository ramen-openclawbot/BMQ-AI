import { Fragment, useMemo, useState } from "react";
import { Download, FileText, Loader2, PencilLine } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { computePayroll } from "@/lib/payroll-bn/engine.ts";
import { buildPayrollExportRows, buildPayrollWorkbook, payrollExportFileName } from "@/lib/payroll-bn/export.ts";
import { addRational, rationalToNumber } from "@/lib/payroll-bn/money.ts";
import type { AdjustmentField, PayrollEmployeeLine, PayrollGroup, PayrollLine } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";
import { ADJUSTMENT_LABELS, VALUELESS_ADJUSTMENTS, formatAdjustmentValue, formatMoney, formatQuantity, formatVnd } from "./format";

const GROUP_ORDER: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

interface PayrollDraftSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
}

export function PayrollDraftSection({ data, source, canEdit }: PayrollDraftSectionProps) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetEmployee, setPresetEmployee] = useState<string | null>(null);
  const locked = data.period.status === "locked";
  const canAdjust = canEdit && !locked;

  const result = useMemo(
    () =>
      computePayroll({
        period: data.period,
        employees: data.employees,
        rows: data.rows,
        measures: data.measures,
        adjustments: data.adjustments,
      }),
    [data],
  );

  const notes = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of data.adjustments) {
      const list = map.get(item.employeeCode) ?? [];
      list.push(`${ADJUSTMENT_LABELS[item.field]}: ${item.reason}`);
      map.set(item.employeeCode, list);
    }
    return map;
  }, [data.adjustments]);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    employees: result.employees.filter((line) => line.group === group),
    summary: result.groups.find((line) => line.group === group),
  })).filter((entry) => entry.employees.length > 0);

  const download = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportExcel = () => {
    const bytes = buildPayrollWorkbook(buildPayrollExportRows(data.period, result, notes));
    download(
      new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      payrollExportFileName(data.period),
    );
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      // jsPDF is loaded only when a PDF is requested.
      const { buildPayrollPdf } = await import("@/lib/payroll-bn/export-pdf.ts");
      const blob = await buildPayrollPdf(buildPayrollExportRows(data.period, result, notes));
      download(blob, payrollExportFileName(data.period).replace(/\.xlsx$/, ".pdf"));
    } catch (error) {
      toast({
        title: "Không xuất được PDF",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setPdfBusy(false);
    }
  };

  const openAdjust = (employeeCode: string | null) => {
    setPresetEmployee(employeeCode);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Bảng lương nháp</CardTitle>
            <CardDescription>
              Ngày công và giờ công là các cột riêng. Thực nhận làm tròn đến 1.000 đồng ở bước cuối; dòng nhóm cộng các số đã làm tròn.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 self-start">
            <Button
              variant="outline"
              className="gap-2"
              onClick={exportExcel}
              disabled={result.employees.length === 0}
            >
              <Download className="h-4 w-4" />
              Xuất Excel
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => void exportPdf()}
              disabled={result.employees.length === 0 || pdfBusy}
            >
              {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Xuất PDF
            </Button>
            {canAdjust ? (
              <Button variant="outline" className="gap-2" onClick={() => openAdjust(null)}>
                <PencilLine className="h-4 w-4" />
                Điều chỉnh
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {result.employees.length === 0 ? (
            <p className="text-sm text-muted-foreground">Kỳ này chưa có danh mục nhân viên.</p>
          ) : (
            <div className="max-h-[560px] overflow-auto rounded-md border">
              <table className="w-max min-w-full border-collapse text-sm">
                <thead className="text-xs [&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-card [&_th]:shadow-[inset_0_-1px_0_hsl(var(--border))] [&_th:first-child]:z-30">
                  <tr>
                    <th className="left-0 min-w-[132px] px-3 py-2 text-left font-medium sm:min-w-[180px]">Nhân viên</th>
                    <HeaderCell>NC chuẩn</HeaderCell>
                    <HeaderCell>NC thực tế</HeaderCell>
                    <HeaderCell>Ngày lễ</HeaderCell>
                    <HeaderCell>NC tính lương</HeaderCell>
                    <HeaderCell>Giờ part-time</HeaderCell>
                    <HeaderCell>Giờ TC</HeaderCell>
                    <HeaderCell>Lương ngày công</HeaderCell>
                    <HeaderCell>Lương TC</HeaderCell>
                    <HeaderCell>Phụ cấp</HeaderCell>
                    <HeaderCell>Tổng thu nhập</HeaderCell>
                    <HeaderCell>Thực nhận</HeaderCell>
                    <th className="min-w-[220px] px-3 py-2 text-left font-medium">Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((entry) => (
                    <Fragment key={entry.group}>
                      {entry.employees.map((line) => (
                        <LineRow
                          key={line.employeeCode}
                          line={line}
                          label={line.employeeName}
                          sublabel={`${line.employeeCode} · ${line.employmentType === "part_time" ? "Part-time" : "Chính thức"}`}
                          note={notes.get(line.employeeCode)?.join("; ") ?? (line.flags.includes("terminated") ? "Nghỉ việc trong kỳ" : "")}
                          onAdjust={canAdjust && !line.flags.includes("terminated") ? () => openAdjust(line.employeeCode) : undefined}
                        />
                      ))}
                      {entry.summary ? <LineRow line={entry.summary} label={`Nhóm ${entry.group}`} variant="group" /> : null}
                    </Fragment>
                  ))}
                  <LineRow line={result.total} label="Tổng cộng" variant="total" />
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <AdjustmentLog data={data} />

      {canAdjust ? (
        <AdjustmentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          data={data}
          source={source}
          lines={result.employees}
          presetEmployee={presetEmployee}
        />
      ) : null}
    </div>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return <th className="min-w-[96px] px-3 py-2 text-right font-medium">{children}</th>;
}

function NumberCell({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <td className={cn("px-3 py-2 text-right tabular-nums", strong && "font-semibold")}>{children}</td>;
}

function LineRow({
  line,
  label,
  sublabel,
  note,
  variant = "employee",
  onAdjust,
}: {
  line: PayrollLine;
  label: string;
  sublabel?: string;
  note?: string;
  variant?: "employee" | "group" | "total";
  onAdjust?: () => void;
}) {
  const emphasis = variant !== "employee";
  const stickyBg = variant === "total" ? "bg-muted" : variant === "group" ? "bg-secondary" : "bg-card";
  return (
    <tr className={cn("border-t", variant === "group" && "bg-secondary font-medium", variant === "total" && "bg-muted font-semibold")}>
      <td className={cn("sticky left-0 z-10 max-w-[150px] px-3 py-2 sm:max-w-none", stickyBg)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate">{label}</div>
            {sublabel ? <div className="truncate text-xs text-muted-foreground">{sublabel}</div> : null}
          </div>
          {onAdjust ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={onAdjust}
              aria-label={`Điều chỉnh ${label}`}
            >
              <PencilLine className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </td>
      <NumberCell>{line.kind === "employee" && line.employmentType !== "part_time" ? formatQuantity(line.standardDays) : ""}</NumberCell>
      <NumberCell>{formatQuantity(line.actualWorkDays)}</NumberCell>
      <NumberCell>{formatQuantity(line.holidayPayDays)}</NumberCell>
      <NumberCell strong={emphasis}>{formatQuantity(line.workDays)}</NumberCell>
      <NumberCell>{formatQuantity(line.partTimeHours)}</NumberCell>
      <NumberCell>{formatQuantity(line.overtimeHours)}</NumberCell>
      <NumberCell>{formatMoney(addRational(line.dayPay, line.partTimePay))}</NumberCell>
      <NumberCell>{formatMoney(line.overtimePay)}</NumberCell>
      <NumberCell>{formatMoney(line.allowance)}</NumberCell>
      <NumberCell>{formatMoney(line.grossPay)}</NumberCell>
      <NumberCell strong>{formatVnd(line.netPayRounded)}</NumberCell>
      <td className="px-3 py-2 text-xs text-muted-foreground">{note}</td>
    </tr>
  );
}

function AdjustmentLog({ data }: { data: BepBnPeriodData }) {
  const names = new Map(data.employees.map((employee) => [employee.code, employee.name]));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Nhật ký điều chỉnh</CardTitle>
        <CardDescription>Mỗi điều chỉnh ghi người sửa, thời điểm, giá trị và lý do.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có điều chỉnh nào.</p>
        ) : (
          <ul className="divide-y text-sm">
            {data.adjustments.map((item, index) => (
              <li key={`${item.employeeCode}-${item.field}-${index}`} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
                <span className="shrink-0 text-xs text-muted-foreground sm:w-36">{item.at.slice(0, 16).replace("T", " ")}</span>
                <span className="min-w-0">
                  <span className="font-medium">{names.get(item.employeeCode) ?? item.employeeCode}</span>
                  {" · "}
                  {ADJUSTMENT_LABELS[item.field]}
                  {item.value !== null && item.value !== undefined ? (
                    <>
                      {": "}
                      {item.oldValue !== null && item.oldValue !== undefined ? `${formatAdjustmentValue(item.oldValue)} → ` : ""}
                      {formatAdjustmentValue(item.value)}
                    </>
                  ) : null}
                  <span className="block text-muted-foreground">
                    {item.reason} — {item.actor}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const CURRENT_VALUE_FIELD: Partial<Record<AdjustmentField, "actualWorkDays" | "workDays" | "partTimeHours" | "overtimeHours">> = {
  work_days: "actualWorkDays",
  paid_work_days: "workDays",
  part_time_hours: "partTimeHours",
  overtime_hours: "overtimeHours",
};

const ADJUSTABLE_FIELDS: AdjustmentField[] = [
  "work_days",
  "paid_work_days",
  "part_time_hours",
  "overtime_hours",
  "exclude_overtime",
  "exclude_holiday",
];

function AdjustmentDialog({
  open,
  onOpenChange,
  data,
  source,
  lines,
  presetEmployee,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: BepBnPeriodData;
  source: BepBnDataSource;
  lines: PayrollEmployeeLine[];
  presetEmployee: string | null;
}) {
  const { toast } = useToast();
  const [employeeCode, setEmployeeCode] = useState<string>("");
  const [field, setField] = useState<AdjustmentField>("work_days");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  // The dialog is opened by the parent, so reset the draft whenever it opens.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setEmployeeCode(presetEmployee ?? "");
      setField("work_days");
      setValue("");
      setReason("");
      setTouched(false);
    }
  }

  const needsValue = !VALUELESS_ADJUSTMENTS.has(field);
  const currentLine = lines.find((line) => line.employeeCode === employeeCode);
  const currentField = CURRENT_VALUE_FIELD[field];
  const currentValue = currentLine && currentField ? rationalToNumber(currentLine[currentField]) : null;
  const numericValue = Number(value.replace(",", "."));
  const valueValid = !needsValue || (value.trim() !== "" && Number.isFinite(numericValue) && numericValue >= 0);
  const reasonValid = reason.trim().length > 0;
  const valid = employeeCode !== "" && valueValid && reasonValid;

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    try {
      await source.addAdjustment(data.id, {
        employeeCode,
        field,
        value: needsValue ? numericValue : null,
        oldValue: currentValue,
        reason: reason.trim(),
      });
      toast({ title: "Đã lưu điều chỉnh" });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Không lưu được điều chỉnh",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Điều chỉnh bảng lương</DialogTitle>
          <DialogDescription>Bắt buộc ghi lý do. Lý do hiển thị ở cột Ghi chú và lưu vào nhật ký.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bep-bn-adjust-employee">Nhân viên</Label>
            <Select value={employeeCode} onValueChange={setEmployeeCode}>
              <SelectTrigger id="bep-bn-adjust-employee">
                <SelectValue placeholder="Chọn nhân viên" />
              </SelectTrigger>
              <SelectContent>
                {data.employees
                  .filter((employee) => !employee.terminated)
                  .map((employee) => (
                    <SelectItem key={employee.code} value={employee.code}>
                      {employee.name} ({employee.code})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {touched && employeeCode === "" ? <p className="text-xs text-destructive">Chọn nhân viên.</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-adjust-field">Nội dung</Label>
            <Select value={field} onValueChange={(next) => setField(next as AdjustmentField)}>
              <SelectTrigger id="bep-bn-adjust-field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUSTABLE_FIELDS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {ADJUSTMENT_LABELS[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsValue ? (
            <div className="space-y-2">
              <Label htmlFor="bep-bn-adjust-value">
                Giá trị mới
                {currentValue !== null ? (
                  <span className="ml-1 font-normal text-muted-foreground">(hiện tại {formatAdjustmentValue(currentValue)})</span>
                ) : null}
              </Label>
              <Input
                id="bep-bn-adjust-value"
                inputMode="decimal"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Ví dụ 24,5"
              />
              {touched && !valueValid ? <p className="text-xs text-destructive">Nhập số không âm.</p> : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="bep-bn-adjust-reason">Lý do</Label>
            <Textarea
              id="bep-bn-adjust-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Ví dụ: Chốt lương theo xác nhận của quản lý bếp"
            />
            {touched && !reasonValid ? <p className="text-xs text-destructive">Bắt buộc ghi lý do.</p> : null}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Huỷ
          </Button>
          <Button onClick={() => void submit()} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Lưu điều chỉnh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
