import { useId, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Camera, ChevronDown, Crosshair, Loader2, MapPin, ShieldAlert, Smartphone, Users, History } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  useAttendanceDeviceChanges,
  usePayrollBnAttendanceAdmin,
  type PayrollAttendanceAdminDay,
  type PayrollAttendanceAdminEvent,
} from "@/hooks/usePayrollBnAttendanceAdmin";
import { getCurrentLocation, type GeolocationResult } from "@/lib/payslip-portal/geolocation";
import { attendanceMessage } from "../../../../supabase/functions/_shared/payroll-attendance.ts";
import type { PayrollEmployee } from "@/lib/payroll-bn/types";

const SELFIE_BUCKET = "payroll-attendance-selfies";

const dateTime = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

function formatDate(value: string): string {
  const [y, m, d] = value.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Không thực hiện được. Vui lòng thử lại.";
}

/**
 * Long lists stay collapsed behind a one-line summary. Opening reveals the list
 * inside a fixed-height region that scrolls vertically on its own.
 */
function CollapsibleSection({
  icon,
  title,
  summary,
  badge,
  tone = "default",
  defaultOpen = false,
  scroll = true,
  dataAttr,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  badge?: ReactNode;
  tone?: "default" | "warn";
  defaultOpen?: boolean;
  scroll?: boolean;
  dataAttr?: Record<string, string>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <Card className={tone === "warn" ? "border-amber-300 bg-amber-50/40" : undefined} {...dataAttr}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-base font-semibold leading-tight">
            {title}
            {badge}
          </span>
          {summary ? <span className="mt-0.5 block text-sm text-muted-foreground">{summary}</span> : null}
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div id={panelId} className="border-t">
          <div className={scroll ? "max-h-80 space-y-2 overflow-y-auto overscroll-contain p-4" : "space-y-2 p-4"}>{children}</div>
        </div>
      ) : null}
    </Card>
  );
}

export interface GpsAttendanceAdminProps {
  /** Employees of the selected period, used for names and the per-person switch. */
  employees: PayrollEmployee[];
}

/**
 * Bếp Q7 GPS attendance administration: site coordinates, per-person rollout,
 * device approval, incomplete-day approval and the evidence (selfie, distance,
 * suspected proxy). Every write goes through the audited RPCs.
 */
export function GpsAttendanceAdmin({ employees }: GpsAttendanceAdminProps) {
  const admin = usePayrollBnAttendanceAdmin();
  const changesQuery = useAttendanceDeviceChanges();
  const { toast } = useToast();
  const list = admin.attendanceQuery.data;
  const devices = admin.devicesQuery.data ?? [];
  const site = list?.site ?? null;

  const names = useMemo(() => {
    const map = new Map<string, string>();
    employees.forEach((employee) => map.set(employee.code, employee.name));
    return map;
  }, [employees]);
  const nameOf = (code: string) => names.get(code) ?? code;

  const consents = useMemo(() => {
    const map = new Map<string, { accepted: boolean; withdrawn: boolean }>();
    (list?.consents ?? []).forEach((row) =>
      map.set(row.employee_code, { accepted: !row.withdrawn_at, withdrawn: Boolean(row.withdrawn_at) }),
    );
    return map;
  }, [list?.consents]);

  const gates = useMemo(() => {
    const map = new Map<string, boolean>();
    (list?.gates ?? []).forEach((gate) => map.set(gate.employee_code, gate.enabled));
    return map;
  }, [list?.gates]);

  // Today's shift is still running: a check-in without a check-out is not an
  // issue until the Vietnam day is over (the staff portal applies the same rule).
  const todayVn = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const pendingDays = (list?.days ?? []).filter(
    (day) =>
      day.status === "missing_in" ||
      (day.status === "missing_out" && day.work_date < todayVn),
  );
  const flagged = (list?.events ?? []).filter((event) => event.suspected_proxy);
  const recent = (list?.events ?? []).slice(0, 40);
  const pendingDevices = devices.filter((device) => device.status === "pending");
  const activeDevices = devices.filter((device) => device.status === "active");

  const [approveDay, setApproveDay] = useState<PayrollAttendanceAdminDay | null>(null);
  const [selfie, setSelfie] = useState<{ url: string; event: PayrollAttendanceAdminEvent } | null>(null);

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast({ title: success });
    } catch (error) {
      toast({ title: "Không thực hiện được", description: errorText(error), variant: "destructive" });
    }
  };

  const openSelfie = async (event: PayrollAttendanceAdminEvent) => {
    if (!event.selfie_path) return;
    const { data, error } = await supabase.storage.from(SELFIE_BUCKET).createSignedUrl(event.selfie_path, 300);
    if (error || !data?.signedUrl) {
      toast({
        title: "Không mở được ảnh",
        description: "Ảnh có thể đã được xoá theo chính sách lưu trữ 90 ngày.",
        variant: "destructive",
      });
      return;
    }
    setSelfie({ url: data.signedUrl, event });
  };

  if (admin.attendanceQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Đang tải chấm công GPS" />
        </CardContent>
      </Card>
    );
  }

  if (admin.attendanceQuery.error) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">{errorText(admin.attendanceQuery.error)}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <SiteCard
        latitude={site?.latitude ?? null}
        longitude={site?.longitude ?? null}
        radiusM={site?.radius_m ?? 50}
        saving={admin.setKitchenSite.isPending}
        onSave={(value) => run(() => admin.setKitchenSite.mutateAsync(value), "Đã lưu vị trí Bếp Q7")}
      />

      <DeviceChangesCard
        loading={changesQuery.isLoading}
        error={changesQuery.error ? errorText(changesQuery.error) : null}
        changes={changesQuery.data ?? []}
      />

      {(pendingDays.length > 0 || flagged.length > 0 || pendingDevices.length > 0) && (
        <CollapsibleSection
          tone="warn"
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
          title="Cần xử lý"
          badge={<Badge variant="secondary" className="font-normal">{pendingDays.length + flagged.length + pendingDevices.length} việc</Badge>}
          summary={[
            pendingDevices.length ? `${pendingDevices.length} máy cần duyệt` : null,
            flagged.length ? `${flagged.length} lượt nghi chấm hộ` : null,
            pendingDays.length ? `${pendingDays.length} ngày thiếu giờ` : null,
          ].filter(Boolean).join(" · ")}
          defaultOpen={pendingDays.length + flagged.length + pendingDevices.length <= 3}
        >
          <div className="space-y-5">
            {pendingDevices.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Máy cần anh duyệt</p>
                {pendingDevices.map((device) => (
                  <div key={device.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                    <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-[10rem] flex-1">
                      <p className="font-medium">{nameOf(device.employee_code)}</p>
                      <p className="text-xs text-muted-foreground">
                        {device.user_agent_family ?? "Thiết bị"} · lần đầu {formatDateTime(device.first_seen_at)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => run(() => admin.approveDevice.mutateAsync({ deviceId: device.id }), "Đã duyệt máy")}
                      >
                        Duyệt máy
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => run(() => admin.revokeDevice.mutateAsync({ deviceId: device.id }), "Đã từ chối máy")}
                      >
                        Từ chối
                      </Button>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Máy đăng nhập bằng OTP Zalo tự được dùng; chỉ máy anh đã gỡ, máy đang là máy của nhân viên khác hoặc máy chưa đăng nhập lại
                  mới cần duyệt. Duyệt máy sẽ thay máy cũ của nhân viên đó.
                </p>
              </div>
            )}

            {flagged.length > 0 && (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                  <ShieldAlert className="h-4 w-4" /> Nghi chấm công hộ
                </p>
                {flagged.map((event) => (
                  <EventRow key={event.id} event={event} name={nameOf(event.employee_code)} onSelfie={openSelfie} />
                ))}
              </div>
            )}

            {pendingDays.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Ngày thiếu giờ vào/ra (chưa tính công)</p>
                {pendingDays.map((day) => (
                  <div
                    key={`${day.employee_code}-${day.work_date}`}
                    className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{nameOf(day.employee_code)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(day.work_date)} · {day.status === "missing_in" ? "Thiếu giờ vào" : "Thiếu giờ ra"}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setApproveDay(day)}>
                      Duyệt ngày công
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      <CollapsibleSection
        icon={<Users className="h-4 w-4" />}
        title="Nhân viên được chấm công GPS"
        summary={`Đang bật ${employees.filter((e) => gates.get(e.code) === true).length}/${employees.length} người · máy vừa đăng nhập OTP Zalo được dùng ngay`}
      >
        <div className="-mx-4 -my-4 divide-y">
          {employees.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Chưa có danh sách nhân viên của kỳ này.</p>
          ) : (
            employees.map((employee) => {
              const enabled = gates.get(employee.code) === true;
              const device = activeDevices.find((item) => item.employee_code === employee.code);
              return (
                <div key={employee.code} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{employee.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {employee.code} · {device ? `Máy: ${device.user_agent_family ?? "đã gắn"}` : "Chưa gắn máy"} ·{" "}
                      {consents.get(employee.code)?.accepted
                        ? "Đã đồng ý thoả thuận"
                        : consents.get(employee.code)?.withdrawn
                          ? "Đã rút lại đồng ý"
                          : "Chưa đồng ý thoả thuận"}
                    </p>
                  </div>
                  {device ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => run(() => admin.revokeDevice.mutateAsync({ deviceId: device.id }), "Đã gỡ máy")}
                    >
                      Gỡ máy
                    </Button>
                  ) : null}
                  <Switch
                    checked={enabled}
                    disabled={admin.setGate.isPending || !site?.id}
                    aria-label={`Chấm công GPS cho ${employee.name}`}
                    onCheckedChange={(checked) =>
                      run(
                        () =>
                          admin.setGate.mutateAsync({
                            employeeCode: employee.code,
                            enabled: checked,
                            geofenceLocationId: site?.id ?? null,
                          }),
                        checked ? `Đã bật chấm công cho ${employee.name}` : `Đã tắt chấm công cho ${employee.name}`,
                      )
                    }
                  />
                </div>
              );
            })
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        icon={<History className="h-4 w-4" />}
        title="Lượt chấm gần đây"
        summary={`${recent.length} lượt gần nhất${list ? ` · ${formatDate(list.from)} – ${formatDate(list.to)}` : ""} · gồm cả lượt bị từ chối`}
        badge={
          recent.some((event) => event.decision !== "accepted") ? (
            <Badge variant="destructive" className="font-normal">
              {recent.filter((event) => event.decision !== "accepted").length} bị từ chối
            </Badge>
          ) : null
        }
      >
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có lượt chấm công nào.</p>
        ) : (
          recent.map((event) => (
            <EventRow key={event.id} event={event} name={nameOf(event.employee_code)} onSelfie={openSelfie} />
          ))
        )}
      </CollapsibleSection>

      <ApproveDayDialog
        day={approveDay}
        name={approveDay ? nameOf(approveDay.employee_code) : ""}
        saving={admin.approveDay.isPending}
        onClose={() => setApproveDay(null)}
        onConfirm={async (reason) => {
          if (!approveDay) return;
          await run(
            () =>
              admin.approveDay.mutateAsync({
                employeeCode: approveDay.employee_code,
                workDate: approveDay.work_date,
                reason,
              }),
            "Đã duyệt ngày công",
          );
          setApproveDay(null);
        }}
      />

      <Dialog open={selfie !== null} onOpenChange={(open) => !open && setSelfie(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{selfie ? nameOf(selfie.event.employee_code) : ""}</DialogTitle>
            <DialogDescription>
              {selfie ? `${selfie.event.event_kind === "in" ? "Chấm vào" : "Chấm ra"} · ${formatDateTime(selfie.event.server_received_at)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {selfie ? <img src={selfie.url} alt="Ảnh chấm công" className="w-full rounded-lg object-cover" /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EventRow({
  event,
  name,
  onSelfie,
}: {
  event: PayrollAttendanceAdminEvent;
  name: string;
  onSelfie: (event: PayrollAttendanceAdminEvent) => void;
}) {
  const ok = event.decision === "accepted";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {name}
          <Badge variant={ok ? "secondary" : "destructive"} className="font-normal">
            {event.event_kind === "in" ? "Vào" : "Ra"} · {ok ? "Hợp lệ" : "Từ chối"}
          </Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(event.server_received_at)}
          {event.distance_m !== null ? ` · cách ${Math.round(event.distance_m)} m` : ""}
          {event.accuracy_m !== null ? ` · sai số ${Math.round(event.accuracy_m)} m` : ""}
        </p>
        {!ok ? <p className="mt-0.5 text-xs text-destructive">{attendanceMessage(event.reject_reason)}</p> : null}
      </div>
      {event.selfie_path ? (
        <Button size="sm" variant="ghost" onClick={() => onSelfie(event)}>
          <Camera className="mr-1.5 h-4 w-4" /> Ảnh
        </Button>
      ) : null}
    </div>
  );
}

function SiteCard({
  latitude,
  longitude,
  radiusM,
  saving,
  onSave,
}: {
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  saving: boolean;
  onSave: (value: { latitude: number; longitude: number; radiusM: number }) => Promise<void>;
}) {
  const [lat, setLat] = useState(latitude?.toString() ?? "");
  const [lng, setLng] = useState(longitude?.toString() ?? "");
  const [radius, setRadius] = useState(String(radiusM));
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const parsed = {
    latitude: Number(lat.replace(",", ".")),
    longitude: Number(lng.replace(",", ".")),
    radiusM: Math.round(Number(radius)),
  };
  const valid =
    lat.trim() !== "" &&
    lng.trim() !== "" &&
    Number.isFinite(parsed.latitude) &&
    Number.isFinite(parsed.longitude) &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180 &&
    parsed.radiusM >= 10 &&
    parsed.radiusM <= 500;
  const configured = latitude !== null && longitude !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" /> Vị trí chấm công Bếp Q7
        </CardTitle>
        <CardDescription>
          {configured
            ? `Đang dùng ${latitude}, ${longitude} · bán kính ${radiusM} m.`
            : "Chưa ghim vị trí: chưa ai chấm công được cho đến khi lưu toạ độ."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="q7-lat">Vĩ độ</Label>
            <Input id="q7-lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="10.7…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q7-lng">Kinh độ</Label>
            <Input id="q7-lng" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="106.7…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q7-radius">Bán kính (m)</Label>
            <Input id="q7-radius" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />
          </div>
        </div>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={locating}
            onClick={async () => {
              setLocating(true);
              setHint(null);
              const result = await getCurrentLocation();
              setLocating(false);
              if (result.ok === false) {
                const failure = result as Extract<GeolocationResult, { ok: false }>;
                setHint(`${failure.message} ${failure.guidance}`);
                return;
              }
              setLat(result.point.latitude.toFixed(6));
              setLng(result.point.longitude.toFixed(6));
              setHint(`Đã lấy vị trí máy này (sai số khoảng ${Math.round(result.point.accuracyM)} m). Chỉ lưu khi đang đứng tại bếp.`);
            }}
          >
            {locating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Crosshair className="mr-2 h-4 w-4" />}
            Lấy vị trí hiện tại
          </Button>
          <Button type="button" disabled={!valid || saving} onClick={() => void onSave(parsed)}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Lưu vị trí
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ApproveDayDialog({
  day,
  name,
  saving,
  onClose,
  onConfirm,
}: {
  day: PayrollAttendanceAdminDay | null;
  name: string;
  saving: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duyệt ngày công</DialogTitle>
          <DialogDescription>
            {day ? `${name} · ${formatDate(day.work_date)} · ${day.status === "missing_in" ? "thiếu giờ vào" : "thiếu giờ ra"}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="approve-reason">Lý do</Label>
          <Textarea
            id="approve-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: quên chấm ra, quản lý xác nhận có làm đủ ca"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            disabled={saving || reason.trim().length < 3}
            onClick={async () => {
              await onConfirm(reason.trim());
              setReason("");
            }}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Duyệt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const BROWSER_LABEL: Record<string, string> = { ios: "iPhone", android: "Android" };

/** Switches per person above this in 14 days are flagged as unusual. */
const FREQUENT_SWITCH_THRESHOLD = 3;

/** Read-only review of automatic device switches after a Zalo OTP login (last 14 days), grouped by employee. */
function DeviceChangesCard({
  loading,
  error,
  changes,
}: {
  loading: boolean;
  error: string | null;
  changes: { id: string; employee_code: string; employee_name: string; from_device_hash: string | null; user_agent_family: string | null; changed_at: string }[];
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { code: string; name: string; family: string | null; count: number; last: string; first: string }>();
    for (const change of changes) {
      const current = map.get(change.employee_code);
      if (!current) {
        map.set(change.employee_code, {
          code: change.employee_code,
          name: change.employee_name || change.employee_code,
          family: change.user_agent_family,
          count: 1,
          last: change.changed_at,
          first: change.changed_at,
        });
      } else {
        current.count += 1;
        if (change.changed_at > current.last) current.last = change.changed_at;
        if (change.changed_at < current.first) current.first = change.changed_at;
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
  }, [changes]);
  const frequent = groups.filter((group) => group.count >= FREQUENT_SWITCH_THRESHOLD);

  return (
    <CollapsibleSection
      dataAttr={{ "data-device-changes": "" }}
      icon={<ArrowRightLeft className="h-4 w-4" />}
      title="Đổi máy gần đây"
      badge={
        frequent.length > 0 ? (
          <Badge variant="destructive" className="font-normal">
            {frequent.length} người đổi liên tục
          </Badge>
        ) : null
      }
      summary={
        loading
          ? "Đang tải…"
          : error
            ? error
            : changes.length === 0
              ? "14 ngày qua chưa có ai đổi máy."
              : `${changes.length} lần · ${groups.length} người · 14 ngày qua`
      }
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">14 ngày qua chưa có ai đổi máy.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Nhân viên đăng nhập OTP Zalo trên máy khác thì tự chuyển sang máy đó. Mỗi lần chấm vẫn có ảnh và vị trí. Đổi từ {FREQUENT_SWITCH_THRESHOLD} lần trở lên là bất thường: thường do mở bằng trình duyệt trong Zalo hoặc chế độ riêng tư, nên xem lại ảnh chấm.
          </p>
          <ul className="divide-y rounded-lg border bg-background">
            {groups.map((group) => {
              const unusual = group.count >= FREQUENT_SWITCH_THRESHOLD;
              return (
                <li key={group.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 text-sm" data-device-change={group.code}>
                  <span className="min-w-0">
                    <span className="block font-medium">{group.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {group.family ? BROWSER_LABEL[group.family] ?? group.family : "Máy"} · gần nhất {formatDateTime(group.last)}
                    </span>
                  </span>
                  <Badge variant={unusual ? "destructive" : "secondary"} className="font-normal">
                    {group.count} lần{unusual ? " · bất thường" : ""}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </CollapsibleSection>
  );
}

export default GpsAttendanceAdmin;
