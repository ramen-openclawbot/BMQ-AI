import { usePeopleLabels } from "@/hooks/usePeopleLabels";
import { showPeopleToast, PeopleLocalError, peopleErrorDescription, peopleToast, usePeopleCopy } from "@/hooks/usePeopleCopy";
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
import { CalendarClock, QrCode, Loader2, Users, PencilLine, Lock, LockOpen, CircleCheckBig, CalendarRange, Radar } from "lucide-react";
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
  source_type: string | null;
  source_event_id: string | null;
  source_actor_type: string | null;
  source_distance_m: number | null;
  source_accuracy_m: number | null;
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

interface PilotAttendanceEventRow {
  id: string;
  actor_type: "report_staff" | "delivery_staff";
  employee_code: string;
  employee_name: string | null;
  work_date: string;
  decision: "accepted" | "rejected";
  reason_code: string;
  distance_m_rounded: number | null;
  accuracy_m_rounded: number | null;
  geofence_code: string | null;
  geofence_name: string | null;
  geofence_location_type: string | null;
  geofence_radius_m: number | null;
  has_override: boolean;
  created_at: string;
}

interface PilotAttendanceMetrics {
  event_count: number;
  accepted_count: number;
  rejected_count: number;
  low_accuracy_count: number;
  outside_radius_count: number;
  duplicate_count: number;
  override_count: number;
  success_rate: number;
}

interface PilotAttendanceDashboard {
  metrics: PilotAttendanceMetrics;
  events: PilotAttendanceEventRow[];
  pagination: {
    limit: number;
    offset: number;
    returned_count: number;
    total_count: number;
    has_next_page: boolean;
  };
}

function isPostgrestUndefinedColumn(error: any) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "").toLowerCase();
  const referencesProvenanceColumn = [
    "source_type",
    "source_event_id",
    "source_actor_type",
    "source_distance_m",
    "source_accuracy_m",
  ].some((column) => message.includes(column));
  const isMissingSchemaMessage = message.includes("could not find")
    || message.includes("schema cache")
    || message.includes("does not exist");
  return code === "42703"
    || code === "PGRST204"
    || (referencesProvenanceColumn && isMissingSchemaMessage);
}

function isPostgrestMissingRpc(error: any) {
  const code = String(error?.code || "");
  const message = String(error?.message || error?.details || "").toLowerCase();
  return code === "PGRST202" || code === "42883" || message.includes("could not find the function") || message.includes("function") && message.includes("schema cache");
}

const LEGACY_ATTENDANCE_RECORD_SELECT = "id, employee_code, employee_name, work_date, status, actual_check_in, actual_check_out, minutes_late, minutes_early_leave, missing_check_in, missing_check_out, locked_by_hr";
const PROVENANCE_ATTENDANCE_RECORD_SELECT = `${LEGACY_ATTENDANCE_RECORD_SELECT}, source_type, source_event_id, source_actor_type, source_distance_m, source_accuracy_m`;


export default function AttendanceManagement() {
  const pc = usePeopleCopy();
  const labels = usePeopleLabels();
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
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
  const [pilotDateFrom, setPilotDateFrom] = useState(workDate);
  const [pilotDateTo, setPilotDateTo] = useState(workDate);
  const [pilotEmployeeQuery, setPilotEmployeeQuery] = useState("");
  const [pilotActorType, setPilotActorType] = useState<"" | "report_staff" | "delivery_staff">("");
  const [pilotGeofenceQuery, setPilotGeofenceQuery] = useState("");
  const [pilotDecision, setPilotDecision] = useState<"" | "accepted" | "rejected">("");
  const [pilotOffset, setPilotOffset] = useState(0);

  const copy = useMemo(() => ({
    title: pc("attendance"),
    description: pc("attendanceCaptureAndHrOperationsConsole"),
    capture: pc("captureCheckInOut"),
    records: pc("dailyAttendanceRecords"),
    events: pc("attendanceEvents"),
    planner: pc("shiftPlanner"),
    employeeCode: pc("employeeCode"),
    employeeName: pc("employeeName"),
    workDate: pc("workDate"),
    checkIn: pc("checkIn"),
    checkOut: pc("checkOut"),
    submit: pc("captureEvent"),
    noData: pc("noDataYet"),
    missing: pc("missingAttendanceFlag"),
    locked: pc("locked"),
    periodOps: pc("attendancePeriod"),
    periodOpsDesc: pc("createPeriodAndControlLockCloseBy"),
    currentPeriod: pc("currentPeriod"),
    noPeriod: pc("noPeriodForSelectedDate"),
    periodName: pc("periodName"),
    dateFrom: pc("dateFrom"),
    dateTo: pc("dateTo"),
    periodNotes: pc("periodNotes"),
    openPeriod: pc("openPeriod"),
    lockPeriod: pc("lockPeriod"),
    closePeriod: pc("closePeriod"),
    reopenPeriod: pc("reopenPeriod"),
    open: pc("open"),
    close: pc("closed"),
    periodBlockedCapture: pc("selectedDateIsInALockedClosed"),
    periodBlockedAdjust: pc("selectedDateIsInALockedClosed2"),
    periodRequired: pc("createAPeriodFirstBeforeOperations"),
    pilotDashboard: pc("gpsPilot"),
    pilotDashboardDesc: pc("monitorGpsAttendanceQualityReconcileExceptionsAnd"),
    dateRange: pc("dateRange"),
    actorType: pc("actorType"),
    geofence: pc("locationGeofence"),
    decision: pc("decision"),
    allActors: pc("allActors"),
    allDecisions: pc("allDecisions"),
    reportStaff: pc("kioskStaff"),
    deliveryStaff: pc("deliveryStaff"),
    accepted: pc("accepted"),
    rejected: pc("rejected"),
    successRate: pc("successRate"),
    lowAccuracy: pc("lowAccuracy"),
    outsideRadius: pc("outsideRadius"),
    overrides: pc("overrides"),
    duplicate: pc("alreadyCheckedIn"),
  }), [pc]);

  useEffect(() => {
    setPeriodFrom((prev) => prev || workDate);
    setPeriodTo((prev) => prev || workDate);
  }, [workDate]);

  useEffect(() => {
    setPilotOffset(0);
  }, [pilotDateFrom, pilotDateTo, pilotEmployeeQuery, pilotActorType, pilotGeofenceQuery, pilotDecision]);

  const { data: records = [], isLoading: recordsLoading } = useQuery({
    queryKey: ["attendance-records", workDate],
    queryFn: async () => {
      const queryRecords = (columns: string) => (supabase as any)
        .from("attendance_records")
        .select(columns)
        .eq("work_date", workDate)
        .order("employee_code", { ascending: true });

      const { data, error } = await queryRecords(PROVENANCE_ATTENDANCE_RECORD_SELECT);
      if (!error) return (data || []) as AttendanceRecordRow[];
      if (!isPostgrestUndefinedColumn(error)) throw error;

      const legacy = await queryRecords(LEGACY_ATTENDANCE_RECORD_SELECT);
      if (legacy.error) throw legacy.error;
      return (legacy.data || []).map((row: any) => ({
        ...row,
        source_type: null,
        source_event_id: null,
        source_actor_type: null,
        source_distance_m: null,
        source_accuracy_m: null,
      })) as AttendanceRecordRow[];
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

  const { data: pilotAttendanceDashboard, isLoading: pilotAttendanceLoading, isError: pilotAttendanceIsError, error: pilotAttendanceError } = useQuery({
    queryKey: [
      "mobile-gps-attendance-pilot-dashboard",
      pilotDateFrom,
      pilotDateTo,
      pilotEmployeeQuery,
      pilotActorType,
      pilotGeofenceQuery,
      pilotDecision,
      pilotOffset,
    ],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_mobile_gps_attendance_pilot_dashboard", {
        p_date_from: pilotDateFrom || null,
        p_date_to: pilotDateTo || pilotDateFrom || null,
        p_employee_query: pilotEmployeeQuery.trim() || null,
        p_actor_type: pilotActorType || null,
        p_geofence_query: pilotGeofenceQuery.trim() || null,
        p_decision: pilotDecision || null,
        p_limit: 50,
        p_offset: pilotOffset,
      });
      if (error) {
        if (isPostgrestMissingRpc(error)) {
          return { capability_unavailable: true, metrics: null, events: [], pagination: null } as unknown as PilotAttendanceDashboard & { capability_unavailable: true };
        }
        throw error;
      }
      return data as PilotAttendanceDashboard;
    },
  });

  const pilotCapabilityUnavailable = (pilotAttendanceDashboard as any)?.capability_unavailable === true;
  const pilotMetrics = pilotAttendanceDashboard?.metrics || {
    event_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    low_accuracy_count: 0,
    outside_radius_count: 0,
    duplicate_count: 0,
    override_count: 0,
    success_rate: 0,
  };
  const pilotAttendanceEvents = pilotAttendanceDashboard?.events || [];
  const pilotPagination = pilotAttendanceDashboard?.pagination;

  const currentPeriodLocked = !!currentPeriod && currentPeriod.status !== "open";
  const canOperateForDate = canEdit && !currentPeriodLocked;

  const getPeriodStatusBadge = (status: AttendancePeriodRow["status"]) => {
    if (status === "open") return <Badge className="bg-emerald-600 hover:bg-emerald-600">{copy.open}</Badge>;
    if (status === "locked") return <Badge variant="secondary">{copy.locked}</Badge>;
    return <Badge variant="destructive">{copy.close}</Badge>;
  };

  const formatPilotReason = (reasonCode: string) => {
    if (reasonCode === "already_checked_in" || reasonCode === "duplicate_accepted") return copy.duplicate;
    if (reasonCode === "low_accuracy") return copy.lowAccuracy;
    if (reasonCode === "outside_radius") return copy.outsideRadius;
    return labels.reason(reasonCode);
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
    const missingCheckIn = !firstCheckIn;
    const missingCheckOut = !lastCheckOut;

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
      if (!employeeCode.trim()) throw new PeopleLocalError({ key: "employeeCodeIsRequired" });
      if (currentPeriodLocked) throw new PeopleLocalError({ key: "selectedDateIsInALockedClosed" });
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
      showPeopleToast("success", peopleToast("captured"));
      setEmployeeCode("");
      setEmployeeName("");
      await queryClient.invalidateQueries({ queryKey: ["attendance-events", workDate] });
      await recomputeRecordForEmployee(employeeCodeValue);
      queryClient.invalidateQueries({ queryKey: ["attendance-records", workDate] });
    },
    onError: (error: any) => {
      showPeopleToast("error", peopleToast("unableToCaptureEvent"), {
        description: peopleErrorDescription(error, "pleaseTryAgain"),
      });
    },
  });

  const adjustMutation = useMutation({
    mutationFn: async (record: AttendanceRecordRow) => {
      if (!canEdit) throw new PeopleLocalError({ key: "noPermissionToAdjustAttendance" });
      if (currentPeriodLocked) throw new PeopleLocalError({ key: "selectedDateIsInALockedClosed2" });
      if (!adjustReason.trim()) throw new PeopleLocalError({ key: "adjustmentReasonIsRequired" });

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
      showPeopleToast("success", peopleToast("attendanceAdjusted"));
      queryClient.invalidateQueries({ queryKey: ["attendance-records", workDate] });
    },
    onError: (error: any) => {
      showPeopleToast("error", peopleToast("unableToAdjustAttendance"), {
        description: peopleErrorDescription(error, "pleaseTryAgain"),
      });
    },
  });

  const createPeriodMutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new PeopleLocalError({ key: "noPermissionToManageAttendancePeriods" });
      if (!periodFrom || !periodTo) throw new PeopleLocalError({ key: "dateRangeIsRequired" });
      if (periodFrom > periodTo) throw new PeopleLocalError({ key: "dateFromMustBeBeforeDateTo" });

      const fromCode = periodFrom.replace(/-/g, "");
      const toCode = periodTo.replace(/-/g, "");
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
      showPeopleToast("success", peopleToast("attendancePeriodOpened"));
      await queryClient.invalidateQueries({ queryKey: ["attendance-periods"] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-current-period", workDate] });
    },
    onError: (error: any) => {
      showPeopleToast("error", peopleToast("unableToOpenAttendancePeriod"), {
        description: peopleErrorDescription(error, "pleaseTryAgain"),
      });
    },
  });

  const updatePeriodStatusMutation = useMutation({
    mutationFn: async (nextStatus: AttendancePeriodRow["status"]) => {
      if (!canEdit) throw new PeopleLocalError({ key: "noPermissionToManageAttendancePeriods" });
      if (!currentPeriod) throw new PeopleLocalError({ key: "createAPeriodFirstBeforeOperations" });
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
      showPeopleToast("success", peopleToast("attendancePeriodUpdated"));
      await queryClient.invalidateQueries({ queryKey: ["attendance-periods"] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-current-period", workDate] });
      await queryClient.invalidateQueries({ queryKey: ["attendance-records"] });
    },
    onError: (error: any) => {
      showPeopleToast("error", peopleToast("unableToUpdateAttendancePeriod"), {
        description: peopleErrorDescription(error, "pleaseTryAgain"),
      });
    },
  });

  return (
    <div data-i18n-version="d-people-v1" className="space-y-6">
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
            <CardTitle className="text-sm font-medium">{pc("totalRecords")}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{pc("missingCheckInOut")}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.filter(r => r.missing_check_in || r.missing_check_out).length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{pc("lateEarlyLeave")}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{records.filter(r => r.minutes_late > 0 || r.minutes_early_leave > 0).length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{pc("eventsToday")}</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{events.length}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" /> {copy.capture}</CardTitle>
          <CardDescription>
            {canEdit
              ? (pc("phase1ShellUsedToCaptureCheck"))
              : (pc("youHaveViewOnlyAccessNotAttendance"))}
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
          <CardTitle className="text-base flex items-center gap-2"><PencilLine className="h-4 w-4" /> {pc("quickAttendanceAdjustment")}</CardTitle>
          <CardDescription>{pc("temporaryPhase1FlowForMissedCheck")}</CardDescription>
          {currentPeriodLocked ? (
            <CardDescription className="text-amber-600 dark:text-amber-400">{copy.periodBlockedAdjust}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input placeholder={pc("adjustmentReason")} value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} disabled={!canOperateForDate} />
          <Badge variant="outline">{pc("applyFromTableBelow")}</Badge>
        </CardContent>
      </Card>

      <Tabs defaultValue="records" className="space-y-4">
        <TabsList>
          <TabsTrigger value="records" className="gap-2"><Users className="h-4 w-4" />{copy.records}</TabsTrigger>
          <TabsTrigger value="events" className="gap-2"><CalendarClock className="h-4 w-4" />{copy.events}</TabsTrigger>
          <TabsTrigger value="pilot" className="gap-2"><Radar className="h-4 w-4" />{copy.pilotDashboard}</TabsTrigger>
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
                      <TableHead>{pc("status")}</TableHead>
                      <TableHead>{copy.checkIn}</TableHead>
                      <TableHead>{copy.checkOut}</TableHead>
                      <TableHead>{pc("source")}</TableHead>
                      <TableHead>{pc("flags")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">{copy.noData}</TableCell></TableRow>
                    ) : records.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.employee_code}</TableCell>
                        <TableCell>{row.employee_name || "-"}</TableCell>
                        <TableCell>{row.work_date}</TableCell>
                        <TableCell><Badge variant="outline">{labels.status(row.status)}</Badge></TableCell>
                        <TableCell>{row.actual_check_in ? format(new Date(row.actual_check_in), "HH:mm") : "-"}</TableCell>
                        <TableCell>{row.actual_check_out ? format(new Date(row.actual_check_out), "HH:mm") : "-"}</TableCell>
                        <TableCell>
                          {row.source_type === "mobile_gps" ? (
                            <div className="flex flex-col gap-1 text-xs">
                              <Badge variant="outline">GPS · {labels.source(row.source_actor_type || "mobile")}</Badge>
                              <span className="text-muted-foreground">
                                {row.source_distance_m !== null ? `${Math.round(Number(row.source_distance_m))}m` : "-"}
                                {" / "}
                                {row.source_accuracy_m !== null ? `±${Math.round(Number(row.source_accuracy_m))}m` : "±-"}
                              </span>
                            </div>
                          ) : row.source_type ? (
                            <Badge variant="outline">{labels.source(row.source_type)}</Badge>
                          ) : "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 items-center">
                            {(row.missing_check_in || row.missing_check_out) && <Badge variant="destructive">{copy.missing}</Badge>}
                            {row.locked_by_hr && <Badge variant="secondary">{copy.locked}</Badge>}
                            {(row.minutes_late > 0 || row.minutes_early_leave > 0) && <Badge variant="outline">{row.minutes_late}/{row.minutes_early_leave}m</Badge>}
                            {canEdit && (row.missing_check_in || row.missing_check_out) && (
                              <Button size="sm" variant="outline" onClick={() => adjustMutation.mutate(row)} disabled={adjustMutation.isPending || !adjustReason.trim() || !canOperateForDate}>
                                {pc("adjust")}
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
                      <TableHead>{pc("type")}</TableHead>
                      <TableHead>{pc("source")}</TableHead>
                      <TableHead>{pc("time")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{copy.noData}</TableCell></TableRow>
                    ) : events.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.employee_code}</TableCell>
                        <TableCell>{row.employee_name || "-"}</TableCell>
                        <TableCell><Badge variant={row.event_type === "check_in" ? "default" : "secondary"}>{labels.source(row.event_type)}</Badge></TableCell>
                        <TableCell>{labels.source(row.source)}</TableCell>
                        <TableCell>{format(new Date(row.event_time), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pilot">
          <Card data-testid="attendance-pilot-dashboard">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Radar className="h-5 w-5" /> {copy.pilotDashboard}</CardTitle>
              <CardDescription>{copy.pilotDashboardDesc}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.dateFrom}</label>
                  <Input type="date" value={pilotDateFrom} onChange={(e) => setPilotDateFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.dateTo}</label>
                  <Input type="date" value={pilotDateTo} onChange={(e) => setPilotDateTo(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.employeeName}</label>
                  <Input placeholder={`${copy.employeeCode} / ${copy.employeeName}`} value={pilotEmployeeQuery} onChange={(e) => setPilotEmployeeQuery(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.actorType}</label>
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={pilotActorType} onChange={(e) => setPilotActorType(e.target.value as typeof pilotActorType)}>
                    <option value="">{copy.allActors}</option>
                    <option value="report_staff">{copy.reportStaff}</option>
                    <option value="delivery_staff">{copy.deliveryStaff}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.geofence}</label>
                  <Input placeholder={copy.geofence} value={pilotGeofenceQuery} onChange={(e) => setPilotGeofenceQuery(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{copy.decision}</label>
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={pilotDecision} onChange={(e) => setPilotDecision(e.target.value as typeof pilotDecision)}>
                    <option value="">{copy.allDecisions}</option>
                    <option value="accepted">{copy.accepted}</option>
                    <option value="rejected">{copy.rejected}</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{pc("gpsEvents")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{pilotMetrics.event_count}</div></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{copy.accepted} / {copy.rejected}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{pilotMetrics.accepted_count} / {pilotMetrics.rejected_count}</div><div className="text-xs text-muted-foreground">{copy.successRate}: {pilotMetrics.success_rate}%</div></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{copy.lowAccuracy} / {copy.outsideRadius}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{pilotMetrics.low_accuracy_count} / {pilotMetrics.outside_radius_count}</div></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{copy.duplicate} / {copy.overrides}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold">{pilotMetrics.duplicate_count} / {pilotMetrics.override_count}</div></CardContent></Card>
              </div>

              {pilotCapabilityUnavailable ? (
                <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  {pc("gpsPilotIsAwaitingBackendMigrationRecords")}
                </div>
              ) : pilotAttendanceIsError ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {pc("unableToLoadGpsPilotDashboard")}: {pilotAttendanceError instanceof Error ? pilotAttendanceError.message : "unknown_error"}
                </div>
              ) : pilotAttendanceLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.workDate}</TableHead>
                        <TableHead>{copy.employeeName}</TableHead>
                        <TableHead>{copy.actorType}</TableHead>
                        <TableHead>{copy.geofence}</TableHead>
                        <TableHead>{copy.decision}</TableHead>
                        <TableHead>{pc("reason")}</TableHead>
                        <TableHead>{pc("distanceAccuracy")}</TableHead>
                        <TableHead>{pc("indicators")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pilotAttendanceEvents.length === 0 ? (
                        <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">{copy.noData}</TableCell></TableRow>
                      ) : pilotAttendanceEvents.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap">{row.work_date}</TableCell>
                          <TableCell><div className="font-medium">{row.employee_name || "-"}</div><div className="text-xs text-muted-foreground">{row.employee_code}</div></TableCell>
                          <TableCell><Badge variant="outline">{row.actor_type === "report_staff" ? copy.reportStaff : copy.deliveryStaff}</Badge></TableCell>
                          <TableCell><div>{row.geofence_name || row.geofence_code || "-"}</div><div className="text-xs text-muted-foreground">{labels.location(row.geofence_location_type || "-")}{row.geofence_radius_m !== null ? ` · ${Math.round(Number(row.geofence_radius_m))}m` : ""}</div></TableCell>
                          <TableCell><Badge variant={row.decision === "accepted" ? "default" : "destructive"}>{row.decision === "accepted" ? copy.accepted : copy.rejected}</Badge></TableCell>
                          <TableCell>{formatPilotReason(row.reason_code)}</TableCell>
                          <TableCell>{row.distance_m_rounded !== null ? `${Math.round(Number(row.distance_m_rounded))}m` : "-"} / {row.accuracy_m_rounded !== null ? `±${Math.round(Number(row.accuracy_m_rounded))}m` : "±-"}</TableCell>
                          <TableCell><div className="flex flex-wrap gap-1">{(row.reason_code === "already_checked_in" || row.reason_code === "duplicate_accepted") && <Badge variant="secondary">{copy.duplicate}</Badge>}{row.has_override && <Badge variant="outline">{copy.overrides}</Badge>}</div></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <div>
                  {pc("showing")} {pilotPagination?.returned_count || 0} / {pilotPagination?.total_count || 0}
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPilotOffset(Math.max(0, pilotOffset - (pilotPagination?.limit || 50)))} disabled={pilotOffset === 0 || pilotAttendanceLoading}>
                    {pc("previous")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPilotOffset(pilotOffset + (pilotPagination?.limit || 50))} disabled={!pilotPagination?.has_next_page || pilotAttendanceLoading}>
                    {pc("next")}
                  </Button>
                </div>
              </div>
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
