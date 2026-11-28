import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Camera, ChevronDown, ChefHat, Loader2, RefreshCw, Truck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { ictToday, useAttendanceBoard } from "@/hooks/usePayrollBnAttendanceBoard";
import { usePayrollBnAttendanceAdmin } from "@/hooks/usePayrollBnAttendanceAdmin";
import {
  attendanceStatusLabel,
  attendanceStatusTone,
  type AttendanceBoardEmployee,
  type AttendanceStatusTone,
} from "@/lib/payroll-bn/attendance-board.ts";
import type { PayrollEmployee } from "@/lib/payroll-bn/types";
import { PhotoDialog, type AdminTask } from "./DeliveryAdmin";

export type TodayTarget = "gps" | "delivery";

const DELIVERY_GROUP = "Giao hàng";

const PILL: Record<AttendanceStatusTone, string> = {
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-sky-100 text-sky-800",
  neutral: "bg-muted text-muted-foreground",
  muted: "bg-muted text-muted-foreground",
};

const number = new Intl.NumberFormat("vi-VN");
const num = (value: number | string | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function clock(value: string | null | undefined): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

const rpc = (name: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>)(name, args);

interface TodayOverviewProps {
  employees: PayrollEmployee[];
  canEdit: boolean;
  onGo: (target: TodayTarget) => void;
}

/** One screen for the day: what needs action, the kitchen check-ins and the drivers. */
export function TodayOverview({ employees, canEdit, onGo }: TodayOverviewProps) {
  const today = ictToday();
  const board = useAttendanceBoard(today, { enabled: canEdit });
  const admin = usePayrollBnAttendanceAdmin({ enabled: canEdit });
  const tasksQuery = useQuery({
    // Same key as the Giao hàng detail, so both share one cache.
    queryKey: ["delivery-admin", "tasks", today],
    queryFn: async () => {
      const { data, error } = await rpc("list_delivery_tasks", { p_date: today });
      if (error) throw new Error(error.message || "Không tải được danh sách giao hàng.");
      return (Array.isArray(data) ? data : []) as AdminTask[];
    },
    refetchInterval: 60_000,
  });

  const nameByCode = useMemo(() => new Map(employees.map((employee) => [employee.code, employee.name])), [employees]);
  // Test accounts (TEST-…) are for training screenshots, not for the daily view.
  const boardRows = (board.data?.employees ?? []).filter((row) => !row.employeeCode.startsWith("TEST-"));
  const kitchen = boardRows.filter((row) => row.groupName !== DELIVERY_GROUP);
  const boardDrivers = new Map(boardRows.filter((row) => row.groupName === DELIVERY_GROUP).map((row) => [row.employeeCode, row]));
  const tasks = (tasksQuery.data ?? []).filter((task) => task.status !== "cancelled" && !task.employee_code?.startsWith("TEST-"));

  // Action list: the same rules as the GPS and delivery screens.
  const list = admin.attendanceQuery.data;
  const missingDays = (list?.days ?? []).filter(
    (day) => day.status === "missing_in" || (day.status === "missing_out" && day.work_date < today),
  ).length;
  const proxy = (list?.events ?? []).filter((event) => event.suspected_proxy).length;
  const devices = (admin.devicesQuery.data ?? []).filter((device) => device.status === "pending").length;
  const unassigned = tasks.filter((task) => !task.employee_code);
  const actions = [
    missingDays ? { key: "days", text: `${missingDays} ngày thiếu giờ vào/ra cần duyệt`, target: "gps" as const } : null,
    devices ? { key: "devices", text: `${devices} máy mới chờ duyệt`, target: "gps" as const } : null,
    proxy ? { key: "proxy", text: `${proxy} lượt nghi chấm hộ`, target: "gps" as const } : null,
    unassigned.length
      ? { key: "unassigned", text: `${unassigned.length} điểm giao chưa có tài xế (${number.format(unassigned.reduce((s, t) => s + num(t.quantity), 0))} bánh)`, target: "delivery" as const }
      : null,
  ].filter((item): item is { key: string; text: string; target: TodayTarget } => Boolean(item));

  // Drivers: everyone with a task today or a delivery check-in.
  const driverCodes = [
    ...new Set([
      ...boardDrivers.keys(),
      ...tasks.map((task) => task.employee_code).filter((code): code is string => Boolean(code)),
    ]),
  ];
  const drivers = driverCodes
    .map((code) => {
      const own = tasks.filter((task) => task.employee_code === code);
      return {
        code,
        name: nameByCode.get(code) ?? boardDrivers.get(code)?.name ?? own[0]?.driver_name ?? code,
        checkIn: boardDrivers.get(code)?.checkInAt ?? null,
        tasks: own,
      };
    })
    .sort((a, b) => b.tasks.length - a.tasks.length || a.name.localeCompare(b.name, "vi"));

  const kitchenIn = kitchen.filter((row) => row.checkInAt).length;
  const kitchenLate = kitchen.filter((row) => row.status === "late").length;
  const kitchenMissing = kitchen.filter((row) => row.status === "absent_overdue").length;
  const doneAll = tasks.filter((task) => task.status === "completed");

  const refreshing = board.isFetching || tasksQuery.isFetching;
  const refresh = () => {
    void board.refetch();
    void tasksQuery.refetch();
  };

  return (
    <div className="space-y-3" data-today-overview>
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground">
          {new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date())}
          {board.data?.generatedAt ? ` · cập nhật ${clock(board.data.generatedAt)}` : ""}
        </p>
        <button
          type="button"
          onClick={refresh}
          className="flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-semibold text-muted-foreground hover:text-foreground"
          aria-label="Làm mới"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> Làm mới
        </button>
      </div>

      {actions.length > 0 ? (
        <Card className="border-amber-300 bg-amber-50/60 p-1.5" data-today-actions>
          <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5" /> Cần xử lý
          </p>
          <ul>
            {actions.map((action) => (
              <li key={action.key}>
                <button
                  type="button"
                  onClick={() => onGo(action.target)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-amber-100/70"
                >
                  <span>{action.text}</span>
                  <span className="shrink-0 text-xs font-semibold text-amber-900">Xử lý →</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid items-start gap-3 lg:grid-cols-2">
      {canEdit ? (
        <Block
          icon={<ChefHat className="h-4 w-4" />}
          title="Bếp Q7"
          tone="bg-orange-100 text-orange-700"
          summary={
            board.isLoading
              ? "Đang tải…"
              : `Đã vào ${kitchenIn}/${kitchen.length}${kitchenLate ? ` · trễ ${kitchenLate}` : ""}${kitchenMissing ? ` · vắng ${kitchenMissing}` : ""}`
          }
          alert={kitchenMissing > 0}
          dataKey="kitchen"
        >
          {board.isLoading ? (
            <Spinner />
          ) : board.error ? (
            <p className="px-4 py-3 text-sm text-destructive">{board.error instanceof Error ? board.error.message : "Không tải được chấm công."}</p>
          ) : kitchen.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Chưa có nhân viên bật chấm công GPS.</p>
          ) : (
            <ul className="divide-y">
              {kitchen.map((row) => (
                <KitchenRow key={row.employeeCode} row={row} name={nameByCode.get(row.employeeCode) ?? row.name} />
              ))}
            </ul>
          )}
        </Block>
      ) : null}

      <Block
        icon={<Truck className="h-4 w-4" />}
        title="Giao hàng Tân Tạo"
        tone="bg-emerald-100 text-emerald-700"
        summary={
          tasksQuery.isLoading
            ? "Đang tải…"
            : tasks.length === 0
              ? "Hôm nay chưa có điểm giao"
              : `Đã giao ${doneAll.length}/${tasks.length} điểm · ${number.format(doneAll.reduce((s, t) => s + num(t.quantity), 0))}/${number.format(tasks.reduce((s, t) => s + num(t.quantity), 0))} bánh`
        }
        alert={unassigned.length > 0}
        dataKey="delivery"
      >
        {tasksQuery.isLoading ? (
          <Spinner />
        ) : tasksQuery.error ? (
          <p className="px-4 py-3 text-sm text-destructive">{tasksQuery.error instanceof Error ? tasksQuery.error.message : "Không tải được giao hàng."}</p>
        ) : drivers.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Chưa có tài xế nào có điểm giao hay chấm công hôm nay.</p>
        ) : (
          <ul className="divide-y">
            {drivers.map((driver) => (
              <DriverRow key={driver.code} name={driver.name} checkIn={driver.checkIn} tasks={driver.tasks} showCheckIn={canEdit} />
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => onGo("delivery")}
          className="block w-full border-t px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          Ngày khác, phân công điểm, công tháng →
        </button>
      </Block>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-6">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Đang tải" />
    </div>
  );
}

function Block({
  icon,
  title,
  tone,
  summary,
  alert,
  dataKey,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone: string;
  summary: string;
  alert?: boolean;
  dataKey: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden" data-today-block={dataKey}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", tone)}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className={cn("text-xs tabular-nums", alert ? "font-medium text-red-700" : "text-muted-foreground")}>{summary}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}

function KitchenRow({ row, name }: { row: AttendanceBoardEmployee; name: string }) {
  const tone = attendanceStatusTone(row.status);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5" data-today-kitchen={row.employeeCode}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs tabular-nums text-muted-foreground">
          {row.shiftStart ? `Ca ${row.shiftStart.slice(0, 5)} · ` : ""}
          {row.checkInAt ? `${clock(row.checkInAt)} → ${row.checkOutAt ? clock(row.checkOutAt) : "…"}` : "Chưa chấm"}
        </span>
      </span>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", PILL[tone])}>
        {attendanceStatusLabel(row.status, row.minutesLate)}
      </span>
    </li>
  );
}

function DriverRow({ name, checkIn, tasks, showCheckIn }: { name: string; checkIn: string | null; tasks: AdminTask[]; showCheckIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<AdminTask | null>(null);
  const done = tasks.filter((task) => task.status === "completed");
  const notes = tasks.filter((task) => task.driver_note).length;
  const progress = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
  return (
    <li data-today-driver={name}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            {notes ? <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">{notes} ghi chú</span> : null}
          </span>
          <span className="block text-xs tabular-nums text-muted-foreground">
            {showCheckIn ? (checkIn ? `Lấy hàng ${clock(checkIn)}` : "Chưa chấm công ở kho") : null}
            {showCheckIn && tasks.length ? " · " : ""}
            {tasks.length ? `${done.length}/${tasks.length} điểm` : showCheckIn ? "" : "Không có điểm"}
          </span>
          {tasks.length ? (
            <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
            </span>
          ) : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && tasks.length ? (
        <ul className="space-y-1 bg-muted/30 px-4 py-2">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2.5 py-1">
              <button
                type="button"
                onClick={() => task.photo_path && setPhoto(task)}
                disabled={!task.photo_path}
                className={cn(
                  "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                  task.photo_path ? "bg-[#f6e3c6] text-[#9a5b17]" : "bg-muted text-muted-foreground/50",
                )}
                aria-label={task.photo_path ? `Xem ảnh giao ${task.destination_name ?? ""}` : "Chưa có ảnh"}
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-0 flex-1 text-xs">
                <span className="block truncate text-sm">{task.destination_name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {task.status === "completed" ? `Giao ${clock(task.completed_at)}` : "Chưa giao"} · {number.format(num(task.quantity))} bánh
                </span>
                {task.driver_note ? <span className="mt-0.5 block line-clamp-2 break-words text-amber-800">Ghi chú: {task.driver_note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {photo ? <PhotoDialog task={photo} onClose={() => setPhoto(null)} /> : null}
    </li>
  );
}
