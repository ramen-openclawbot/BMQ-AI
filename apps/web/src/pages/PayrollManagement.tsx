import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Calculator,
  CalendarRange,
  CircleDollarSign,
  Lock,
  LockOpen,
  Loader2,
  PlusCircle,
  ShieldAlert,
  UserCog,
  BookOpenCheck,
} from "lucide-react";
import { PayrollExportPanel } from "@/components/payroll/PayrollExportPanel";

type WageType = "monthly" | "hourly" | "per_shift";
type RunStatus = "draft" | "calculated" | "approved" | "locked";

interface WageProfile {
  id: string;
  employee_code: string;
  employee_name: string | null;
  department: string | null;
  wage_type: WageType;
  base_monthly_salary: number;
  hourly_rate: number;
  per_shift_rate: number;
  standard_days_per_month: number;
  standard_hours_per_day: number;
  partial_shift_floor: number;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  notes: string | null;
}

interface PayrollRun {
  id: string;
  period_code: string;
  period_name: string;
  period_from: string;
  period_to: string;
  status: RunStatus;
  total_gross: number;
  total_deductions: number;
  total_net: number;
  notes: string | null;
}

interface PayrollLine {
  id: string;
  payroll_run_id: string;
  employee_code: string;
  employee_name: string | null;
  department: string | null;
  wage_type_snapshot: WageType;
  total_days_present: number;
  total_hours_worked: number;
  total_minutes_late: number;
  total_shifts_full: number;
  total_shifts_partial: number;
  base_amount: number;
  late_deduction: number;
  adjustment_total: number;
  gross_amount: number;
  net_amount: number;
  notes: string | null;
}

const emptyProfile: Partial<WageProfile> = {
  employee_code: "",
  employee_name: "",
  department: "",
  wage_type: "monthly",
  base_monthly_salary: 0,
  hourly_rate: 0,
  per_shift_rate: 0,
  standard_days_per_month: 26,
  standard_hours_per_day: 8,
  partial_shift_floor: 0.5,
  effective_from: format(new Date(), "yyyy-MM-dd"),
  effective_to: null,
  is_active: true,
  notes: "",
};

function formatCurrency(value: number, locale: string) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export default function PayrollManagement() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isVi = language === "vi";
  const canEdit = canEditModule("payroll");
  const currencyLocale = isVi ? "vi-VN" : "en-US";

  const [newRunCode, setNewRunCode] = useState("");
  const [newRunName, setNewRunName] = useState("");
  const [newRunFrom, setNewRunFrom] = useState(format(new Date(), "yyyy-MM-01"));
  const [newRunTo, setNewRunTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<WageProfile>>(emptyProfile);

  const copy = useMemo(
    () => ({
      title: isVi ? "Bảng lương" : "Payroll",
      description: isVi
        ? "Tính lương theo chấm công: lương tháng / giờ / ca. Phase 2."
        : "Compute payroll from attendance: monthly / hourly / per-shift. Phase 2.",
      tabRuns: isVi ? "Kỳ lương" : "Payroll runs",
      tabProfiles: isVi ? "Hợp đồng lương" : "Wage profiles",
      tabExport: isVi ? "Xuất kế toán" : "Accounting export",
      createRun: isVi ? "Tạo kỳ lương" : "Create run",
      runCode: isVi ? "Mã kỳ" : "Period code",
      runName: isVi ? "Tên kỳ" : "Period name",
      from: isVi ? "Từ ngày" : "From",
      to: isVi ? "Đến ngày" : "To",
      recalculate: isVi ? "Tính lại" : "Recalculate",
      approve: isVi ? "Duyệt" : "Approve",
      lock: isVi ? "Khóa" : "Lock",
      unlock: isVi ? "Mở lại" : "Reopen",
      runsEmpty: isVi ? "Chưa có kỳ lương nào" : "No payroll runs yet",
      linesEmpty: isVi ? "Chưa có dòng lương — bấm Tính lại" : "No payroll lines — click Recalculate",
      selectRun: isVi ? "Chọn một kỳ để xem chi tiết" : "Select a run to view details",
      addProfile: isVi ? "Thêm hợp đồng" : "Add profile",
      employeeCode: isVi ? "Mã NV" : "Employee code",
      employeeName: isVi ? "Tên NV" : "Employee name",
      department: isVi ? "Bộ phận" : "Department",
      wageType: isVi ? "Hình thức" : "Wage type",
      baseSalary: isVi ? "Lương tháng" : "Monthly base",
      hourlyRate: isVi ? "Giá giờ" : "Hourly rate",
      perShift: isVi ? "Giá ca" : "Per-shift",
      stdDays: isVi ? "Ngày chuẩn/tháng" : "Std days/month",
      stdHours: isVi ? "Giờ chuẩn/ngày" : "Std hours/day",
      partialFloor: isVi ? "Hệ số ca thiếu" : "Partial shift floor",
      effectiveFrom: isVi ? "Hiệu lực từ" : "Effective from",
      effectiveTo: isVi ? "Hiệu lực đến" : "Effective to",
      saveProfile: isVi ? "Lưu hợp đồng" : "Save profile",
      cancel: isVi ? "Hủy" : "Cancel",
      status: isVi ? "Trạng thái" : "Status",
      days: isVi ? "Ngày công" : "Days",
      hours: isVi ? "Giờ" : "Hours",
      lateMin: isVi ? "Trễ (phút)" : "Late (min)",
      base: isVi ? "Cơ bản" : "Base",
      deduction: isVi ? "Khấu trừ" : "Deduction",
      adj: isVi ? "Điều chỉnh" : "Adjustment",
      net: isVi ? "Thực nhận" : "Net",
      readOnly: isVi ? "Chỉ đọc — anh không có quyền edit payroll" : "Read-only — no payroll edit permission",
      totals: isVi ? "Tổng kỳ" : "Period totals",
      totalsFmt: isVi ? "Gross / Trừ / Net" : "Gross / Deductions / Net",
      locked: isVi ? "Đã khóa" : "Locked",
      approved: isVi ? "Đã duyệt" : "Approved",
      calculated: isVi ? "Đã tính" : "Calculated",
      draft: isVi ? "Nháp" : "Draft",
    }),
    [isVi],
  );

  const { data: runs = [], isLoading: runsLoading } = useQuery({
    queryKey: ["payroll-runs"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_runs")
        .select("id, period_code, period_name, period_from, period_to, status, total_gross, total_deductions, total_net, notes")
        .order("period_from", { ascending: false });
      if (error) throw error;
      return (data || []) as PayrollRun[];
    },
  });

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) || null, [runs, selectedRunId]);

  const { data: lines = [], isLoading: linesLoading } = useQuery({
    queryKey: ["payroll-lines", selectedRunId],
    enabled: !!selectedRunId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_lines")
        .select("id, payroll_run_id, employee_code, employee_name, department, wage_type_snapshot, total_days_present, total_hours_worked, total_minutes_late, total_shifts_full, total_shifts_partial, base_amount, late_deduction, adjustment_total, gross_amount, net_amount, notes")
        .eq("payroll_run_id", selectedRunId!)
        .order("employee_code", { ascending: true });
      if (error) throw error;
      return (data || []) as PayrollLine[];
    },
  });

  const { data: profiles = [], isLoading: profilesLoading } = useQuery({
    queryKey: ["employee-wage-profiles"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("employee_wage_profiles")
        .select("id, employee_code, employee_name, department, wage_type, base_monthly_salary, hourly_rate, per_shift_rate, standard_days_per_month, standard_hours_per_day, partial_shift_floor, effective_from, effective_to, is_active, notes")
        .order("employee_code", { ascending: true });
      if (error) throw error;
      return (data || []) as WageProfile[];
    },
  });

  const createRunMutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error(copy.readOnly);
      if (!newRunCode.trim() || !newRunFrom || !newRunTo) {
        throw new Error(isVi ? "Thiếu mã / ngày" : "Missing code / dates");
      }
      if (newRunFrom > newRunTo) {
        throw new Error(isVi ? "Ngày bắt đầu phải trước ngày kết thúc" : "Start date must be before end date");
      }
      const { error } = await (supabase as any)
        .from("payroll_runs")
        .insert({
          period_code: newRunCode.trim(),
          period_name: newRunName.trim() || `Payroll ${newRunFrom} → ${newRunTo}`,
          period_from: newRunFrom,
          period_to: newRunTo,
          status: "draft",
        });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewRunCode("");
      setNewRunName("");
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      toast({ title: isVi ? "Đã tạo kỳ lương" : "Payroll run created" });
    },
    onError: (err: any) => {
      toast({ title: isVi ? "Không thể tạo" : "Unable to create", description: err?.message, variant: "destructive" });
    },
  });

  const recalculateMutation = useMutation({
    mutationFn: async (runId: string) => {
      if (!canEdit) throw new Error(copy.readOnly);
      const { data, error } = await (supabase as any).rpc("payroll_calculate_run", { _run_id: runId });
      if (error) throw error;
      return (data?.[0] || { processed_employees: 0, lines_written: 0 }) as {
        processed_employees: number;
        lines_written: number;
      };
    },
    onSuccess: (r, runId) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-lines", runId] });
      toast({
        title: isVi ? "Đã tính lại" : "Run recalculated",
        description: isVi
          ? `Xử lý ${r.processed_employees} NV, ghi ${r.lines_written} dòng.`
          : `Processed ${r.processed_employees} employees, wrote ${r.lines_written} lines.`,
      });
    },
    onError: (err: any) => {
      toast({ title: isVi ? "Tính lại thất bại" : "Recalculate failed", description: err?.message, variant: "destructive" });
    },
  });

  const updateRunStatusMutation = useMutation({
    mutationFn: async ({ runId, status }: { runId: string; status: RunStatus }) => {
      if (!canEdit) throw new Error(copy.readOnly);
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData?.user?.id || null;
      const nowIso = new Date().toISOString();
      const patch: Record<string, unknown> = { status };
      if (status === "approved") {
        patch.approved_at = nowIso;
        patch.approved_by = uid;
      } else if (status === "locked") {
        patch.locked_at = nowIso;
        patch.locked_by = uid;
      } else if (status === "draft" || status === "calculated") {
        patch.approved_at = null;
        patch.approved_by = null;
        patch.locked_at = null;
        patch.locked_by = null;
      }
      const { error } = await (supabase as any).from("payroll_runs").update(patch).eq("id", runId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payroll-runs"] });
      toast({ title: isVi ? "Đã cập nhật trạng thái" : "Status updated" });
    },
    onError: (err: any) => {
      toast({ title: isVi ? "Cập nhật thất bại" : "Update failed", description: err?.message, variant: "destructive" });
    },
  });

  const saveProfileMutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error(copy.readOnly);
      if (!profileForm.employee_code?.trim()) throw new Error(isVi ? "Thiếu mã NV" : "Missing employee code");
      if (!profileForm.effective_from) throw new Error(isVi ? "Thiếu hiệu lực từ" : "Missing effective_from");

      const payload = {
        employee_code: profileForm.employee_code!.trim(),
        employee_name: profileForm.employee_name?.trim() || null,
        department: profileForm.department?.trim() || null,
        wage_type: profileForm.wage_type || "monthly",
        base_monthly_salary: Number(profileForm.base_monthly_salary) || 0,
        hourly_rate: Number(profileForm.hourly_rate) || 0,
        per_shift_rate: Number(profileForm.per_shift_rate) || 0,
        standard_days_per_month: Number(profileForm.standard_days_per_month) || 26,
        standard_hours_per_day: Number(profileForm.standard_hours_per_day) || 8,
        partial_shift_floor: Number(profileForm.partial_shift_floor) || 0.5,
        effective_from: profileForm.effective_from,
        effective_to: profileForm.effective_to || null,
        is_active: profileForm.is_active ?? true,
        notes: profileForm.notes?.trim() || null,
      };

      if (profileForm.id) {
        const { error } = await (supabase as any)
          .from("employee_wage_profiles")
          .update(payload)
          .eq("id", profileForm.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("employee_wage_profiles").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setProfileDialogOpen(false);
      setProfileForm(emptyProfile);
      queryClient.invalidateQueries({ queryKey: ["employee-wage-profiles"] });
      toast({ title: isVi ? "Đã lưu hợp đồng" : "Profile saved" });
    },
    onError: (err: any) => {
      toast({ title: isVi ? "Lưu thất bại" : "Save failed", description: err?.message, variant: "destructive" });
    },
  });

  const openProfileDialog = (existing?: WageProfile) => {
    setProfileForm(existing ? { ...existing } : { ...emptyProfile });
    setProfileDialogOpen(true);
  };

  const statusBadge = (status: RunStatus) => {
    if (status === "locked") return <Badge variant="destructive">{copy.locked}</Badge>;
    if (status === "approved") return <Badge>{copy.approved}</Badge>;
    if (status === "calculated") return <Badge variant="secondary">{copy.calculated}</Badge>;
    return <Badge variant="outline">{copy.draft}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{copy.title}</h1>
        <p className="text-muted-foreground">{copy.description}</p>
      </div>

      {!canEdit ? (
        <Card className="border-amber-500/30">
          <CardContent className="py-3 text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            {copy.readOnly}
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="runs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="runs" className="gap-2">
            <CalendarRange className="h-4 w-4" />
            {copy.tabRuns}
          </TabsTrigger>
          <TabsTrigger value="profiles" className="gap-2">
            <UserCog className="h-4 w-4" />
            {copy.tabProfiles}
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-2">
            <BookOpenCheck className="h-4 w-4" />
            {copy.tabExport}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PlusCircle className="h-5 w-5" />
                {copy.createRun}
              </CardTitle>
              <CardDescription>
                {isVi
                  ? "Tạo kỳ, sau đó bấm Tính lại để engine đọc attendance_records"
                  : "Create a run then click Recalculate to pull from attendance_records"}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-5">
              <Input placeholder={copy.runCode} value={newRunCode} onChange={(e) => setNewRunCode(e.target.value)} disabled={!canEdit} />
              <Input placeholder={copy.runName} value={newRunName} onChange={(e) => setNewRunName(e.target.value)} disabled={!canEdit} />
              <Input type="date" value={newRunFrom} onChange={(e) => setNewRunFrom(e.target.value)} disabled={!canEdit} />
              <Input type="date" value={newRunTo} onChange={(e) => setNewRunTo(e.target.value)} disabled={!canEdit} />
              <Button onClick={() => createRunMutation.mutate()} disabled={!canEdit || createRunMutation.isPending}>
                {createRunMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                {copy.createRun}
              </Button>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarRange className="h-4 w-4" />
                  {copy.tabRuns}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {runsLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : runs.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{copy.runsEmpty}</div>
                ) : (
                  runs.map((run) => (
                    <button
                      type="button"
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full text-left rounded border p-3 hover:border-primary transition ${
                        selectedRunId === run.id ? "border-primary" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="font-medium text-sm">{run.period_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {run.period_from} → {run.period_to}
                          </div>
                          <div className="text-xs text-muted-foreground">{run.period_code}</div>
                        </div>
                        {statusBadge(run.status)}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {copy.totals}: {formatCurrency(run.total_gross, currencyLocale)} /{" "}
                        {formatCurrency(run.total_deductions, currencyLocale)} /{" "}
                        <span className="font-semibold text-foreground">
                          {formatCurrency(run.total_net, currencyLocale)}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <CircleDollarSign className="h-4 w-4" />
                    {selectedRun ? selectedRun.period_name : copy.selectRun}
                  </CardTitle>
                  {selectedRun ? (
                    <CardDescription>
                      {selectedRun.period_from} → {selectedRun.period_to} · {copy.totalsFmt}:{" "}
                      {formatCurrency(selectedRun.total_gross, currencyLocale)} /{" "}
                      {formatCurrency(selectedRun.total_deductions, currencyLocale)} /{" "}
                      <span className="font-semibold text-foreground">
                        {formatCurrency(selectedRun.total_net, currencyLocale)}
                      </span>
                    </CardDescription>
                  ) : null}
                </div>
                {selectedRun && canEdit ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => recalculateMutation.mutate(selectedRun.id)}
                      disabled={recalculateMutation.isPending || selectedRun.status === "locked" || selectedRun.status === "approved"}
                    >
                      {recalculateMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Calculator className="h-4 w-4 mr-1" />
                      )}
                      {copy.recalculate}
                    </Button>
                    {selectedRun.status === "calculated" ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          updateRunStatusMutation.mutate({ runId: selectedRun.id, status: "approved" })
                        }
                        disabled={updateRunStatusMutation.isPending}
                      >
                        {copy.approve}
                      </Button>
                    ) : null}
                    {selectedRun.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() =>
                          updateRunStatusMutation.mutate({ runId: selectedRun.id, status: "locked" })
                        }
                        disabled={updateRunStatusMutation.isPending}
                      >
                        <Lock className="h-4 w-4 mr-1" />
                        {copy.lock}
                      </Button>
                    ) : null}
                    {selectedRun.status === "locked" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          updateRunStatusMutation.mutate({ runId: selectedRun.id, status: "calculated" })
                        }
                        disabled={updateRunStatusMutation.isPending}
                      >
                        <LockOpen className="h-4 w-4 mr-1" />
                        {copy.unlock}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </CardHeader>
              <CardContent>
                {!selectedRun ? (
                  <div className="text-sm text-muted-foreground">{copy.selectRun}</div>
                ) : linesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : lines.length === 0 ? (
                  <div className="text-sm text-muted-foreground">{copy.linesEmpty}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{copy.employeeCode}</TableHead>
                          <TableHead>{copy.employeeName}</TableHead>
                          <TableHead>{copy.wageType}</TableHead>
                          <TableHead className="text-right">{copy.days}</TableHead>
                          <TableHead className="text-right">{copy.hours}</TableHead>
                          <TableHead className="text-right">{copy.lateMin}</TableHead>
                          <TableHead className="text-right">{copy.base}</TableHead>
                          <TableHead className="text-right">{copy.deduction}</TableHead>
                          <TableHead className="text-right">{copy.adj}</TableHead>
                          <TableHead className="text-right">{copy.net}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lines.map((line) => (
                          <TableRow key={line.id}>
                            <TableCell className="font-medium">{line.employee_code}</TableCell>
                            <TableCell>{line.employee_name || "-"}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{line.wage_type_snapshot}</Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              {line.total_days_present}
                              {line.total_shifts_partial > 0 ? (
                                <span className="text-muted-foreground text-xs"> (+{line.total_shifts_partial}p)</span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right">{Number(line.total_hours_worked).toFixed(1)}</TableCell>
                            <TableCell className="text-right">{line.total_minutes_late}</TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(line.base_amount, currencyLocale)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(line.late_deduction, currencyLocale)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(line.adjustment_total, currencyLocale)}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {formatCurrency(line.net_amount, currencyLocale)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="profiles" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <UserCog className="h-4 w-4" />
                  {copy.tabProfiles}
                </CardTitle>
                <CardDescription>
                  {isVi
                    ? "Mỗi NV có 1+ hợp đồng theo giai đoạn; engine chọn bản ghi có effective_from/to bao phủ kỳ."
                    : "Each employee has one or more contracts; the engine picks the one whose effective range covers the run."}
                </CardDescription>
              </div>
              <Button onClick={() => openProfileDialog()} disabled={!canEdit}>
                <PlusCircle className="h-4 w-4 mr-1" />
                {copy.addProfile}
              </Button>
            </CardHeader>
            <CardContent>
              {profilesLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : profiles.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  {isVi ? "Chưa có hợp đồng lương nào." : "No wage profiles yet."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.employeeCode}</TableHead>
                        <TableHead>{copy.employeeName}</TableHead>
                        <TableHead>{copy.department}</TableHead>
                        <TableHead>{copy.wageType}</TableHead>
                        <TableHead className="text-right">{copy.baseSalary}</TableHead>
                        <TableHead className="text-right">{copy.hourlyRate}</TableHead>
                        <TableHead className="text-right">{copy.perShift}</TableHead>
                        <TableHead>{copy.effectiveFrom}</TableHead>
                        <TableHead>{copy.effectiveTo}</TableHead>
                        <TableHead>{copy.status}</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profiles.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.employee_code}</TableCell>
                          <TableCell>{p.employee_name || "-"}</TableCell>
                          <TableCell>{p.department || "-"}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{p.wage_type}</Badge>
                          </TableCell>
                          <TableCell className="text-right">{formatCurrency(p.base_monthly_salary, currencyLocale)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(p.hourly_rate, currencyLocale)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(p.per_shift_rate, currencyLocale)}</TableCell>
                          <TableCell>{p.effective_from}</TableCell>
                          <TableCell>{p.effective_to || "-"}</TableCell>
                          <TableCell>
                            {p.is_active ? (
                              <Badge>{isVi ? "Hoạt động" : "Active"}</Badge>
                            ) : (
                              <Badge variant="secondary">{isVi ? "Tắt" : "Inactive"}</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button size="sm" variant="outline" onClick={() => openProfileDialog(p)} disabled={!canEdit}>
                              {isVi ? "Sửa" : "Edit"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="export" className="space-y-4">
          <PayrollExportPanel />
        </TabsContent>
      </Tabs>

      <Dialog open={profileDialogOpen} onOpenChange={setProfileDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{profileForm.id ? (isVi ? "Sửa hợp đồng" : "Edit profile") : copy.addProfile}</DialogTitle>
            <DialogDescription>
              {isVi
                ? "Thông tin này được engine dùng khi tính lương. Dùng effective_from/to để tách giai đoạn."
                : "These fields are consumed by the payroll engine. Use effective_from/to for versioning."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">{copy.employeeCode}</label>
              <Input
                value={profileForm.employee_code || ""}
                onChange={(e) => setProfileForm((f) => ({ ...f, employee_code: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.employeeName}</label>
              <Input
                value={profileForm.employee_name || ""}
                onChange={(e) => setProfileForm((f) => ({ ...f, employee_name: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.department}</label>
              <Input
                value={profileForm.department || ""}
                onChange={(e) => setProfileForm((f) => ({ ...f, department: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.wageType}</label>
              <Select
                value={profileForm.wage_type || "monthly"}
                onValueChange={(v) => setProfileForm((f) => ({ ...f, wage_type: v as WageType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">monthly</SelectItem>
                  <SelectItem value="hourly">hourly</SelectItem>
                  <SelectItem value="per_shift">per_shift</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.baseSalary}</label>
              <Input
                type="number"
                value={String(profileForm.base_monthly_salary ?? 0)}
                onChange={(e) => setProfileForm((f) => ({ ...f, base_monthly_salary: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.hourlyRate}</label>
              <Input
                type="number"
                value={String(profileForm.hourly_rate ?? 0)}
                onChange={(e) => setProfileForm((f) => ({ ...f, hourly_rate: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.perShift}</label>
              <Input
                type="number"
                value={String(profileForm.per_shift_rate ?? 0)}
                onChange={(e) => setProfileForm((f) => ({ ...f, per_shift_rate: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.stdDays}</label>
              <Input
                type="number"
                value={String(profileForm.standard_days_per_month ?? 26)}
                onChange={(e) => setProfileForm((f) => ({ ...f, standard_days_per_month: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.stdHours}</label>
              <Input
                type="number"
                step="0.5"
                value={String(profileForm.standard_hours_per_day ?? 8)}
                onChange={(e) => setProfileForm((f) => ({ ...f, standard_hours_per_day: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.partialFloor}</label>
              <Input
                type="number"
                step="0.1"
                value={String(profileForm.partial_shift_floor ?? 0.5)}
                onChange={(e) => setProfileForm((f) => ({ ...f, partial_shift_floor: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.effectiveFrom}</label>
              <Input
                type="date"
                value={profileForm.effective_from || ""}
                onChange={(e) => setProfileForm((f) => ({ ...f, effective_from: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{copy.effectiveTo}</label>
              <Input
                type="date"
                value={profileForm.effective_to || ""}
                onChange={(e) => setProfileForm((f) => ({ ...f, effective_to: e.target.value || null }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProfileDialogOpen(false)}>
              {copy.cancel}
            </Button>
            <Button onClick={() => saveProfileMutation.mutate()} disabled={saveProfileMutation.isPending}>
              {saveProfileMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {copy.saveProfile}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
