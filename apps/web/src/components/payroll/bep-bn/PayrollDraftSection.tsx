import { useMemo, useState } from "react";
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
import { buildPayrollNotes } from "@/lib/payroll-bn/notes.ts";
import { comparePayroll } from "@/lib/payroll-bn/compare.ts";
import type { IssueReview } from "@/lib/payroll-bn/issue-review.ts";
import { buildPayrollExportRows, buildPayrollWorkbook, formatChange, payrollExportFileName, withChangeColumn } from "@/lib/payroll-bn/export.ts";
import { rationalToNumber } from "@/lib/payroll-bn/money.ts";
import type { AdjustmentField, PayrollEmployeeLine } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";
import { ADJUSTMENT_LABELS, VALUELESS_ADJUSTMENTS, formatAdjustmentValue, formatVnd } from "./format";

interface PayrollDraftSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
  /** Reviewer decisions, so excluded missing check-out days reach the notes. */
  issueReviews: IssueReview[];
}

export function PayrollDraftSection({ data, source, canEdit, issueReviews }: PayrollDraftSectionProps) {
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

  const notes = useMemo(
    () =>
      buildPayrollNotes(
        result.employees,
        data.adjustments,
        ADJUSTMENT_LABELS,
        issueReviews,
      ),
    [result.employees, data.adjustments, issueReviews],
  );

  const comparison = useMemo(
    () => comparePayroll(result, source.previousPayroll),
    [result, source.previousPayroll],
  );

  const exportRows = () =>
    withChangeColumn(buildPayrollExportRows(data.period, result, notes), comparison, source.previousPeriodCode);

  const download = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportExcel = () => {
    const bytes = buildPayrollWorkbook(exportRows());
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
      const blob = await buildPayrollPdf(exportRows());
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
              Xuất PDF hoặc Excel để xem bảng lương chi tiết, có cột ± % so kỳ trước. Thực nhận làm tròn đến 1.000 đồng ở bước cuối.
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
            <p className="text-sm text-muted-foreground">
              {result.employees.length} nhân viên. Tổng thực nhận{" "}
              <span className="font-semibold text-foreground tabular-nums">{formatVnd(result.total.netPayRounded)}</span>
              {comparison.total !== null ? (
                <>
                  {" · "}
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      comparison.total > 0 ? "text-emerald-600" : comparison.total < 0 ? "text-red-600" : "",
                    )}
                  >
                    {formatChange(comparison.total)}
                  </span>{" "}
                  so {source.previousPeriodCode}
                </>
              ) : null}
              . Xem chi tiết từng người trong file PDF hoặc Excel.
            </p>
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
