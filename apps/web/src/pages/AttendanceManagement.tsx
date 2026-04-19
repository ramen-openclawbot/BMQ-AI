import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { CalendarClock, QrCode, Loader2, Users, PencilLine, Lock, LockOpen, CircleCheckBig, CalendarRange } from "lucide-react";
import ShiftPlannerGrid from "@/components/attendance/ShiftPlannerGrid";

interface AttendanceRecordRow {
  id: string;
  employee_code: string;
  employee_name: string | null;
  work_date: string;
  status: string;
  actual_check_in: string | null;
  actual_check_out: string | null;
  minutes_late: number;
  minutes_early_leave: number;
  missing_check_in: boolean;
  missing_check_out: boolean;
  locked_by_hr: boolean;
}

interface AttendanceEventRow {
  id: string;
  employee_code: string;
  employee_name: string | null;
  event_type: "check_in" | "check_out";
  source: string;
  event_time: string;
  work_date: string;
}

interface AttendanceShiftAssignmentRow {
  id: string;
  employee_code: string;
  employee_name: string | null;
  work_date: string;
  shift_id: string;
  attendance_shifts?: {
    id: string;
    shift_name: string;
    start_time: string;
    end_time: string;
    grace_minutes: number;
    early_leave_grace_minutes: number;
  } | null;
}

interface AttendancePeriodRow {
  id: string;
  period_code: string;
  period_name: string;
  date_from: string;
  date_to: string;
  status: "open" | "locked" | "closed";
  closed_by: string | null;
  closed_at: string | null;
  notes: string | null;
}

export default function AttendanceManagement() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isVi = language === "vi";
  const canEdit = canEditModule("attendance");

  const [workDate, setWorkDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [employeeCode, setEmployeeCode] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [eventType, setEventType] = useState<"check_in" | "check_out">("check_in");
  const [adjustReason, setAdjustReason] = useState("");
  const [periodFrom, setPeriodFrom] = useState(workDate);
  const [periodTo, setPeriodTo] = useState(workDate);
  const [periodName, setPeriodName] = useState("");
  const [periodNotes, setPeriodNotes] = useState("");

  const copy = useMemo(() => ({
    title: isVi ? "Chấm công" : "Attendance",
    description: isVi
      ? "Ghi nhận chấm công và console vận hành cho HR"
      : "Attendance capture and HR operations console",
    capture: isVi ? "Ghi nhận check-in/out" : "Capture check-in/out",
    records: isVi ? "Bảng công theo ngày" : "Daily attendance records",
    events: isVi ? "Nhật ký sự kiện" : "Attendance events",
    planner: isVi ? "Xếp ca" : "Shift planner",
    employeeCode: isVi ? "Mã nhân viên" : "Employee code",
    employeeName: isVi ? "Tên nhân viên" : "Employee name",
    workDate: isVi ? "Ngày làm việc" : "Work date",
    checkIn: isVi ? "Check-in" : "Check-in",
    checkOut: isVi ? "Check-out" : "Check-out",
    submit: isVi ? "Ghi nhận" : "Capture event",
    noData: isVi ? "Chưa có dữ liệu" : "No data yet",
    missing: isVi ? "Thiếu" : "Missing",
    locked: isVi ? "Đã chốt" : "Locked",
    periodOps: isVi ? "Kỳ công" : "Attendance period",
    periodOpsDesc: isVi ? "Tạo kỳ mới và khóa/chốt theo phạm vi ngày" : "Create period and control lock/close by date range",
    currentPeriod: isVi ? "Kỳ hiện tại" : "Current period",
    noPeriod: isVi ? "Chưa có kỳ cho ngày đang chọn" : "No period for selected date",
    periodName: isVi ? "Tên kỳ" : "Period name",
    dateFrom: isVi ? "Từ ngày" : "Date from",
    dateTo: isVi ? "Đến ngày" : "Date to",
    periodNotes: isVi ? "Ghi chú kỳ" : "Period notes",
    openPeriod: isVi ? "Mở kỳ" : "Open period",
    lockPeriod: isVi ? "Khóa kỳ" : "Lock period",
    closePeriod: isVi ? "Chốt kỳ" : "Close period",
    reopenPeriod: isVi ? "Mở lại kỳ" : "Reopen period",
    open: isVi ? "Đang mở" : "Open",
    close: isVi ? "Đã chốt" : "Closed",
    periodBlockedCapture: isVi ? "Ngày này thuộc kỳ đã khóa/chốt, không thể ghi nhận sự kiện." : "Selected date is in a locked/closed period, event capture is disabled.",
    periodBlockedAdjust: isVi ? "Ngày này thuộc kỳ đã khóa/chốt, không thể chỉnh công." : "Selected date is in a locked/closed period, attendance adjustment is disabled.",
    periodRequired: isVi ? "Cần tạo kỳ công trước khi thao tác." : "Create a period first before operations.",
  }), [isVi]);

  useEffect(() => {
    setPeriodFrom((prev) => prev || workDate);
    setPeriodTo((prev) => prev || workDate);
  }, [workDate]);

  const { data: records = [], isLoading: recordsLoading } = useQuery({
    queryKey: ["attendance-records", workDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_records")
        .select("id, employee_code, employee_name, work_date, status, actual_check_in, actual_check_out, minutes_late, minutes_early_leave, missing_check_in, missing_check_out, locked_by_hr")
        .eq("work_date", workDate)
        .order("employee_code", { ascending: true });
      if (error) throw error;
      return (data || []) as AttendanceRecordRow[];
    },
  });

  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ["attendance-events", workDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_events")
        .select("id, employee_code, employee_name, event_type, source, event_time, work_date")
        .eq("work_date", workDate)
        .order("event_time", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as AttendanceEventRow[];
    },
  });

  const { data: assignments = [] } = useQuery({
    queryKey: ["attendance-shift-assignments", workDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_shift_assignments")
        .select(`id, employee_code, employee_name, work_date, shift_id, attendance_shifts(id, shift_name, start_time, end_time, grace_minutes, early_leave_grace_minutes)`)
        .eq("work_date", workDate);
      if (error) throw error;
      return (data || []) as AttendanceShiftAssignmentRow[];
    },
  });

  const { data: periods = [] } = useQuery({
    queryKey: ["attendance-periods"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_periods")
        .select("id, period_code, period_name, date_from, date_to, status, closed_by, closed_at, notes")
        .order("date_from", { ascending: false })
        .limit(6);
      if (error) throw error;
      return (data || []) as AttendancePeriodRow[];
    },
  });

  const { data: currentPeriod } = useQuery({
    queryKey: ["attendance-current-period", workDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_periods")
        .select("id, period_code, period_name, date_from, date_to, status, closed_by, closed_at, notes")
        .lte("date_from", workDate)
        .gte("date_to", workDate)
        .order("date_from", { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data?.[0] || null) as AttendancePeriodRow | null;
    },
  });

  const currentPeriodLocked = !!currentPeriod && currentPeriod.status !== "open";
  const canOperateForDate = canEdit && !currentPeriodLocked;

  const getPeriodStatusBadge = (status: AttendancePeriodRow["status"]) => {
    if (status === "open") return <Badge className="bg-emerald-600 hover:bg-emerald-600">{copy.open}</Badge>;
    if (status === "locked") return <Badge variant="secondary">{copy.locked}</Badge>;
    return <Badge variant="destructive">{copy.close}</Badge>;
  };

  const recomputeRecordForEmployee = async (employeeCodeValue: string) => {
    const assignment = assignments.find((x) => x.employee_code === employeeCodeValue);
    const employeeEvents = events
      .filter((x) => x.employee_code === employeeCodeValue)
      .sort((a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime());

    const firstCheckIn = employeeEvents.find((x) => x.event_type === "check_in")?.event_time || null;
    const lastCheckOut = [...employeeEvents].reverse().find((x) => x.event_type === "check_out")?.event_time || null;

    let scheduledStart: string | null = null;
    let scheduledEnd: string | null = null;
    let minutesLate = 0;
    let minutesEarlyLeave = 0;
    let status = "missing_both";
    let missingCheckIn = !firstCheckIn;
    let missingCheckOut = !lastCheckOut;

    if (assignment?.attendance_shifts) {
      const shift = assignment.attendance_shifts;
      scheduledStart = `${workDate}T${shift.start_time}`;
      scheduledEnd = `${workDate}T${shift.end_time}`;

      if (firstCheckIn) {
        const diff = Math.floor((new Date(firstCheckIn).getTime() - new Date(scheduledStart).getTime()) / 60000);
        minutesLate = Math.max(0, diff - (shift.grace_minutes || 0));
      }
      if (lastCheckOut) {
        const diff = Math.floor((new Date(scheduledEnd).getTime() - new Date(lastCheckOut).getTime()) / 60000);
        minutesEarlyLeave = Math.max(0, diff - (shift.early_leave_grace_minutes || 0));
      }
    }

    if (!firstCheckIn && !lastCheckOut) status = "missing_both";
    else if (!firstCheckIn) status = "missing_check_in";
    else if (!lastCheckOut) status = "missing_check_out";
    else if (minutesLate > 0 && minutesEarlyLeave > 0) status = "late_early_leave";
    else if (minutesLate > 0) status = "late";
    else if (minutesEarlyLeave > 0) status = "early_leave";
    else status = "present";

    const payload = {
      employee_code: employeeCodeValue,
      employee_name: employeeEvents[0]?.employee_name || assignment?.employee_name || employeeName || null,
      work_date: workDate,
      shift_assignment_id: assignment?.id || null,
      shift_id: assignment?.shift_id || null,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      actual_check_in: firstCheckIn,
      actual_check_out: lastCheckOut,
      status,
      minutes_late: minutesLate,
      minutes_early_leave: minutesEarlyLeave,
      missing_check_in: missingCheckIn,
      missing_check_out: missingCheckOut,
    };

    const { error } = await (supabase as any)
      .from("attendance_records")
      .upsert(payload, { onConflict: "employee_code,work_date" });
    if (error) throw error;
  };

  const captureMutation = useMutation({
    mutationFn: async () => {
      if (!employeeCode.trim()) throw new Error(isVi ? "Thiếu mã nhân viên" : "Employee code is required");
      if (currentPeriodLocked) throw new Error(copy.periodBlockedCapture);
      const now = new Date().toISOString();
      const payload = {
        employee_code: employeeCode.trim(),
        employee_name: employeeName.trim() || null,
        event_type: eventType,
        source: "qr",
        event_time: now,
        work_date: workDate,
        metadata: { captured_from: "attendance_management_shell" },
      };
      const { error } = await (supabase as any).from("attendance_events").insert(payload);
      if (error) throw error;
      return payload.employee_code;
    },
    onSuccess: async (employeeCodeValue) => {
      toast({ title: isVi ? "Đã ghi nhận" : "Captured" });
      setEmployeeCode("");
      setEmployeeName("");
      await queryClient.invalidateQueries({ queryKey: ["attendance-events", workDate] });
      await recomputeRecordForEmployee(employeeCodeValue);
      queryClient.invalidateQueries({ queryKey: ["attendance-records", workDate] });
    },
    onError: (error: any) => {
      toast({
        title: isVi ? "Không thể ghi nhận" : "Unable to capture event",
        description: error?.message || undefined,
        variant: "destructive",
      });
    },
  });

  const adjustMutation = useMutation({
    mutationFn: async (record: AttendanceRecordRow) => {
      if (!canEdit) throw new Error(isVi ? "Không có quyền chỉnh công" : "No permission to adjust attendance");
      if (currentPeriodLocked) throw new Error(copy.periodBlockedAdjust);
      if (!adjustReason.trim()) throw new Error(isVi ? "Thiếu lý do chỉnh công" : "Adjustment reason is required");

      const oldValue = {
        actual_check_in: record.actual_check_in,
        actual_check_out: record.actual_check_out,
        status: record.status,
      };

      const newValue = {
        actual_check_in: record.actual_check_in || `${workDate}T08:00:00`,
        actual_check_out: record.actual_check_out || `${workDate}T17:00:00`,
        status: "present",
      };

      const { error: updateError } = await (supabase as any)
        .from("attendance_records")
        .update({
          actual_check_in: newValue.actual_check_in,
          actual_check_out: newValue.actual_check_out,
          status: newValue.status,
          missing_check_in: false,
          missing_check_out: false,
          notes: adjustReason.trim(),
        })
        .eq("id", record.id);
      if (updateError) throw updateError;

      const { error: logError } = await (supabase as any)
        .from("attendance_adjustments")
        .insert({
          attendance_record_id: record.id,
          adjustment_type: "manual_record_edit",
          old_value: oldValue,
          new_value: newValue,
          reason: adjustReason.trim(),
        });
      if (logError) throw logError;
    },
    onSuccess: () => {
      setAdjustReason("");
      toast({ title: isVi ? "Đã chỉnh công" : "Attendance adjusted" });
      queryClient.invalidateQueries({ queryKey: ["attendance-records", workDate] });
    },
    onError: (error: any) => {
      toast({
        title: isVi ? "Không thể chỉnh công" : "Unable to adjust attendance",
        description: error?.message || undefined,
        variant: "destructive",
      });
    },
  });

  const createPeriodMutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error(isVi ? "Không có quyền thao tác kỳ công" : "No permission to manage attendance periods");
      if (!periodFrom || !periodTo) throw new Error(isVi ? "Thiếu ngày bắt đầu/kết thúc" : "Date range is required");
      if (periodFrom > periodTo) throw new Error(isVi ? "Ngày bắt đầu phải trước ngày kết thúc" : "Date from must be before date to");

      const fromCode = periodFrom.replaceAll("-", "");
      const toCode = periodTo.replaceAll("-", "");
      const fallbackName = `${isVi ? "Kỳ công" : "Attendance period"} ${periodFrom} → ${periodTo}`;
      const periodCode = `ATT-${fromCode}-${toCode}-${Date.now().toString().slice(-4)}`;

      const { error } = await (supabase as any)
        .from("attendance_periods")
        .insert({
          period_code: periodCode,
          period_name: periodName.trim() || fallbackName,
          date_from: periodFrom,
          date_to: periodTo,
          status: "open",
          notes: periodNotes.trim() || null,
        });
      if (error) throw error;
    },
    onSuccess: async () => {
      setPeriodName("");
      setPeriodNotes("");
      toast({ title: isVi ? "Đã mở kỳ công" : "Attendance period opened" });
      await queryClient.invalidateQueries({ queryKey: ["attendance-periods"] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-current-period", workDate] });
    },
    onError: (error: any) => {
      toast({
        title: isVi ? "Không thể mở kỳ công" : "Unable to open attendance period",
        description: error?.message || undefined,
        variant: "destructive",
      });
    },
  });

  const updatePeriodStatusMutation = useMutation({
    mutationFn: async (nextStatus: AttendancePeriodRow["status"]) => {
      if (!canEdit) throw new Error(isVi ? "Không có quyền thao tác kỳ công" : "No permission to manage attendance periods");
      if (!currentPeriod) throw new Error(copy.periodRequired);
      if (currentPeriod.status === nextStatus) return;

      const nowIso = new Date().toISOString();
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id || null;

      const periodPatch =
        nextStatus === "closed"
          ? { status: "closed", closed_at: nowIso, closed_by: userId }
          : { status: nextStatus, closed_at: null, closed_by: null };

      const { error: periodError } = await (supabase as any)
        .from("attendance_periods")
        .update(periodPatch)
        .eq("id", currentPeriod.id);
      if (periodError) throw periodError;

      if (nextStatus === "open") {
        const { error: unlockError } = await (supabase as any)
          .from("attendance_records")
          .update({
            locked_by_hr: false,
            finalized_at: null,
            finalized_by: null,
          })
          .gte("work_date", currentPeriod.date_from)
          .lte("work_date", currentPeriod.date_to);
        if (unlockError) throw unlockError;
      } else if (nextStatus === "locked") {
        const { error: lockError } = await (supabase as any)
          .from("attendance_records")
          .update({
            locked_by_hr: true,
            finalized_at: null,
            finalized_by: null,
          })
          .gte("work_date", currentPeriod.date_from)
          .lte("work_date", currentPeriod.date_to);
        if (lockError) throw lockError;
      } else {
        const { error: closeError } = await (supabase as any)
          .from("attendance_records")
          .update({
            locked_by_hr: true,
            finalized_at: nowIso,
            finalized_by: userId,
          })
          .gte("work_date", currentPeriod.date_from)
          .lte("work_date", currentPeriod.date_to);
        if (closeError) throw closeError;
      }
    },
    onSuccess: async () => {
      toast({ title: isVi ? "Đã cập nhật kỳ công" : "Attendance period updated" });
      await queryClient.invalidateQueries({ queryKey: ["attendance-periods"] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-current-period", workDate] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-records"] });
    },
    onError: (error: any) => {
      toast({
        title: isVi ? "Không thể cập nhật kỳ công" : "Unable to update attendance period",
        description: error?.message || undefined,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{copy.title}</h1>
        <p className="text-muted-foreground">{copy.description}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CircleCheckBig className="h-5 w-5" /> {copy.periodOps}</CardTitle>
          <CardDescription>{copy.periodOpsDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border p-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <div className="text-sm font-medium">{copy.currentPeriod}</div>
              {currentPeriod ? (
                <div className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{currentPeriod.period_name}</span>
                  {" "}
                  ({currentPeriod.date_from} → {currentPeriod.date_to})
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">{copy.noPeriod}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {currentPeriod ? getPeriodStatusBadge(currentPeriod.status) : <Badge variant="outline">N/A</Badge>}
              {canEdit && currentPeriod && currentPeriod.status !== "open" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updatePeriodStatusMutation.mutate("open")}
                  disabled={updatePeriodStatusMutation.isPending}
                >
                  <LockOpen className="h-4 w-4 mr-1" />
                  {copy.reopenPeriod}
                </Button>
              )}
              {canEdit && currentPeriod && currentPeriod.status === "open" && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updatePeriodStatusMutation.mutate("locked")}
                    disabled={updatePeriodStatusMutation.isPending}
                  >
                    <Lock className="h-4 w-4 mr-1" />
                    {copy.lockPeriod}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => updatePeriodStatusMutation.mutate("closed")}
                    disabled={updatePeriodStatusMutation.isPending}
                  >
                    {copy.closePeriod}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-5">
            <Input
              placeholder={copy.periodName}
              value={periodName}
              onChange={(e) => setPeriodName(e.target.value)}
              disabled={!canEdit}
            />
            <Input
              type="date"
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
              disabled={!canEdit}
            />
            <Input
              type="date"
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
              disabled={!canEdit}
            />
            <Input
              placeholder={copy.periodNotes}
              value={periodNotes}
              onChange={(e) => setPeriodNotes(e.target.value)}
              disabled={!canEdit}
            />
            <Button onClick={() => createPeriodMutation.mutate()} disabled={!canEdit || createPeriodMutation.isPending}>
              {createPeriodMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {copy.openPeriod}
            </Button>
          </div>

          {periods.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {periods.map((period) => (
                <div key={period.id} className="text-xs rounded border px-2 py-1 flex items-center gap-2">
                  <span className="font-medium">{period.period_name}</span>
                  <span className="text-muted-foreground">{period.date_from} → {period.date_to}</span>
                  {getPeriodStatusBadge(period.status)}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{isVi ? "Tổng bản ghi" : "Total records"}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{isVi ? "Thiếu check-in/out" : "Missing check-in/out"}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.filter(r => r.missing_check_in || r.missing_check_out).length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{isVi ? "Đi trễ / về sớm" : "Late / early leave"}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.filter(r => r.minutes_late > 0 || r.minutes_early_leave > 0).length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{isVi ? "Sự kiện hôm nay" : "Events today"}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{events.length}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" /> {copy.capture}</CardTitle>
          <CardDescription>
            {canEdit
              ? (isVi ? "Shell cho Phase 1, dùng để capture check-in/out trước khi nối QR public flow" : "Phase 1 shell, used to capture check-in/out before connecting public QR flow")
              : (isVi ? "Bạn chỉ có quyền xem, chưa có quyền chỉnh công" : "You have view-only access, not attendance edit access")}
          </CardDescription>
          {currentPeriodLocked ? (
            <CardDescription className="text-amber-600 dark:text-amber-400">{copy.periodBlockedCapture}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          <Input placeholder={copy.employeeCode} value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} disabled={!canOperateForDate} />
          <Input placeholder={copy.employeeName} value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} disabled={!canOperateForDate} />
          <div className="flex gap-2">
            <Button type="button" variant={eventType === "check_in" ? "default" : "outline"} onClick={() => setEventType("check_in")} disabled={!canOperateForDate}>{copy.checkIn}</Button>
            <Button type="button" variant={eventType === "check_out" ? "default" : "outline"} onClick={() => setEventType("check_out")} disabled={!canOperateForDate}>{copy.checkOut}</Button>
          </div>
          <Button onClick={() => captureMutation.mutate()} disabled={!canOperateForDate || captureMutation.isPending}>
            {captureMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {copy.submit}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><PencilLine className="h-4 w-4" /> {isVi ? "Chỉnh công nhanh" : "Quick attendance adjustment"}</CardTitle>
          <CardDescription>{isVi ? "Tạm thời dùng cho quên check-in/out trong Phase 1" : "Temporary Phase 1 flow for missed check-in/out"}</CardDescription>
          {currentPeriodLocked ? (
            <CardDescription className="text-amber-600 dark:text-amber-400">{copy.periodBlockedAdjust}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input placeholder={isVi ? "Lý do chỉnh công" : "Adjustment reason"} value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} disabled={!canOperateForDate} />
          <Badge variant="outline">{isVi ? "Apply từ bảng công bên dưới" : "Apply from table below"}</Badge>
        </CardContent>
      </Card>

      <Tabs defaultValue="records" className="space-y-4">
        <TabsList>
          <TabsTrigger value="records" className="gap-2"><Users className="h-4 w-4" />{copy.records}</TabsTrigger>
          <TabsTrigger value="events" className="gap-2"><CalendarClock className="h-4 w-4" />{copy.events}</TabsTrigger>
          <TabsTrigger value="planner" className="gap-2"><CalendarRange className="h-4 w-4" />{copy.planner}</TabsTrigger>
        </TabsList>

        <TabsContent value="records">
          <Card>
            <CardContent className="pt-6">
              {recordsLoading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy.employeeCode}</TableHead>
                      <TableHead>{copy.employeeName}</TableHead>
                      <TableHead>{copy.workDate}</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>{copy.checkIn}</TableHead>
                      <TableHead>{copy.checkOut}</TableHead>
                      <TableHead>{isVi ? "Cảnh báo" : "Flags"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{copy.noData}</TableCell></TableRow>
                    ) : records.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.employee_code}</TableCell>
                        <TableCell>{row.employee_name || "-"}</TableCell>
                        <TableCell>{row.work_date}</TableCell>
                        <TableCell><Badge variant="outline">{row.status}</Badge></TableCell>
                        <TableCell>{row.actual_check_in ? format(new Date(row.actual_check_in), "HH:mm") : "-"}</TableCell>
                        <TableCell>{row.actual_check_out ? format(new Date(row.actual_check_out), "HH:mm") : "-"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 items-center">
                            {(row.missing_check_in || row.missing_check_out) && <Badge variant="destructive">{copy.missing}</Badge>}
                            {row.locked_by_hr && <Badge variant="secondary">{copy.locked}</Badge>}
                            {(row.minutes_late > 0 || row.minutes_early_leave > 0) && <Badge variant="outline">{row.minutes_late}/{row.minutes_early_leave}m</Badge>}
                            {canEdit && (row.missing_check_in || row.missing_check_out) && (
                              <Button size="sm" variant="outline" onClick={() => adjustMutation.mutate(row)} disabled={adjustMutation.isPending || !adjustReason.trim() || !canOperateForDate}>
                                {isVi ? "Chỉnh" : "Adjust"}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="events">
          <Card>
            <CardContent className="pt-6">
              {eventsLoading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy.employeeCode}</TableHead>
                      <TableHead>{copy.employeeName}</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{copy.noData}</TableCell></TableRow>
                    ) : events.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.employee_code}</TableCell>
                        <TableCell>{row.employee_name || "-"}</TableCell>
                        <TableCell><Badge variant={row.event_type === "check_in" ? "default" : "secondary"}>{row.event_type}</Badge></TableCell>
                        <TableCell>{row.source}</TableCell>
                        <TableCell>{format(new Date(row.event_time), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="planner">
          <ShiftPlannerGrid />
        </TabsContent>
      </Tabs>
    </div>
  );
}
