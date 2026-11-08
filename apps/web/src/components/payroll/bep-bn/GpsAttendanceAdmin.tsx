import { useMemo, useState } from "react";
import { AlertTriangle, Camera, Crosshair, Loader2, MapPin, ShieldAlert, Smartphone } from "lucide-react";
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

  const gates = useMemo(() => {
    const map = new Map<string, boolean>();
    (list?.gates ?? []).forEach((gate) => map.set(gate.employee_code, gate.enabled));
    return map;
  }, [list?.gates]);

  const pendingDays = (list?.days ?? []).filter(
    (day) => day.status === "missing_in" || day.status === "missing_out",
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
      toast({ title: "Không mở được ảnh", description: error?.message, variant: "destructive" });
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

      {(pendingDays.length > 0 || flagged.length > 0 || pendingDevices.length > 0) && (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> Cần xử lý
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {pendingDevices.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Máy mới chờ duyệt</p>
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
                <p className="text-xs text-muted-foreground">Duyệt máy mới sẽ thay máy cũ của nhân viên đó.</p>
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nhân viên được chấm công GPS</CardTitle>
          <CardDescription>
            Bật cho từng người. Máy đầu tiên nhân viên dùng được ghi nhận tự động; máy khác phải chờ duyệt.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {employees.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">Chưa có danh sách nhân viên của kỳ này.</p>
          ) : (
            employees.map((employee) => {
              const enabled = gates.get(employee.code) === true;
              const device = activeDevices.find((item) => item.employee_code === employee.code);
              return (
                <div key={employee.code} className="flex items-center gap-3 px-6 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{employee.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {employee.code} · {device ? `Máy: ${device.user_agent_family ?? "đã gắn"}` : "Chưa gắn máy"}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lượt chấm gần đây</CardTitle>
          <CardDescription>
            {list ? `${formatDate(list.from)} – ${formatDate(list.to)}` : ""} · gồm cả lượt bị từ chối
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có lượt chấm công nào.</p>
          ) : (
            recent.map((event) => (
              <EventRow key={event.id} event={event} name={nameOf(event.employee_code)} onSelfie={openSelfie} />
            ))
          )}
        </CardContent>
      </Card>

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

export default GpsAttendanceAdmin;
