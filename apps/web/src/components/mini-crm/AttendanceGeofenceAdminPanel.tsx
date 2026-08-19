import { useMemo, useState } from "react";
import { AlertTriangle, Crosshair, Loader2, Pencil, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type KioskLocation = {
  id: string;
  location_code: string;
  location_name: string;
  active: boolean;
};

type AttendanceGeofenceLocation = {
  id: string;
  code: string;
  name: string;
  location_type: "kiosk" | "warehouse";
  kiosk_location_id?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  accepted_radius_m: number;
  active: boolean;
  notes?: string | null;
};

type GeofenceDraft = {
  id?: string;
  code: string;
  name: string;
  location_type: "kiosk" | "warehouse";
  kiosk_location_id: string;
  latitude: string;
  longitude: string;
  accepted_radius_m: string;
  active: boolean;
  notes: string;
};

const emptyDraft: GeofenceDraft = {
  code: "",
  name: "",
  location_type: "kiosk",
  kiosk_location_id: "",
  latitude: "",
  longitude: "",
  accepted_radius_m: "20",
  active: true,
  notes: "",
};

const tanTaoDraft: GeofenceDraft = {
  ...emptyDraft,
  code: "warehouse_tan_tao",
  name: "Kho Tân Tạo",
  location_type: "warehouse",
  accepted_radius_m: "20",
};

const toText = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const parseOptionalCoordinate = (value: string, label: string) => {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} không hợp lệ.`);
  return parsed;
};

const attendanceGeofenceFriendlyErrors = new Set([
  "Vĩ độ không hợp lệ.",
  "Kinh độ không hợp lệ.",
  "Vui lòng nhập mã vị trí GPS.",
  "Vui lòng nhập tên vị trí GPS.",
  "Vĩ độ và Kinh độ phải được nhập cùng nhau.",
  "Bán kính chấp nhận (m) phải từ 1 đến 500.",
  "Mã vị trí GPS hoặc Kiosk / điểm bán đã được cấu hình.",
]);

const formatAttendanceGeofenceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return attendanceGeofenceFriendlyErrors.has(message)
    ? message
    : "Không thể lưu cấu hình GPS chấm công. Vui lòng thử lại hoặc báo quản trị viên.";
};

export function AttendanceGeofenceAdminPanel({ canView, canEdit }: { canView: boolean; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<GeofenceDraft>(tanTaoDraft);

  const geofencesQuery = useQuery({
    queryKey: ["attendance-geofence-locations"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("attendance_geofence_locations")
        .select("id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active, notes")
        .order("location_type", { ascending: true })
        .order("code", { ascending: true });
      if (error) {
        console.error("Attendance geofence query failed", error);
        throw new Error("Không thể tải cấu hình GPS chấm công. Vui lòng thử lại.");
      }
      return (data || []) as AttendanceGeofenceLocation[];
    },
    enabled: canView,
  });

  const kioskLocationsQuery = useQuery({
    queryKey: ["attendance-geofence-kiosk-report-locations"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("kiosk_report_locations")
        .select("id, location_code, location_name, active")
        .order("location_code", { ascending: true });
      if (error) {
        console.error("Attendance geofence query failed", error);
        throw new Error("Không thể tải cấu hình GPS chấm công. Vui lòng thử lại.");
      }
      return (data || []) as KioskLocation[];
    },
    enabled: canView,
  });

  const geofences = useMemo(() => geofencesQuery.data || [], [geofencesQuery.data]);
  const kioskLocations = useMemo(() => kioskLocationsQuery.data || [], [kioskLocationsQuery.data]);
  const kioskLabelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const location of kioskLocations) {
      labels.set(location.id, `${location.location_code} - ${location.location_name}`);
    }
    return labels;
  }, [kioskLocations]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const code = draft.code.trim();
      const name = draft.name.trim();
      const latitude = parseOptionalCoordinate(draft.latitude, "Vĩ độ");
      const longitude = parseOptionalCoordinate(draft.longitude, "Kinh độ");
      const acceptedRadiusM = Number(draft.accepted_radius_m || 20);
      if (!code) throw new Error("Vui lòng nhập mã vị trí GPS.");
      if (!name) throw new Error("Vui lòng nhập tên vị trí GPS.");
      if ((latitude === null) !== (longitude === null)) throw new Error("Vĩ độ và Kinh độ phải được nhập cùng nhau.");
      if (!Number.isInteger(acceptedRadiusM) || acceptedRadiusM < 1 || acceptedRadiusM > 500) {
        throw new Error("Bán kính chấp nhận (m) phải từ 1 đến 500.");
      }
      const payload = {
        code,
        name,
        location_type: draft.location_type,
        kiosk_location_id: draft.location_type === "kiosk" ? (draft.kiosk_location_id || null) : null,
        latitude,
        longitude,
        accepted_radius_m: acceptedRadiusM,
        active: draft.active,
        notes: draft.notes.trim() || null,
      };
      const query = draft.id
        ? (supabase as any).from("attendance_geofence_locations").update(payload).eq("id", draft.id)
        : (supabase as any).from("attendance_geofence_locations").insert(payload);
      const { error } = await query;
      if (error) {
        console.error("Attendance geofence save failed", error);
        if (error.code === "23505") throw new Error("Mã vị trí GPS hoặc Kiosk / điểm bán đã được cấu hình.");
        throw new Error("Không thể lưu cấu hình GPS chấm công. Vui lòng thử lại hoặc báo quản trị viên.");
      }
    },
    onSuccess: async () => {
      setDraft(tanTaoDraft);
      await queryClient.invalidateQueries({ queryKey: ["attendance-geofence-locations"] });
      toast({ title: "Đã lưu cấu hình GPS chấm công" });
    },
    onError: (error: any) => {
      toast({ title: "Lưu cấu hình GPS thất bại", description: formatAttendanceGeofenceError(error), variant: "destructive" });
    },
  });

  if (!canView) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          Bạn cần quyền CRM để xem cấu hình GPS chấm công.
        </CardContent>
      </Card>
    );
  }

  if (geofencesQuery.isLoading || kioskLocationsQuery.isLoading) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Đang tải cấu hình GPS chấm công...</CardContent></Card>;
  }

  if (geofencesQuery.error || kioskLocationsQuery.error) {
    return <Card><CardContent className="flex items-start gap-3 p-4 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4" />Không thể tải cấu hình GPS chấm công. Vui lòng thử lại.</CardContent></Card>;
  }

  return (
    <div className={canEdit ? "grid gap-4 lg:grid-cols-[420px_1fr]" : "grid gap-4"}>
      {canEdit && (
        <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
          <CardHeader>
            <CardTitle>{draft.id ? "Sửa GPS chấm công" : "Tạo GPS chấm công"}</CardTitle>
            <CardDescription>Khai báo geofence cho nhân viên kiosk và Kho Tân Tạo. Mặc định 20m, chưa tự gán nhân viên giao hàng.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Loại vị trí</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.location_type} onChange={(event) => setDraft((current) => ({ ...current, location_type: event.target.value as "kiosk" | "warehouse", kiosk_location_id: event.target.value === "warehouse" ? "" : current.kiosk_location_id }))}>
                  <option value="kiosk">Kiosk / điểm bán</option>
                  <option value="warehouse">Kho</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Trạng thái</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.active ? "active" : "inactive"} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.value === "active" }))}>
                  <option value="active">Đang dùng</option>
                  <option value="inactive">Tạm ngưng</option>
                </select>
              </div>
            </div>
            {draft.location_type === "kiosk" && (
              <div className="space-y-2">
                <Label>Kiosk / điểm bán</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.kiosk_location_id} onChange={(event) => setDraft((current) => ({ ...current, kiosk_location_id: event.target.value }))}>
                  <option value="">-- Chọn Kiosk / điểm bán --</option>
                  {kioskLocations.map((location) => (
                    <option key={location.id} value={location.id}>{location.location_code} - {location.location_name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Mã vị trí GPS</Label>
                <Input value={draft.code} onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))} placeholder="VD: warehouse_tan_tao" />
              </div>
              <div className="space-y-2">
                <Label>Tên vị trí GPS</Label>
                <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="VD: Kho Tân Tạo" />
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Vĩ độ</Label>
                <Input inputMode="decimal" value={draft.latitude} onChange={(event) => setDraft((current) => ({ ...current, latitude: event.target.value }))} placeholder="Chưa có" />
              </div>
              <div className="space-y-2">
                <Label>Kinh độ</Label>
                <Input inputMode="decimal" value={draft.longitude} onChange={(event) => setDraft((current) => ({ ...current, longitude: event.target.value }))} placeholder="Chưa có" />
              </div>
              <div className="space-y-2">
                <Label>Bán kính chấp nhận (m)</Label>
                <Input inputMode="numeric" value={draft.accepted_radius_m} onChange={(event) => setDraft((current) => ({ ...current, accepted_radius_m: event.target.value }))} placeholder="20" />
              </div>
            </div>
            <div className="text-xs text-muted-foreground">Mặc định 20m. Kho Tân Tạo được tạo sẵn với mã warehouse_tan_tao nhưng chưa có tọa độ.</div>
            <div className="space-y-2">
              <Label>Ghi chú</Label>
              <Input value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Nguồn xác nhận tọa độ / ghi chú vận hành" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              {draft.id ? <Button variant="outline" onClick={() => setDraft(tanTaoDraft)}>Huỷ sửa</Button> : null}
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Lưu GPS
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader>
          <CardTitle>Danh sách GPS chấm công</CardTitle>
          <CardDescription>{geofences.length} vị trí geofence</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {geofences.map((location) => (
            <div key={location.id} className="rounded-lg border bg-background/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Crosshair className="h-4 w-4 text-muted-foreground" /><div className="truncate font-semibold">{location.name}</div></div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="outline">{location.location_type === "warehouse" ? "Kho" : "Kiosk"}</Badge>
                    {location.active ? <Badge>Đang dùng</Badge> : <Badge variant="secondary">Tạm ngưng</Badge>}
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">{location.code}</div>
                  {location.kiosk_location_id ? <div className="text-sm">{kioskLabelById.get(location.kiosk_location_id) || "Kiosk / điểm bán"}</div> : null}
                  <div className="text-sm">Tọa độ: {location.latitude && location.longitude ? `${location.latitude}, ${location.longitude}` : "Chưa cấu hình"}</div>
                  <div className="text-sm font-medium">Bán kính chấp nhận: {location.accepted_radius_m || 20}m</div>
                  {location.notes ? <div className="mt-2 text-xs text-muted-foreground">{location.notes}</div> : null}
                </div>
              </div>
              {canEdit && (
                <Button size="sm" variant="outline" className="mt-3" onClick={() => setDraft({
                  id: location.id,
                  code: location.code || "",
                  name: location.name || "",
                  location_type: location.location_type || "kiosk",
                  kiosk_location_id: location.kiosk_location_id || "",
                  latitude: toText(location.latitude),
                  longitude: toText(location.longitude),
                  accepted_radius_m: String(location.accepted_radius_m || 20),
                  active: location.active !== false,
                  notes: location.notes || "",
                })}>
                  <Pencil className="mr-2 h-4 w-4" />Sửa
                </Button>
              )}
            </div>
          ))}
          {geofences.length === 0 && <div className="rounded-lg border bg-background/80 p-6 text-center text-sm text-muted-foreground md:col-span-2">Chưa có cấu hình GPS chấm công.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
