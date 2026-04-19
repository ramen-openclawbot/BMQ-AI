import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/supabase-helpers";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AppRole = "owner" | "staff" | "viewer" | "warehouse";

export interface UserWithRole {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: AppRole | null;
}

export interface ModulePermissionRow {
  user_id: string;
  module_key: string;
  can_view: boolean;
  can_edit: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: AppRole;
  status: string;
  created_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Module definitions (source of truth for the permission matrix)
// ---------------------------------------------------------------------------
export const ALL_MODULES: { key: string; labelEn: string; labelVi: string }[] = [
  { key: "dashboard", labelEn: "Dashboard", labelVi: "Tổng quan" },
  { key: "reports", labelEn: "Reports", labelVi: "Báo cáo" },
  { key: "niraan_dashboard", labelEn: "Investor Dashboard", labelVi: "Investor Dashboard" },
  { key: "finance_cost", labelEn: "Cost Management", labelVi: "Quản lý chi phí" },
  { key: "finance_revenue", labelEn: "Revenue Management", labelVi: "Quản lý doanh thu" },
  { key: "crm", labelEn: "CRM", labelVi: "CRM" },
  { key: "sales_po_inbox", labelEn: "Sales PO Inbox", labelVi: "PO (Bán hàng)" },
  { key: "purchase_orders", labelEn: "Purchase Orders", labelVi: "Đơn đặt hàng" },
  { key: "attendance", labelEn: "Attendance", labelVi: "Chấm công" },
  { key: "payroll", labelEn: "Payroll", labelVi: "Bảng lương" },
  { key: "inventory", labelEn: "Inventory", labelVi: "Kho hàng" },
  { key: "goods_receipts", labelEn: "Goods Receipts", labelVi: "Phiếu nhập kho" },
  { key: "sku_costs", labelEn: "SKU Costs", labelVi: "Giá vốn" },
  { key: "suppliers", labelEn: "Suppliers", labelVi: "Nhà cung cấp" },
  { key: "invoices", labelEn: "Invoices", labelVi: "Hoá đơn" },
  { key: "payment_requests", labelEn: "Payment Requests", labelVi: "Duyệt chi" },
  { key: "low_stock", labelEn: "Low Stock", labelVi: "Sắp hết hàng" },
  { key: "settings", labelEn: "Settings", labelVi: "Cài đặt" },
];

// ---------------------------------------------------------------------------
// 1. useUsersList — profiles JOIN user_roles
// ---------------------------------------------------------------------------
export function useUsersList() {
  return useQuery({
    queryKey: ["user-management-users"],
    queryFn: async () => {
      // Fetch profiles
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id,full_name,email")
        .order("full_name", { ascending: true });

      if (profilesError) throw profilesError;

      // Fetch roles
      const { data: rolesData, error: rolesError } = await (supabase as any)
        .from("user_roles")
        .select("user_id,role");

      if (rolesError) throw rolesError;

      const roleMap = new Map<string, AppRole>();
      for (const r of (rolesData || []) as any[]) {
        roleMap.set(r.user_id, r.role);
      }

      return ((profiles || []) as any[]).map((p) => ({
        user_id: p.user_id,
        full_name: p.full_name,
        email: p.email,
        role: roleMap.get(p.user_id) || null,
      })) as UserWithRole[];
    },
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// 2. useAllPermissions — all user_module_permissions for the matrix
// ---------------------------------------------------------------------------
export function useAllPermissions() {
  return useQuery({
    queryKey: ["user-management-permissions"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("user_module_permissions")
        .select("user_id,module_key,can_view,can_edit");

      if (error) throw error;

      return (data || []) as ModulePermissionRow[];
    },
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// 3. useAssignRole — mutation to upsert user_roles
// ---------------------------------------------------------------------------
export function useAssignRole() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      // Check if role exists
      const { data: existing } = await (supabase as any)
        .from("user_roles")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        const { error } = await (supabase as any)
          .from("user_roles")
          .update({ role })
          .eq("user_id", userId);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("user_roles")
          .insert({ user_id: userId, role });
        if (error) throw error;
      }

      // Auto-apply default module permissions by role right after role change.
      // This ensures roles like "warehouse" immediately get inventory defaults.
      const viewSet = DEFAULT_VIEW[role] || [];
      const editSet = DEFAULT_EDIT[role] || [];
      const rows = ALL_MODULE_KEYS.map((key) => ({
        user_id: userId,
        module_key: key,
        can_view: viewSet.includes(key),
        can_edit: editSet.includes(key),
      }));

      const { error: permError } = await (supabase as any)
        .from("user_module_permissions")
        .upsert(rows, { onConflict: "user_id,module_key" });
      if (permError) throw permError;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      qc.invalidateQueries({ queryKey: ["user-management-permissions"] });
      toast({ title: "Đã cập nhật role và gán quyền mặc định" });
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi cập nhật role",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 4. useUpdatePermission — mutation to upsert user_module_permissions
// ---------------------------------------------------------------------------
export function useUpdatePermission() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      userId,
      moduleKey,
      canView,
      canEdit,
    }: {
      userId: string;
      moduleKey: string;
      canView: boolean;
      canEdit: boolean;
    }) => {
      const { error } = await (supabase as any)
        .from("user_module_permissions")
        .upsert(
          {
            user_id: userId,
            module_key: moduleKey,
            can_view: canView,
            can_edit: canEdit,
          },
          { onConflict: "user_id,module_key" }
        );

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-permissions"] });
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi cập nhật quyền",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 5. useInvitations — list pending invitations
// ---------------------------------------------------------------------------
export function useInvitations() {
  return useQuery({
    queryKey: ["user-management-invitations"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("user_invitations")
        .select("id,email,role,status,created_at,expires_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data || []) as Invitation[];
    },
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// 6. useInviteUser — mutation to create invitation
// ---------------------------------------------------------------------------
export function useInviteUser() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ email, role }: { email: string; role: AppRole }) => {
      const accessToken = await getFreshAccessToken();

      const { data, error } = await supabase.functions.invoke("user-invite-member", {
        body: { email: email.trim().toLowerCase(), role },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { success: boolean; email_sent?: boolean; note?: string };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["user-management-invitations"] });
      qc.invalidateQueries({ queryKey: ["user-management-users"] });

      if (data?.email_sent) {
        toast({ title: "Đã gửi email mời" });
      } else {
        toast({
          title: "Đã tạo lời mời",
          description: data?.note || "User đã tồn tại, vui lòng kiểm tra trạng thái tài khoản.",
        });
      }
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi gửi lời mời",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Default permission sets per role (mirrors the SQL seed logic)
// ---------------------------------------------------------------------------
const DEFAULT_VIEW: Record<string, string[]> = {
  staff: ["dashboard","reports","finance_cost","finance_revenue","crm","sales_po_inbox","purchase_orders","attendance","inventory","goods_receipts","sku_costs","suppliers","invoices","payment_requests","low_stock","settings"],
  warehouse: ["dashboard","purchase_orders","inventory","goods_receipts","suppliers","invoices","low_stock","settings"],
  viewer: ["dashboard","inventory","low_stock","settings"],
};
const DEFAULT_EDIT: Record<string, string[]> = {
  staff: ["dashboard","finance_cost","finance_revenue","crm","sales_po_inbox","purchase_orders","attendance","suppliers","invoices","payment_requests"],
  warehouse: ["inventory","goods_receipts"],
  viewer: [],
};

const ALL_MODULE_KEYS = [
  "dashboard","reports","niraan_dashboard","finance_cost","finance_revenue","crm",
  "sales_po_inbox","purchase_orders","attendance","payroll","inventory","goods_receipts","sku_costs",
  "suppliers","invoices","payment_requests","low_stock","settings",
];

// ---------------------------------------------------------------------------
// 7. useResetPermissionsToDefault — bulk upsert permissions based on role
// ---------------------------------------------------------------------------
export function useResetPermissionsToDefault() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const viewSet = DEFAULT_VIEW[role] || [];
      const editSet = DEFAULT_EDIT[role] || [];

      const rows = ALL_MODULE_KEYS.map((key) => ({
        user_id: userId,
        module_key: key,
        can_view: viewSet.includes(key),
        can_edit: editSet.includes(key),
      }));

      const { error } = await (supabase as any)
        .from("user_module_permissions")
        .upsert(rows, { onConflict: "user_id,module_key" });

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-permissions"] });
      toast({ title: "Đã gán quyền mặc định theo role" });
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi gán quyền",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 8. useDeleteUser — remove user's role + profile (revoke access)
// Note: cannot delete from auth.users without service_role key.
// Deleting profile + role effectively blocks all access.
// ---------------------------------------------------------------------------
export function useDeleteUser() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (userId: string) => {
      const accessToken = await getFreshAccessToken();

      const { data, error } = await supabase.functions.invoke("user-delete-member", {
        body: { userId },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-users"] });
      qc.invalidateQueries({ queryKey: ["user-management-permissions"] });
      qc.invalidateQueries({ queryKey: ["user-management-invitations"] });
      toast({ title: "Đã xoá người dùng" });
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi xoá người dùng",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 8. useCancelInvitation — mutation to cancel an invitation
// ---------------------------------------------------------------------------
export function useCancelInvitation() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const { error } = await (supabase as any)
        .from("user_invitations")
        .update({ status: "cancelled" })
        .eq("id", invitationId);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-management-invitations"] });
      toast({ title: "Đã huỷ lời mời" });
    },
    onError: (err: any) => {
      toast({
        title: "Lỗi huỷ lời mời",
        description: err?.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });
}
