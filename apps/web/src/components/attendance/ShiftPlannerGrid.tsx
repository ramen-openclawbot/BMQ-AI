import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { addDays, startOfWeek, eachDayOfInterval, format, parseISO } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight, Copy, AlertTriangle, CalendarRange, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import BulkAssignDialog from "./BulkAssignDialog";

interface ShiftOption {
  id: string;
  shift_code: string;
  shift_name: string;
  start_time: string;
  end_time: string;
}

interface AssignmentRow {
  id: string;
  employee_code: string;
  employee_name: string | null;
  shift_id: string;
  work_date: string;
  department: string | null;
  status: "scheduled" | "cancelled" | "swapped";
}

interface EmployeeRosterRow {
  employee_code: string;
  employee_name: string | null;
  department: string | null;
  assignments: Record<string, AssignmentRow | null>;
}

const UNASSIGNED = "__unassigned__";

export default function ShiftPlannerGrid() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isVi = language === "vi";
  const canEdit = canEditModule("attendance");
  const dateLocale = isVi ? vi : enUS;

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [copySourceMonday, setCopySourceMonday] = useState<string>(() =>
    format(startOfWeek(addDays(new Date(), -7), { weekStartsOn: 1 }), "yyyy-MM-dd"),
  );

  const weekDays = useMemo(
    () =>
      eachDayOfInterval({
        start: weekStart,
        end: addDays(weekStart, 6),
      }),
    [weekStart],
  );

  const weekFromIso = format(weekStart, "yyyy-MM-dd");
  const weekToIso = format(addDays(weekStart, 6), "yyyy-MM-dd");

  const copy = useMemo(
    () => ({
      title: isVi ? "Xếp ca theo tuần" : "Weekly shift planner",
      description: isVi
        ? "Lập lịch ca cho từng nhân viên, copy tuần trước và phát hiện trùng ca."
        : "Assign shifts per employee by day, copy a previous week, and detect conflicts.",
      prevWeek: isVi ? "Tuần trước" : "Prev week",
      nextWeek: isVi ? "Tuần sau" : "Next week",
      thisWeek: isVi ? "Tuần này" : "This week",
      employeeFilter: isVi ? "Lọc nhân viên" : "Filter employee",
      departmentFilter: isVi ? "Lọc bộ phận" : "Filter department",
      employee: isVi ? "Nhân viên" : "Employee",
      department: isVi ? "Bộ phận" : "Department",
      unassigned: isVi ? "Chưa xếp" : "Unassigned",
      copyWeek: isVi ? "Sao chép tuần" : "Copy week",
      sourceWeek: isVi ? "Tuần nguồn" : "Source week",
      bulkUpload: isVi ? "Upload CSV" : "Upload CSV",
      noData: isVi ? "Chưa có nhân viên trong tuần" : "No employees this week",
      conflictTitle: isVi ? "Xung đột ca" : "Shift conflict",
      copySuccess: isVi ? "Đã sao chép lịch" : "Roster copied",
      copyError: isVi ? "Không thể sao chép" : "Unable to copy roster",
      savedOk: isVi ? "Đã lưu ca" : "Shift saved",
      savedErr: isVi ? "Không thể lưu ca" : "Unable to save shift",
      lockedPeriod: isVi
        ? "Ngày này nằm trong kỳ đã khóa, thao tác bị chặn."
        : "This date is in a locked period, operations are blocked.",
    }),
    [isVi],
  );

  const { data: shifts = [] } = useQuery({
    queryKey: ["attendance-shifts-active"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_shifts")
        .select("id, shift_code, shift_name, start_time, end_time")
        .eq("is_active", true)
        .order("start_time", { ascending: true });
      if (error) throw error;
      return (data || []) as ShiftOption[];
    },
  });

  const { data: lockedDates = [] } = useQuery({
    queryKey: ["attendance-locked-dates", weekFromIso, weekToIso],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_periods")
        .select("date_from, date_to, status")
        .or(`and(date_from.lte.${weekToIso},date_to.gte.${weekFromIso})`);
      if (error) throw error;
      const locked = new Set<string>();
      (data || []).forEach((period: any) => {
        if (period.status === "open") return;
        const start = parseISO(period.date_from);
        const end = parseISO(period.date_to);
        eachDayOfInterval({ start, end }).forEach((day) => {
          const iso = format(day, "yyyy-MM-dd");
          if (iso >= weekFromIso && iso <= weekToIso) locked.add(iso);
        });
      });
      return Array.from(locked);
    },
  });

  const lockedSet = useMemo(() => new Set(lockedDates), [lockedDates]);

  const { data: assignments = [], isLoading: assignmentsLoading } = useQuery({
    queryKey: ["attendance-roster", weekFromIso, weekToIso],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_shift_assignments")
        .select("id, employee_code, employee_name, shift_id, work_date, department, status")
        .gte("work_date", weekFromIso)
        .lte("work_date", weekToIso)
        .order("employee_code", { ascending: true });
      if (error) throw error;
      return (data || []) as AssignmentRow[];
    },
  });

  const roster = useMemo<EmployeeRosterRow[]>(() => {
    const empKey = employeeFilter.trim().toLowerCase();
    const deptKey = departmentFilter.trim().toLowerCase();
    const map = new Map<string, EmployeeRosterRow>();

    assignments.forEach((row) => {
      if (empKey) {
        const hay = `${row.employee_code} ${row.employee_name || ""}`.toLowerCase();
        if (!hay.includes(empKey)) return;
      }
      if (deptKey) {
        const deptHay = (row.department || "").toLowerCase();
        if (!deptHay.includes(deptKey)) return;
      }
      const entry = map.get(row.employee_code) || {
        employee_code: row.employee_code,
        employee_name: row.employee_name,
        department: row.department,
        assignments: {} as Record<string, AssignmentRow | null>,
      };
      entry.employee_name = entry.employee_name || row.employee_name;
      entry.department = entry.department || row.department;
      entry.assignments[row.work_date] = row;
      map.set(row.employee_code, entry);
    });

    return Array.from(map.values()).sort((a, b) => a.employee_code.localeCompare(b.employee_code));
  }, [assignments, employeeFilter, departmentFilter]);

  const upsertAssignmentMutation = useMutation({
    mutationFn: async (payload: { employee_code: string; employee_name: string | null; work_date: string; shift_id: string | null; department: string | null }) => {
      if (!canEdit) throw new Error(copy.savedErr);
      if (lockedSet.has(payload.work_date)) throw new Error(copy.lockedPeriod);

      if (payload.shift_id === null) {
        const { error } = await (supabase as any)
          .from("attendance_shift_assignments")
          .delete()
          .eq("employee_code", payload.employee_code)
          .eq("work_date", payload.work_date);
        if (error) throw error;
        return;
      }

      const { error } = await (supabase as any)
        .from("attendance_shift_assignments")
        .upsert(
          {
            employee_code: payload.employee_code,
            employee_name: payload.employee_name,
            work_date: payload.work_date,
            shift_id: payload.shift_id,
            department: payload.department,
            status: "scheduled",
          },
          { onConflict: "employee_code,work_date" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: copy.savedOk });
      queryClient.invalidateQueries({ queryKey: ["attendance-roster", weekFromIso, weekToIso] });
    },
    onError: (err: any) => {
      toast({ title: copy.savedErr, description: err?.message, variant: "destructive" });
    },
  });

  const copyWeekMutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error(copy.copyError);
      if (!copySourceMonday) throw new Error(copy.copyError);
      const { data, error } = await (supabase as any).rpc("attendance_copy_week_roster", {
        _source_from: copySourceMonday,
        _target_from: weekFromIso,
        _employee_codes: null,
      });
      if (error) throw error;
      return (data?.[0] || { inserted_count: 0, skipped_count: 0 }) as {
        inserted_count: number;
        skipped_count: number;
      };
    },
    onSuccess: (result) => {
      toast({
        title: copy.copySuccess,
        description: isVi
          ? `Đã tạo ${result.inserted_count} dòng, bỏ qua ${result.skipped_count} do kỳ khóa.`
          : `Inserted ${result.inserted_count}, skipped ${result.skipped_count} due to locked period.`,
      });
      queryClient.invalidateQueries({ queryKey: ["attendance-roster", weekFromIso, weekToIso] });
    },
    onError: (err: any) => {
      toast({ title: copy.copyError, description: err?.message, variant: "destructive" });
    },
  });

  const shiftsById = useMemo(() => {
    const map = new Map<string, ShiftOption>();
    shifts.forEach((s) => map.set(s.id, s));
    return map;
  }, [shifts]);

  // Conflict detection: an employee can technically have one row per work_date (UNIQUE),
  // but day-granularity conflicts happen when two consecutive days' shifts overlap
  // (e.g., night shift ends at 06:00 next day but next day has a morning shift 06:00).
  const conflictDays = useMemo(() => {
    const flags = new Map<string, Set<string>>(); // employee_code -> iso date set
    roster.forEach((emp) => {
      const days = Object.keys(emp.assignments).sort();
      for (let i = 0; i < days.length - 1; i += 1) {
        const a = emp.assignments[days[i]];
        const b = emp.assignments[days[i + 1]];
        if (!a || !b) continue;
        const shiftA = shiftsById.get(a.shift_id);
        const shiftB = shiftsById.get(b.shift_id);
        if (!shiftA || !shiftB) continue;
        // Night shift crosses midnight if end_time < start_time
        const aEndsNextDay = shiftA.end_time <= shiftA.start_time;
        if (aEndsNextDay && shiftB.start_time <= shiftA.end_time) {
          if (!flags.has(emp.employee_code)) flags.set(emp.employee_code, new Set());
          flags.get(emp.employee_code)!.add(days[i + 1]);
        }
      }
    });
    return flags;
  }, [roster, shiftsById]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarRange className="h-5 w-5" />
                {copy.title}
              </CardTitle>
              <CardDescription>{copy.description}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                {copy.prevWeek}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
              >
                {copy.thisWeek}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>
                {copy.nextWeek}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto_auto]">
            <Input
              placeholder={copy.employeeFilter}
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
            />
            <Input
              placeholder={copy.departmentFilter}
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
            />
            <Input
              type="date"
              value={copySourceMonday}
              onChange={(e) => setCopySourceMonday(e.target.value)}
              disabled={!canEdit}
              title={copy.sourceWeek}
            />
            <Button
              variant="outline"
              onClick={() => copyWeekMutation.mutate()}
              disabled={!canEdit || copyWeekMutation.isPending}
            >
              {copyWeekMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              {copy.copyWeek}
            </Button>
            <Button onClick={() => setBulkOpen(true)} disabled={!canEdit}>
              <Users className="h-4 w-4 mr-1" />
              {copy.bulkUpload}
            </Button>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">{copy.employee}</TableHead>
                  <TableHead className="min-w-[120px]">{copy.department}</TableHead>
                  {weekDays.map((day) => {
                    const iso = format(day, "yyyy-MM-dd");
                    const isLocked = lockedSet.has(iso);
                    return (
                      <TableHead key={iso} className="min-w-[150px]">
                        <div className="flex flex-col">
                          <span className="text-xs text-muted-foreground">
                            {format(day, "EEE", { locale: dateLocale })}
                          </span>
                          <span className="font-medium">{format(day, "dd/MM")}</span>
                          {isLocked ? (
                            <Badge variant="secondary" className="w-fit mt-1 text-[10px]">
                              {isVi ? "Khóa" : "Locked"}
                            </Badge>
                          ) : null}
                        </div>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignmentsLoading ? (
                  <TableRow>
                    <TableCell colSpan={2 + weekDays.length} className="text-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin inline-block" />
                    </TableCell>
                  </TableRow>
                ) : roster.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2 + weekDays.length} className="text-center text-muted-foreground py-6">
                      {copy.noData}
                    </TableCell>
                  </TableRow>
                ) : (
                  roster.map((emp) => {
                    const empConflicts = conflictDays.get(emp.employee_code);
                    return (
                      <TableRow key={emp.employee_code}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{emp.employee_code}</span>
                            <span className="text-xs text-muted-foreground">{emp.employee_name || "-"}</span>
                          </div>
                        </TableCell>
                        <TableCell>{emp.department || "-"}</TableCell>
                        {weekDays.map((day) => {
                          const iso = format(day, "yyyy-MM-dd");
                          const current = emp.assignments[iso] || null;
                          const isLocked = lockedSet.has(iso);
                          const hasConflict = empConflicts?.has(iso);
                          return (
                            <TableCell key={iso} className="align-top">
                              <div className="flex flex-col gap-1">
                                <Select
                                  value={current?.shift_id || UNASSIGNED}
                                  onValueChange={(value) =>
                                    upsertAssignmentMutation.mutate({
                                      employee_code: emp.employee_code,
                                      employee_name: emp.employee_name,
                                      work_date: iso,
                                      shift_id: value === UNASSIGNED ? null : value,
                                      department: emp.department,
                                    })
                                  }
                                  disabled={!canEdit || isLocked}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder={copy.unassigned} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={UNASSIGNED}>{copy.unassigned}</SelectItem>
                                    {shifts.map((s) => (
                                      <SelectItem key={s.id} value={s.id}>
                                        {s.shift_name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                {hasConflict ? (
                                  <Badge variant="destructive" className="text-[10px] gap-1 w-fit">
                                    <AlertTriangle className="h-3 w-3" />
                                    {copy.conflictTitle}
                                  </Badge>
                                ) : null}
                              </div>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <BulkAssignDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        shifts={shifts}
        onCompleted={() =>
          queryClient.invalidateQueries({ queryKey: ["attendance-roster", weekFromIso, weekToIso] })
        }
      />
    </div>
  );
}
