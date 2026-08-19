import { useState } from "react";
import { AlertTriangle, Loader2, Pencil, Save, Truck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type DeliveryStaff = {
  id: string;
  full_name: string;
  phone_raw: string;
  phone_normalized: string;
  monthly_salary_vnd: number | string;
  active: boolean;
};

type DeliveryStaffDraft = {
  id?: string;
  full_name: string;
  phone_raw: string;
  monthly_salary_vnd: string;
  active: boolean;
};

const emptyDraft: DeliveryStaffDraft = {
  full_name: "",
  phone_raw: "",
  monthly_salary_vnd: "",
  active: true,
};

const normalizeVietnamPhone = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  if (/^84(3|5|7|8|9)\d{8}$/.test(digits)) return digits;
  if (/^0(3|5|7|8|9)\d{8}$/.test(digits)) return `84${digits.slice(1)}`;
  if (/^(3|5|7|8|9)\d{8}$/.test(digits)) return `84${digits}`;
  return "";
};

const salaryValue = (value: string) => Number(value.replace(/[^0-9]/g, ""));

const formatVnd = (value: number | string) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const deliveryStaffFriendlyErrors = new Set([
  "Vui lòng nhập họ và tên.",
  "Số điện thoại Việt Nam không hợp lệ.",
  "Lương tháng không hợp lệ.",
  "Số điện thoại này đã thuộc một nhân viên giao hàng đang hoạt động.",
]);

const formatDeliveryStaffError = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return deliveryStaffFriendlyErrors.has(message)
    ? message
    : "Không thể lưu nhân viên giao hàng. Vui lòng thử lại hoặc báo quản trị viên.";
};

export function DeliveryStaffAdminPanel({ canView, canEdit }: { canView: boolean; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<DeliveryStaffDraft>(emptyDraft);

  const { data: staffRows = [], isLoading, error } = useQuery({
    queryKey: ["delivery-staff"],
    queryFn: async () => {
      const { data, error: queryError } = await (supabase as any)
        .from("delivery_staff")
        .select("id, full_name, phone_raw, phone_normalized, monthly_salary_vnd, active")
        .order("active", { ascending: false })
        .order("full_name", { ascending: true });
      if (queryError) {
        console.error("Delivery staff query failed", queryError);
        throw new Error("Không thể tải danh sách nhân viên giao hàng. Vui lòng thử lại.");
      }
      return (data || []) as DeliveryStaff[];
    },
    enabled: canView,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const fullName = draft.full_name.trim();
      const phoneNormalized = normalizeVietnamPhone(draft.phone_raw);
      const monthlySalary = salaryValue(draft.monthly_salary_vnd);
      if (fullName.length < 2) throw new Error("Vui lòng nhập họ và tên.");
      if (!phoneNormalized) throw new Error("Số điện thoại Việt Nam không hợp lệ.");
      if (!Number.isFinite(monthlySalary) || monthlySalary < 0) throw new Error("Lương tháng không hợp lệ.");

      const payload = {
        full_name: fullName,
        phone_raw: draft.phone_raw.trim(),
        phone_normalized: phoneNormalized,
        monthly_salary_vnd: monthlySalary,
        active: draft.active,
      };
      const query = draft.id
        ? (supabase as any).from("delivery_staff").update(payload).eq("id", draft.id)
        : (supabase as any).from("delivery_staff").insert(payload);
      const { error: saveError } = await query;
      if (saveError) {
        console.error("Delivery staff save failed", saveError);
        if (saveError.code === "23505") throw new Error("Số điện thoại này đã thuộc một nhân viên giao hàng đang hoạt động.");
        throw new Error("Không thể lưu nhân viên giao hàng. Vui lòng thử lại hoặc báo quản trị viên.");
      }
    },
    onSuccess: async () => {
      setDraft(emptyDraft);
      await queryClient.invalidateQueries({ queryKey: ["delivery-staff"] });
      toast({ title: "Đã lưu nhân viên giao hàng" });
    },
    onError: (saveError: any) => {
      toast({ title: "Lưu nhân viên giao hàng thất bại", description: formatDeliveryStaffError(saveError), variant: "destructive" });
    },
  });

  if (!canView) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          Bạn không có quyền xem nhân viên giao hàng.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Đang tải nhân viên giao hàng...</CardContent></Card>;
  }

  if (error) {
    return <Card><CardContent className="flex items-start gap-3 p-4 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4" />Không thể tải danh sách nhân viên giao hàng. Vui lòng thử lại.</CardContent></Card>;
  }

  return (
    <div className={canEdit ? "grid gap-4 lg:grid-cols-[380px_1fr]" : "grid gap-4"}>
      {canEdit && (
        <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
          <CardHeader>
            <CardTitle>{draft.id ? "Sửa nhân viên giao hàng" : "Tạo nhân viên giao hàng"}</CardTitle>
            <CardDescription>Hồ sơ nhân sự nội bộ, không cấp quyền đăng nhập.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label>Họ và tên</Label>
              <Input value={draft.full_name} onChange={(event) => setDraft((current) => ({ ...current, full_name: event.target.value }))} placeholder="VD: Nguyễn Văn A" />
            </div>
            <div className="space-y-2">
              <Label>Số điện thoại</Label>
              <Input inputMode="tel" value={draft.phone_raw} onChange={(event) => setDraft((current) => ({ ...current, phone_raw: event.target.value }))} placeholder="VD: 0966998999" />
            </div>
            <div className="space-y-2">
              <Label>Lương tháng</Label>
              <Input inputMode="numeric" value={draft.monthly_salary_vnd} onChange={(event) => setDraft((current) => ({ ...current, monthly_salary_vnd: event.target.value }))} placeholder="VD: 9000000" />
            </div>
            <div className="space-y-2">
              <Label>Trạng thái</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.active ? "active" : "inactive"} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.value === "active" }))}>
                <option value="active">Đang hoạt động</option>
                <option value="inactive">Tạm ngưng</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              {draft.id ? <Button variant="outline" onClick={() => setDraft(emptyDraft)}>Huỷ sửa</Button> : null}
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Lưu nhân viên
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader>
          <CardTitle>Danh sách nhân viên giao hàng</CardTitle>
          <CardDescription>{staffRows.length} hồ sơ</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {staffRows.map((staff) => (
            <div key={staff.id} className="rounded-lg border bg-background/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Truck className="h-4 w-4 text-muted-foreground" /><div className="truncate font-semibold">{staff.full_name}</div></div>
                  <div className="mt-1">{staff.active ? <Badge>Đang hoạt động</Badge> : <Badge variant="secondary">Tạm ngưng</Badge>}</div>
                  <div className="mt-2 text-sm text-muted-foreground">{staff.phone_raw || staff.phone_normalized}</div>
                  <div className="text-sm font-medium">Lương tháng: {formatVnd(staff.monthly_salary_vnd)}</div>
                  <div className="mt-2 text-xs text-muted-foreground">Không cấp quyền đăng nhập</div>
                </div>
              </div>
              {canEdit && (
                <Button size="sm" variant="outline" className="mt-3" onClick={() => setDraft({
                  id: staff.id,
                  full_name: staff.full_name || "",
                  phone_raw: staff.phone_raw || staff.phone_normalized || "",
                  monthly_salary_vnd: String(Number(staff.monthly_salary_vnd || 0) || ""),
                  active: staff.active !== false,
                })}>
                  <Pencil className="mr-2 h-4 w-4" />Sửa
                </Button>
              )}
            </div>
          ))}
          {staffRows.length === 0 && <div className="rounded-lg border bg-background/80 p-6 text-center text-sm text-muted-foreground md:col-span-2">Chưa có nhân viên giao hàng.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
