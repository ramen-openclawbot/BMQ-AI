import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock, ImageOff, Loader2, MapPinPlus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import type { PayrollEmployee } from "@/lib/payroll-bn/types.ts";

/* ------------------------------------------------------------------ data */

interface TaskItem { product_name?: string; quantity?: number | string }
interface AdminTask {
  id: string;
  delivery_date: string;
  destination_customer_id: string;
  destination_name: string | null;
  address: string | null;
  employee_code: string | null;
  driver_name: string | null;
  units: number | string | null;
  status: "pending" | "completed" | "cancelled";
  quantity: number | string | null;
  items: TaskItem[] | null;
  completed_at: string | null;
  accuracy_m: number | string | null;
  distance_m: number | string | null;
  location_attached: boolean | null;
  photo_path: string | null;
  changed_after_completion: boolean | null;
}
interface AdminAssignment {
  destination_customer_id: string;
  destination_name: string;
  area: string | null;
  address: string | null;
  employee_code: string | null;
  units: number | string;
  sort_order: number;
  note: string | null;
  assigned: boolean;
  has_location: boolean;
}
interface DriverSetting { employee_code: string; base_units_per_day: number | string; active: boolean }
interface UnitRow { employee_code: string; delivery_date: string; units: number | string }

const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const fmt = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const UNASSIGNED = "__none__";

function ictToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}
function clock(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function rpcError(error: { message?: string } | null): Error {
  const message = error?.message ?? "";
  if (message.includes("delivery_employee_not_in_catalogue")) return new Error("Người này chưa có trong Hồ sơ nhân viên nhóm Giao hàng.");
  if (message.includes("delivery_units_invalid")) return new Error("Công phải là bội của 0,25 (0; 0,25; 0,5…).");
  if (message.includes("insufficient_privilege")) return new Error("Bạn không có quyền thao tác này.");
  return new Error(message || "Có lỗi, vui lòng thử lại.");
}
// Supabase types are generated before these RPCs exist; keep the call untyped.
const rpc = (name: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>)(name, args);

/* ------------------------------------------------------------------ root */

type View = "today" | "assign" | "month";

export function DeliveryAdmin({ employees, canEdit }: { employees: PayrollEmployee[]; canEdit: boolean }) {
  const [view, setView] = useState<View>("today");
  const drivers = useMemo(
    () => employees.filter((employee) => employee.employmentType === "delivery" || employee.group === "Giao hàng"),
    [employees],
  );
  return (
    <div className="space-y-4" data-delivery-admin>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Giao hàng">
        {([
          ["today", "Hôm nay"],
          ["assign", "Phân công điểm"],
          ["month", "Công tháng"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={cn(
              "h-9 rounded-full px-4 text-sm font-semibold",
              view === key ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {drivers.length === 0 ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Chưa có tài xế trong Hồ sơ nhân viên. Thêm nhân viên nhóm <b>Giao hàng</b> để phân công điểm và tính công.
        </p>
      ) : null}
      {view === "today" ? <TodayView drivers={drivers} canEdit={canEdit} /> : null}
      {view === "assign" ? <AssignView drivers={drivers} canEdit={canEdit} /> : null}
      {view === "month" ? <MonthView drivers={drivers} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ today */

function TodayView({ drivers, canEdit }: { drivers: PayrollEmployee[]; canEdit: boolean }) {
  const today = ictToday();
  const [date, setDate] = useState(today);
  const [photoTask, setPhotoTask] = useState<AdminTask | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tasksQuery = useQuery({
    queryKey: ["delivery-admin", "tasks", date],
    queryFn: async () => {
      const { data, error } = await rpc("list_delivery_tasks", { p_date: date });
      if (error) throw rpcError(error);
      return (Array.isArray(data) ? data : []) as AdminTask[];
    },
    refetchInterval: date === today ? 60_000 : false,
  });
  const regenerate = useMutation({
    mutationFn: async () => {
      const { error } = await rpc("generate_delivery_tasks", { p_date: date });
      if (error) throw rpcError(error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["delivery-admin", "tasks", date] });
      toast({ title: "Đã tạo lại danh sách từ đơn đại lý" });
    },
    onError: (error) => toast({ title: "Không tạo lại được", description: error instanceof Error ? error.message : "", variant: "destructive" }),
  });

  const tasks = (tasksQuery.data ?? []).filter((task) => task.status !== "cancelled");
  const done = tasks.filter((task) => task.status === "completed");
  const unassigned = tasks.filter((task) => !task.employee_code);
  const nameByCode = new Map(drivers.map((driver) => [driver.code, driver.name]));
  const codes = [...new Set([...drivers.map((d) => d.code), ...tasks.map((t) => t.employee_code).filter((c): c is string => Boolean(c))])];
  const columns = codes
    .map((code) => ({ code, name: nameByCode.get(code) ?? tasks.find((t) => t.employee_code === code)?.driver_name ?? code, tasks: tasks.filter((t) => t.employee_code === code) }))
    .filter((column) => column.tasks.length > 0);
  if (unassigned.length) columns.push({ code: UNASSIGNED, name: "Chưa phân công", tasks: unassigned });
  const sum = (list: AdminTask[]) => list.reduce((total, task) => total + num(task.quantity), 0);
  const newLocations = done.filter((task) => task.location_attached).length;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setDate(addDays(date, -1))} aria-label="Ngày trước">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>{date === today ? "Hôm nay · " : ""}{dayLabel(date)}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setDate(addDays(date, 1))} disabled={date >= addDays(today, 1)} aria-label="Ngày sau">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </CardTitle>
          <CardDescription>Danh sách tự tạo lúc 00:05 từ đơn đại lý và cập nhật mỗi 10 phút.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {date !== today ? <Button variant="outline" size="sm" onClick={() => setDate(today)}>Về hôm nay</Button> : null}
          {canEdit ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
              {regenerate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Tạo lại từ đơn
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void tasksQuery.refetch()} disabled={tasksQuery.isFetching} aria-label="Làm mới">
            <RefreshCw className={cn("h-4 w-4", tasksQuery.isFetching && "animate-spin")} /> Làm mới
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {tasksQuery.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Đang tải" /></div>
        ) : tasksQuery.error ? (
          <p className="text-sm text-destructive">{tasksQuery.error instanceof Error ? tasksQuery.error.message : "Không tải được."}</p>
        ) : tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Chưa có điểm giao cho ngày này.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-delivery-summary>
              <Tile label="Điểm giao" value={fmt.format(tasks.length)} />
              <Tile label="Đã giao" value={`${done.length}/${tasks.length}`} />
              <Tile label="Bánh đã giao" value={fmt.format(sum(done))} hint={`trên ${fmt.format(sum(tasks))}`} />
              <Tile label="Vị trí mới gắn" value={fmt.format(newLocations)} />
              <Tile label="Chưa phân công" value={fmt.format(unassigned.length)} warn={unassigned.length > 0} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-delivery-columns>
              {columns.map((column) => {
                const columnDone = column.tasks.filter((task) => task.status === "completed");
                return (
                  <div key={column.code} className={cn("min-w-0 rounded-xl border p-3", column.code === UNASSIGNED && "border-amber-300 bg-amber-50/60")}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-semibold">{column.name}</p>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", columnDone.length === column.tasks.length ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground")}>
                        {columnDone.length}/{column.tasks.length}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{fmt.format(sum(columnDone))}/{fmt.format(sum(column.tasks))} bánh</p>
                    <ul className="mt-2 divide-y">
                      {column.tasks.map((task) => (
                        <li key={task.id} className="flex items-center gap-2.5 py-2">
                          <button
                            type="button"
                            onClick={() => task.photo_path && setPhotoTask(task)}
                            disabled={!task.photo_path}
                            className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                              task.photo_path ? "bg-[#f6e3c6] text-[#9a5b17] hover:ring-2 hover:ring-[#dc4f78]/40" : "bg-muted text-muted-foreground/60",
                            )}
                            aria-label={task.photo_path ? `Xem ảnh giao ${task.destination_name ?? ""}` : "Chưa có ảnh"}
                          >
                            {task.status === "completed" ? <Camera className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{task.destination_name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {task.status === "completed" ? `Giao ${clock(task.completed_at)}` : "Chưa giao"} · {fmt.format(num(task.quantity))} bánh
                              {task.location_attached ? " · vị trí mới" : ""}
                              {task.changed_after_completion ? " · đơn đổi sau khi giao" : ""}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">Bấm vào ảnh để xem ảnh giao, giờ và vị trí. Giai đoạn đầu chưa có cờ kiểm soát giờ hay vị trí.</p>
          </>
        )}
      </CardContent>
      {photoTask ? <PhotoDialog task={photoTask} onClose={() => setPhotoTask(null)} /> : null}
    </Card>
  );
}

function Tile({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-card px-3 py-2", warn && "border-amber-300 bg-amber-50")}>
      <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}{hint ? ` · ${hint}` : ""}</p>
    </div>
  );
}

function PhotoDialog({ task, onClose }: { task: AdminTask; onClose: () => void }) {
  const photo = useQuery({
    queryKey: ["delivery-admin", "photo", task.photo_path],
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("delivery-proofs").createSignedUrl(task.photo_path as string, 300);
      if (error) throw error;
      return data.signedUrl;
    },
    staleTime: 240_000,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Ảnh giao hàng" className="w-full max-w-md overflow-hidden rounded-2xl bg-background shadow-xl">
        <div className="relative flex h-72 items-center justify-center bg-muted">
          {photo.isLoading ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /> : photo.data ? (
            <img src={photo.data} alt={`Ảnh giao ${task.destination_name ?? ""}`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground"><ImageOff className="h-6 w-6" />Không mở được ảnh</div>
          )}
          <button type="button" onClick={onClose} className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 shadow" aria-label="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-1 p-4 text-sm">
          <p className="font-semibold">{task.destination_name}</p>
          <p className="text-muted-foreground">Tài xế {task.driver_name ?? task.employee_code ?? "—"} · giao lúc {clock(task.completed_at)} · {fmt.format(num(task.quantity))} bánh</p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            {task.location_attached ? <MapPinPlus className="h-4 w-4 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            {task.location_attached
              ? "Lần đầu giao, vị trí đã gắn cho điểm này"
              : task.distance_m !== null && task.distance_m !== undefined
                ? `Cách vị trí điểm ${fmt.format(Math.round(num(task.distance_m)))} m`
                : "Đã lưu vị trí"}
            {task.accuracy_m !== null && task.accuracy_m !== undefined ? ` · sai số ±${fmt.format(Math.round(num(task.accuracy_m)))} m` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ assignments */

function AssignView({ drivers, canEdit }: { drivers: PayrollEmployee[]; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const assignments = useQuery({
    queryKey: ["delivery-admin", "assignments"],
    queryFn: async () => {
      const { data, error } = await rpc("list_delivery_assignments");
      if (error) throw rpcError(error);
      return (Array.isArray(data) ? data : []) as AdminAssignment[];
    },
  });
  const settings = useQuery({
    queryKey: ["delivery-admin", "settings"],
    queryFn: async () => {
      const { data, error } = await (supabase.from as unknown as (t: string) => { select: (c: string) => Promise<{ data: unknown; error: { message?: string } | null }> })("delivery_driver_settings").select("employee_code, base_units_per_day, active");
      if (error) throw rpcError(error);
      return (Array.isArray(data) ? data : []) as DriverSetting[];
    },
  });
  const save = useMutation({
    mutationFn: async (input: { row: AdminAssignment; employeeCode: string | null; units: number }) => {
      const { error } = await rpc("upsert_delivery_assignment", {
        p_customer_id: input.row.destination_customer_id,
        p_employee_code: input.employeeCode,
        p_units: input.units,
        p_sort_order: input.row.sort_order ?? 0,
        p_note: input.row.note,
      });
      if (error) throw rpcError(error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["delivery-admin"] });
      toast({ title: "Đã lưu phân công", description: "Việc chưa giao của điểm này đã chuyển theo." });
    },
    onError: (error) => toast({ title: "Không lưu được", description: error instanceof Error ? error.message : "", variant: "destructive" }),
  });
  const saveBase = useMutation({
    mutationFn: async (input: { code: string; base: number }) => {
      const { error } = await rpc("upsert_delivery_driver_setting", { p_employee_code: input.code, p_base_units: input.base });
      if (error) throw rpcError(error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["delivery-admin", "settings"] });
      toast({ title: "Đã lưu công cơ bản", description: "Áp dụng từ hôm nay." });
    },
    onError: (error) => toast({ title: "Không lưu được", description: error instanceof Error ? error.message : "", variant: "destructive" }),
  });

  const parseUnits = (value: string): number | null => {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) && parsed >= 0 && Math.abs(parsed * 4 - Math.round(parsed * 4)) < 1e-9 ? parsed : null;
  };
  const settingByCode = new Map((settings.data ?? []).map((row) => [row.employee_code, row]));
  const rows = assignments.data ?? [];
  const missing = rows.filter((row) => !row.employee_code).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Công cơ bản mỗi ngày có giao</CardTitle>
          <CardDescription>Ngày tài xế giao ít nhất 1 điểm được cộng số công này, cộng thêm công phát sinh của từng điểm.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {drivers.map((driver) => {
              const current = settingByCode.get(driver.code);
              const key = `base:${driver.code}`;
              const value = drafts[key] ?? fmt.format(num(current?.base_units_per_day ?? 0.5));
              return (
                <label key={driver.code} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className="font-medium">{driver.name}</span>
                  <Input
                    className="h-8 w-16 text-right"
                    inputMode="decimal"
                    value={value}
                    disabled={!canEdit}
                    onChange={(event) => setDrafts((d) => ({ ...d, [key]: event.target.value }))}
                    onBlur={() => {
                      if (drafts[key] === undefined) return;
                      const parsed = parseUnits(drafts[key]);
                      setDrafts(({ [key]: _omit, ...rest }) => rest);
                      if (parsed === null) {
                        toast({ title: "Công phải là bội của 0,25", variant: "destructive" });
                        return;
                      }
                      if (parsed !== num(current?.base_units_per_day ?? 0.5) || !current) saveBase.mutate({ code: driver.code, base: parsed });
                    }}
                    aria-label={`Công cơ bản của ${driver.name}`}
                  />
                </label>
              );
            })}
            {drivers.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có tài xế.</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phân công điểm giao</CardTitle>
          <CardDescription>
            Các điểm có đơn trong 60 ngày qua. Đơn mới của điểm tự giao cho tài xế được chọn.
            {missing > 0 ? ` Còn ${missing} điểm chưa phân công.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assignments.isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : assignments.error ? (
            <p className="text-sm text-destructive">{assignments.error instanceof Error ? assignments.error.message : "Không tải được."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm" data-delivery-assignments>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Điểm giao</th>
                    <th className="px-2 py-2 font-medium">Tài xế</th>
                    <th className="px-2 py-2 text-right font-medium">Công phát sinh</th>
                    <th className="px-2 py-2 font-medium">Vị trí</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const key = `units:${row.destination_customer_id}`;
                    const unitsValue = drafts[key] ?? fmt.format(num(row.units));
                    return (
                      <tr key={row.destination_customer_id} className={cn("border-b last:border-0", !row.employee_code && "bg-amber-50/70")}>
                        <td className="px-2 py-2">
                          <p className="font-medium">{row.destination_name}</p>
                          {row.address ? <p className="max-w-[320px] truncate text-xs text-muted-foreground">{row.address}</p> : null}
                        </td>
                        <td className="px-2 py-2">
                          <Select
                            value={row.employee_code ?? UNASSIGNED}
                            disabled={!canEdit || save.isPending}
                            onValueChange={(value) => save.mutate({ row, employeeCode: value === UNASSIGNED ? null : value, units: num(row.units) })}
                          >
                            <SelectTrigger className="h-9 w-[180px]" aria-label={`Tài xế của ${row.destination_name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNASSIGNED}>— Chưa phân công —</SelectItem>
                              {drivers.map((driver) => (
                                <SelectItem key={driver.code} value={driver.code}>{driver.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Input
                            className="ml-auto h-9 w-20 text-right"
                            inputMode="decimal"
                            value={unitsValue}
                            disabled={!canEdit}
                            onChange={(event) => setDrafts((d) => ({ ...d, [key]: event.target.value }))}
                            onBlur={() => {
                              if (drafts[key] === undefined) return;
                              const parsed = parseUnits(drafts[key]);
                              setDrafts(({ [key]: _omit, ...rest }) => rest);
                              if (parsed === null) {
                                toast({ title: "Công phải là bội của 0,25", variant: "destructive" });
                                return;
                              }
                              if (parsed !== num(row.units)) save.mutate({ row, employeeCode: row.employee_code, units: parsed });
                            }}
                            aria-label={`Công phát sinh của ${row.destination_name}`}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", row.has_location ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>
                            {row.has_location ? "Đã có" : "Chưa có – tài xế sẽ lấy"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ month */

function MonthView({ drivers }: { drivers: PayrollEmployee[] }) {
  const today = ictToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  const shift = (delta: number) => {
    const date = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const units = useQuery({
    queryKey: ["delivery-admin", "units", from, to],
    queryFn: async () => {
      const { data, error } = await rpc("delivery_units_by_day", { p_from: from, p_to: to });
      if (error) throw rpcError(error);
      return (Array.isArray(data) ? data : []) as UnitRow[];
    },
  });
  const byKey = new Map((units.data ?? []).map((row) => [`${row.employee_code}|${row.delivery_date}`, num(row.units)]));
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);
  const codes = [...new Set([...drivers.map((d) => d.code), ...(units.data ?? []).map((row) => row.employee_code)])];
  const nameByCode = new Map(drivers.map((driver) => [driver.code, driver]));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(-1)} aria-label="Tháng trước"><ChevronLeft className="h-4 w-4" /></Button>
            <span>Công tháng {String(m).padStart(2, "0")}/{y}</span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(1)} disabled={month >= today.slice(0, 7)} aria-label="Tháng sau"><ChevronRight className="h-4 w-4" /></Button>
          </CardTitle>
          <CardDescription>Công mỗi ngày = công cơ bản nếu có giao + công phát sinh các điểm đã giao. Tổng này đi vào Bảng lương nhóm Giao hàng.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {units.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : units.error ? (
          <p className="text-sm text-destructive">{units.error instanceof Error ? units.error.message : "Không tải được."}</p>
        ) : codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có công giao hàng trong tháng này.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] table-fixed text-center text-xs tabular-nums" data-delivery-month>
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="w-36 px-1 py-2 text-left font-medium">Tài xế</th>
                  {days.map((day) => <th key={day} className="px-0.5 py-2 font-medium">{day}</th>)}
                  <th className="w-28 px-1 py-2 text-right font-medium">Tổng</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => {
                  const driver = nameByCode.get(code);
                  const noUnits = driver && (driver.deliveryUnitBase === null || driver.deliveryUnitBase === undefined || driver.deliveryUnitBase === 0);
                  const values = days.map((day) => byKey.get(`${code}|${month}-${String(day).padStart(2, "0")}`) ?? 0);
                  const total = values.reduce((a, b) => a + b, 0);
                  return (
                    <tr key={code} className="border-b last:border-0">
                      <td className="truncate px-1 py-2 text-left text-sm font-semibold">{driver?.name ?? code}</td>
                      {values.map((value, i) => (
                        <td key={i} className={cn("px-0.5 py-2", value === 0 && "text-muted-foreground/40")}>{value === 0 ? "·" : fmt.format(value)}</td>
                      ))}
                      <td className="whitespace-nowrap px-1 py-2 text-right text-sm font-bold">{noUnits ? "Lương cố định" : fmt.format(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
