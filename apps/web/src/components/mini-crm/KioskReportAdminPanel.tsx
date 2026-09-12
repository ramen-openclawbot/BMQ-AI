import { useLanguage } from "@/contexts/LanguageContext";
import { useSalesCrmMessages, SalesCrmUiError, crmErrorNotice, renderCrmNotice } from "@/i18n/salesCrm";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, MapPin, Pencil, Save, UserRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { getFreshAccessToken } from "@/lib/supabase-helpers";

type KioskLocation = {
  id: string;
  location_code: string;
  location_name: string;
  address?: string | null;
  active: boolean;
};

type KioskStaff = {
  id: string;
  full_name: string;
  phone_raw: string;
  phone_normalized: string;
  location_id: string;
  monthly_salary_vnd: number | string;
  active: boolean;
  kiosk_report_locations?: KioskLocation | null;
};

type KioskAdminData = {
  success?: boolean;
  locations?: KioskLocation[];
  staff?: KioskStaff[];
};

type LocationDraft = {
  id?: string;
  location_name: string;
  location_code: string;
  address: string;
  active: boolean;
};

type StaffDraft = {
  id?: string;
  full_name: string;
  phone_raw: string;
  location_id: string;
  monthly_salary_vnd: string;
  active: boolean;
};

const emptyLocationDraft: LocationDraft = {
  location_name: "",
  location_code: "",
  address: "",
  active: true,
};

const emptyStaffDraft: StaffDraft = {
  full_name: "",
  phone_raw: "",
  location_id: "",
  monthly_salary_vnd: "",
  active: true,
};

const formatVnd = (value: number | string) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

async function callKioskReportAdmin<T>(body: Record<string, unknown>) {
  let token: string;
  try { token = await getFreshAccessToken(); }
  catch { throw new SalesCrmUiError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."); }
  const result = await callEdgeFunction<T>("kiosk-report-admin", body, token, 30000);
  if (result.error) {
    // These three messages originate in the shared transport helper, not business data.
    if (result.isSessionExpired) throw new SalesCrmUiError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
    if (result.isRateLimited && result.error === "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.") throw new SalesCrmUiError("Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.");
    if (result.error === "Đã quá thời gian chờ. Vui lòng thử lại.") throw new SalesCrmUiError("Đã quá thời gian chờ. Vui lòng thử lại.");
    throw new Error(result.error);
  }
  if (!result.data) throw new SalesCrmUiError("Không có dữ liệu trả về từ kiosk-report-admin");
  return result.data;
}

export function KioskReportAdminPanel({
  mode,
  canView,
  canEdit,
}: {
  mode: "locations" | "staff";
  canView: boolean;
  canEdit: boolean;
}) {
  const f = useSalesCrmMessages();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [locationDraft, setLocationDraft] = useState<LocationDraft>(emptyLocationDraft);
  const [staffDraft, setStaffDraft] = useState<StaffDraft>(emptyStaffDraft);

  const { data, isLoading, error } = useQuery({
    queryKey: ["kiosk-report-admin"],
    queryFn: async () => callKioskReportAdmin<KioskAdminData>({ action: "list" }),
    enabled: canView,
  });

  const locations = useMemo(() => data?.locations || [], [data?.locations]);
  const staffRows = useMemo(() => data?.staff || [], [data?.staff]);
  const activeLocations = useMemo(() => locations.filter((location) => location.active), [locations]);

  useEffect(() => {
    if (!staffDraft.location_id && activeLocations.length === 1) {
      setStaffDraft((current) => ({ ...current, location_id: activeLocations[0].id }));
    }
  }, [activeLocations, staffDraft.location_id]);

  const saveLocationMutation = useMutation({
    mutationFn: async () => callKioskReportAdmin<{ success?: boolean; location?: KioskLocation }>({
      action: "upsert_location",
      location: locationDraft,
    }),
    onSuccess: async () => {
      setLocationDraft(emptyLocationDraft);
      await queryClient.invalidateQueries({ queryKey: ["kiosk-report-admin"] });
      toast({ title: f("Đã lưu điểm bán") });
    },
    onError: (e: any) => {
      toast({ title: f("Lưu điểm bán thất bại"), description: renderCrmNotice(language, crmErrorNotice(e, "Không thể lưu")), variant: "destructive" });
    },
  });

  const saveStaffMutation = useMutation({
    mutationFn: async () => callKioskReportAdmin<{ success?: boolean; staff?: KioskStaff }>({
      action: "upsert_staff",
      staff: staffDraft,
    }),
    onSuccess: async () => {
      setStaffDraft({ ...emptyStaffDraft, location_id: activeLocations[0]?.id || "" });
      await queryClient.invalidateQueries({ queryKey: ["kiosk-report-admin"] });
      toast({ title: f("Đã lưu nhân viên báo cáo") });
    },
    onError: (e: any) => {
      toast({ title: f("Lưu nhân viên thất bại"), description: renderCrmNotice(language, crmErrorNotice(e, "Không thể lưu")), variant: "destructive" });
    },
  });

  if (!canView) {
    return (
      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader>
          <CardTitle>{f("Quản lý báo cáo điểm bán")}</CardTitle>
          <CardDescription>{f("Bạn cần được phân quyền CRM để xem dữ liệu báo cáo điểm bán.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>{f("Bạn không có quyền xem dữ liệu báo cáo điểm bán.")}</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex min-h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
           {f("Đang tải dữ liệu báo cáo điểm bán...")} </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          {renderCrmNotice(language, crmErrorNotice(error, "Không tải được dữ liệu báo cáo điểm bán"))}
        </CardContent>
      </Card>
    );
  }

  if (mode === "locations") {
    return (
      <div className={canEdit ? "grid gap-4 lg:grid-cols-[360px_1fr]" : "grid gap-4"}>
        {canEdit && (
        <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
          <CardHeader>
            <CardTitle>{locationDraft.id ? f("Sửa điểm bán") : f("Tạo điểm bán")}</CardTitle>
            <CardDescription>{f("Điểm bán dùng riêng cho Báo cáo, tách khỏi Khách hàng đặt hàng.")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label>{f("Tên điểm bán")}</Label>
              <Input value={locationDraft.location_name} onChange={(e) => setLocationDraft((current) => ({ ...current, location_name: e.target.value }))} placeholder={f("VD: Kiosk Nguyễn Huệ")} />
            </div>
            <div className="space-y-2">
              <Label>{f("Mã điểm bán")}</Label>
              <Input value={locationDraft.location_code} onChange={(e) => setLocationDraft((current) => ({ ...current, location_code: e.target.value }))} placeholder={f("VD: KIOSK-NH")} />
            </div>
            <div className="space-y-2">
              <Label>{f("Địa chỉ")}</Label>
              <Input value={locationDraft.address} onChange={(e) => setLocationDraft((current) => ({ ...current, address: e.target.value }))} placeholder={f("Địa chỉ vận hành")} />
            </div>
            <div className="space-y-2">
              <Label>{f("Trạng thái")}</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={locationDraft.active ? "active" : "inactive"} onChange={(e) => setLocationDraft((current) => ({ ...current, active: e.target.value === "active" }))}>
                <option value="active">{f("Active")}</option>
                <option value="inactive">{f("Tạm ngưng")}</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              {locationDraft.id ? <Button variant="outline" onClick={() => setLocationDraft(emptyLocationDraft)}>{f("Huỷ sửa")}</Button> : null}
              <Button onClick={() => saveLocationMutation.mutate()} disabled={saveLocationMutation.isPending}>
                {saveLocationMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                 {f("Lưu điểm bán")} </Button>
            </div>
          </CardContent>
        </Card>
        )}

        <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
          <CardHeader>
            <CardTitle>{f("Danh sách điểm bán")}</CardTitle>
            <CardDescription>{locations.length}  {f("điểm bán báo cáo")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {locations.map((location) => (
              <div key={location.id} className="rounded-lg border bg-background/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <div className="truncate font-semibold">{location.location_name}</div>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">{location.location_code}</div>
                    <div className="mt-2 text-sm">{location.address || f("Chưa có địa chỉ")}</div>
                  </div>
                  {location.active ? <Badge>{f("Active")}</Badge> : <Badge variant="secondary">{f("Tạm ngưng")}</Badge>}
                </div>
                {canEdit && <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => setLocationDraft({
                    id: location.id,
                    location_name: location.location_name || "",
                    location_code: location.location_code || "",
                    address: location.address || "",
                    active: location.active !== false,
                  })}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                   {f("Sửa")} </Button>}
              </div>
            ))}
            {locations.length === 0 && (
              <div className="rounded-lg border bg-background/80 p-6 text-center text-sm text-muted-foreground md:col-span-2">
                 {f("Chưa có điểm bán báo cáo.")} </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={canEdit ? "grid gap-4 lg:grid-cols-[380px_1fr]" : "grid gap-4"}>
      {canEdit && (
      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader>
          <CardTitle>{staffDraft.id ? f("Sửa nhân viên bán hàng") : f("Tạo nhân viên bán hàng")}</CardTitle>
          <CardDescription>{f("Nhân viên chỉ thuộc 1 điểm bán. Đổi điểm bán tại đây sẽ thu hồi phiên báo cáo đang hoạt động.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mr-2 inline h-4 w-4 align-text-bottom" />
             {f("Không có quyền truy cập Đặt hàng")} </div>
          <div className="space-y-2">
            <Label>{f("Tên nhân viên")}</Label>
            <Input value={staffDraft.full_name} onChange={(e) => setStaffDraft((current) => ({ ...current, full_name: e.target.value }))} placeholder={f("VD: Nguyễn Văn A")} />
          </div>
          <div className="space-y-2">
            <Label>{f("SĐT nhân viên")}</Label>
            <Input inputMode="tel" value={staffDraft.phone_raw} onChange={(e) => setStaffDraft((current) => ({ ...current, phone_raw: e.target.value }))} placeholder={f("VD: 0966998999")} />
          </div>
          <div className="space-y-2">
            <Label>{f("Đổi điểm bán")}</Label>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={staffDraft.location_id} onChange={(e) => setStaffDraft((current) => ({ ...current, location_id: e.target.value }))}>
              <option value="">{f("-- Chọn đúng 1 điểm bán --")}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.location_code} - {location.location_name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>{f("Lương tháng")}</Label>
            <Input inputMode="numeric" value={staffDraft.monthly_salary_vnd} onChange={(e) => setStaffDraft((current) => ({ ...current, monthly_salary_vnd: e.target.value }))} placeholder={f("VD: 9000000")} />
          </div>
          <div className="space-y-2">
            <Label>{f("Trạng thái")}</Label>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={staffDraft.active ? "active" : "inactive"} onChange={(e) => setStaffDraft((current) => ({ ...current, active: e.target.value === "active" }))}>
              <option value="active">{f("Active")}</option>
              <option value="inactive">{f("Tạm ngưng")}</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            {staffDraft.id ? <Button variant="outline" onClick={() => setStaffDraft({ ...emptyStaffDraft, location_id: activeLocations[0]?.id || "" })}>{f("Huỷ sửa")}</Button> : null}
            <Button onClick={() => saveStaffMutation.mutate()} disabled={saveStaffMutation.isPending || locations.length === 0}>
              {saveStaffMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
               {f("Lưu nhân viên")} </Button>
          </div>
        </CardContent>
      </Card>
      )}

      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader>
          <CardTitle>{f("Danh sách nhân viên bán hàng")}</CardTitle>
          <CardDescription>{staffRows.length}  {f("nhân viên báo cáo")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {staffRows.map((staff) => (
            <div key={staff.id} className="rounded-lg border bg-background/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <UserRound className="h-4 w-4 text-muted-foreground" />
                    <div className="truncate font-semibold">{staff.full_name}</div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="outline">{f("Chỉ Báo cáo")}</Badge>
                    {staff.active ? <Badge>{f("Active")}</Badge> : <Badge variant="secondary">{f("Tạm ngưng")}</Badge>}
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">{staff.phone_raw || staff.phone_normalized}</div>
                  <div className="text-sm">{staff.kiosk_report_locations?.location_name || f("Chưa gán điểm bán")}</div>
                  <div className="text-sm font-medium">{f("Lương tháng:")} {formatVnd(staff.monthly_salary_vnd)}</div>
                  <div className="mt-2 text-xs text-amber-700">{f("Không có quyền truy cập Đặt hàng")}</div>
                </div>
              </div>
              {canEdit && <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => setStaffDraft({
                  id: staff.id,
                  full_name: staff.full_name || "",
                  phone_raw: staff.phone_raw || staff.phone_normalized || "",
                  location_id: staff.location_id || "",
                  monthly_salary_vnd: String(Number(staff.monthly_salary_vnd || 0) || ""),
                  active: staff.active !== false,
                })}
              >
                <Pencil className="mr-2 h-4 w-4" />
                 {f("Sửa")} </Button>}
            </div>
          ))}
          {staffRows.length === 0 && (
            <div className="rounded-lg border bg-background/80 p-6 text-center text-sm text-muted-foreground md:col-span-2">
               {f("Chưa có nhân viên bán hàng cho Báo cáo.")} </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
