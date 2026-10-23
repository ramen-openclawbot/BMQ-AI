import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  useUsersList,
  useAllPermissions,
  useAssignRole,
  useUpdatePermission,
  useDeleteUser,
  useResetPermissionsToDefault,
  ALL_MODULES,
  type UserWithRole,
} from "@/hooks/useUserManagement";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Users, Shield, Trash2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/ui/loading";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/settings/SettingsKit";

const ROLES: Array<{ value: AppRole; label: string; vi: string }> = [
  { value: "owner", label: "Owner", vi: "Toàn quyền" },
  { value: "staff", label: "Staff", vi: "Văn phòng" },
  { value: "warehouse", label: "Warehouse", vi: "Kho" },
  { value: "viewer", label: "Viewer", vi: "Chỉ xem" },
];
const roleLabel = (role: string | null | undefined) => ROLES.find((r) => r.value === role)?.label ?? (role || "Viewer");

type AppRole = "owner" | "staff" | "viewer" | "warehouse";

/**
 * Người dùng & Phân quyền (owner 23/10/2026): phone-first grouped lists instead of wide tables.
 * Users: one row per person, the row opens role + delete. Permissions: one row per person,
 * the row opens one line per module with Xem / Sửa toggles. Guards are unchanged.
 */
export default function UserManagement() {
  const { language } = useLanguage();
  const isVi = language === "vi";

  return (
    <SettingsPage title={isVi ? "Người dùng" : "Users"}>
      <Tabs defaultValue="users" className="grid gap-5">
        <TabsList className="w-fit">
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-4 w-4" />
            {isVi ? "Người dùng" : "Users"}
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-2">
            <Shield className="h-4 w-4" />
            {isVi ? "Phân quyền" : "Permissions"}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-0">
          <UsersTab isVi={isVi} />
        </TabsContent>
        <TabsContent value="permissions" className="mt-0">
          <PermissionsTab isVi={isVi} />
        </TabsContent>
      </Tabs>
    </SettingsPage>
  );
}

// ===========================================================================
// TAB 1: Users
// ===========================================================================
function UsersTab({ isVi }: { isVi: boolean }) {
  const { data: users, isLoading } = useUsersList();
  const { user: currentUser } = useAuth();
  const assignRole = useAssignRole();
  const deleteUser = useDeleteUser();
  const { toast } = useToast();

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<UserWithRole | null>(null);

  const handleRoleChange = (targetUser: UserWithRole, newRole: AppRole) => {
    // Guard: cannot change your own role
    if (targetUser.user_id === currentUser?.id) {
      toast({
        title: isVi ? "Không thể đổi role" : "Cannot change role",
        description: isVi
          ? "Bạn không thể thay đổi role của chính mình."
          : "You cannot change your own role.",
        variant: "destructive",
      });
      return;
    }

    // Guard: cannot demote the last owner
    if (targetUser.role === "owner") {
      const ownerCount = (users || []).filter((u) => u.role === "owner").length;
      if (ownerCount <= 1) {
        toast({
          title: isVi ? "Không thể đổi role" : "Cannot change role",
          description: isVi
            ? "Phải có ít nhất một Owner trong hệ thống."
            : "There must be at least one Owner.",
          variant: "destructive",
        });
        return;
      }
    }

    assignRole.mutate({ userId: targetUser.user_id, role: newRole });
  };

  const handleDeleteClick = (targetUser: UserWithRole) => {
    // Guard: cannot delete yourself
    if (targetUser.user_id === currentUser?.id) {
      toast({
        title: isVi ? "Không thể xoá" : "Cannot delete",
        description: isVi
          ? "Bạn không thể xoá tài khoản của chính mình."
          : "You cannot delete your own account.",
        variant: "destructive",
      });
      return;
    }

    // Guard: cannot delete the last owner
    if (targetUser.role === "owner") {
      const ownerCount = (users || []).filter((u) => u.role === "owner").length;
      if (ownerCount <= 1) {
        toast({
          title: isVi ? "Không thể xoá" : "Cannot delete",
          description: isVi
            ? "Phải có ít nhất một Owner trong hệ thống."
            : "There must be at least one Owner.",
          variant: "destructive",
        });
        return;
      }
    }

    setDeleteTarget(targetUser);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteUser.mutate(deleteTarget.user_id, {
      onSettled: () => setDeleteTarget(null),
    });
  };

  if (isLoading) {
    return <SettingsGroup title={isVi ? "Danh sách" : "List"}><LoadingState flat rows={4} label="Đang tải người dùng…" /></SettingsGroup>;
  }

  const list = users || [];
  return (
    <>
      <SettingsGroup title={isVi ? `${list.length} người dùng` : `${list.length} users`}>
        {list.map((u) => {
          const isCurrentUser = u.user_id === currentUser?.id;
          const name = u.full_name || u.email || "—";
          if (isCurrentUser) {
            return (
              <SettingsRow key={u.user_id} dataAttr="bmq-user-row" label={<>{name} <span className="st-tag">{isVi ? "Bạn" : "You"}</span></>} hint={u.email || undefined} value={<b>{roleLabel(u.role)}</b>} />
            );
          }
          return (
            <SettingsRow key={u.user_id} dataAttr="bmq-user-row" label={name} hint={u.email || undefined} value={<b>{roleLabel(u.role)}</b>}>
              <div className="st-field">
                <span>Role</span>
                <div className="st-seg" role="radiogroup" aria-label="Role">
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      role="radio"
                      aria-checked={(u.role || "viewer") === r.value}
                      className="st-seg-opt"
                      disabled={assignRole.isPending}
                      onClick={() => { if ((u.role || "viewer") !== r.value) handleRoleChange(u, r.value); }}
                      data-bmq-role-option={r.value}
                    >
                      <b>{r.label}</b>
                      {isVi ? <small>{r.vi}</small> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="st-panel-actions">
                <button type="button" className="st-link is-danger" onClick={() => handleDeleteClick(u)} disabled={deleteUser.isPending} data-bmq-user-delete>
                  <Trash2 />{isVi ? "Xoá người dùng" : "Delete user"}
                </button>
              </div>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isVi ? "Xoá người dùng?" : "Delete user?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isVi
                ? `Bạn sắp xoá "${deleteTarget?.full_name || deleteTarget?.email}". Hành động này sẽ xoá profile và quyền truy cập của họ. Không thể hoàn tác.`
                : `You are about to delete "${deleteTarget?.full_name || deleteTarget?.email}". This will remove their profile and access. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isVi ? "Huỷ" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isVi ? (
                "Xoá"
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ===========================================================================
// TAB 2: Permissions by person
// ===========================================================================
function PermissionsTab({ isVi }: { isVi: boolean }) {
  const { data: users, isLoading: usersLoading } = useUsersList();
  const { data: permissions, isLoading: permsLoading } = useAllPermissions();
  const updatePermission = useUpdatePermission();
  const resetToDefault = useResetPermissionsToDefault();

  const isLoading = usersLoading || permsLoading;

  // Build a lookup: userId+moduleKey → { can_view, can_edit }
  const permMap = new Map<string, { can_view: boolean; can_edit: boolean }>();
  for (const p of permissions || []) {
    permMap.set(`${p.user_id}::${p.module_key}`, { can_view: p.can_view, can_edit: p.can_edit });
  }

  // Only show non-owner users (owners always have full access)
  const nonOwnerUsers = (users || []).filter((u) => u.role !== "owner");

  const handleToggle = (
    userId: string,
    moduleKey: string,
    field: "can_view" | "can_edit",
    currentValue: boolean
  ) => {
    const key = `${userId}::${moduleKey}`;
    const existing = permMap.get(key) || { can_view: false, can_edit: false };

    const updated = { ...existing };
    updated[field] = !currentValue;

    // If removing view, also remove edit
    if (field === "can_view" && currentValue) {
      updated.can_edit = false;
    }
    // If adding edit, also add view
    if (field === "can_edit" && !currentValue) {
      updated.can_view = true;
    }

    updatePermission.mutate({
      userId,
      moduleKey,
      canView: updated.can_view,
      canEdit: updated.can_edit,
    });
  };

  if (isLoading) {
    return <SettingsGroup title={isVi ? "Phân quyền" : "Permissions"}><LoadingState flat rows={4} label="Đang tải quyền…" /></SettingsGroup>;
  }

  if (nonOwnerUsers.length === 0) {
    return (
      <SettingsGroup title={isVi ? "Phân quyền" : "Permissions"}>
        <SettingsRow label={isVi ? "Chưa có người nào cần phân quyền" : "No one to set permissions for"} hint={isVi ? "Owner luôn có toàn quyền" : "Owners always have full access"} />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title={isVi ? "Quyền theo người · Owner luôn có toàn quyền" : "Permissions by person · Owners have full access"}>
      {nonOwnerUsers.map((u) => {
        const viewCount = ALL_MODULES.filter((m) => permMap.get(`${u.user_id}::${m.key}`)?.can_view).length;
        return (
          <SettingsRow
            key={u.user_id}
            dataAttr="bmq-perm-user"
            label={u.full_name || u.email || "—"}
            hint={roleLabel(u.role)}
            value={<b>{viewCount}/{ALL_MODULES.length}</b>}
          >
            <ul className="st-perms" aria-label={isVi ? "Quyền module" : "Module permissions"}>
              {ALL_MODULES.map((mod) => {
                const perm = permMap.get(`${u.user_id}::${mod.key}`) || { can_view: false, can_edit: false };
                const name = isVi ? mod.labelVi : mod.labelEn;
                return (
                  <li key={mod.key} data-bmq-perm-module={mod.key}>
                    <span className="st-perm-name">{name}</span>
                    <span className="st-perm-toggles">
                      <button type="button" className="st-toggle" aria-pressed={perm.can_view} aria-label={`${name}: ${isVi ? "Xem" : "View"}`}
                        disabled={updatePermission.isPending} onClick={() => handleToggle(u.user_id, mod.key, "can_view", perm.can_view)} data-bmq-perm-view>
                        {isVi ? "Xem" : "View"}
                      </button>
                      <button type="button" className="st-toggle" aria-pressed={perm.can_edit} aria-label={`${name}: ${isVi ? "Sửa" : "Edit"}`}
                        disabled={updatePermission.isPending} onClick={() => handleToggle(u.user_id, mod.key, "can_edit", perm.can_edit)} data-bmq-perm-edit>
                        {isVi ? "Sửa" : "Edit"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="st-panel-actions">
              <button type="button" className="st-link" onClick={() => resetToDefault.mutate({ userId: u.user_id, role: u.role || "viewer" })} disabled={resetToDefault.isPending} data-bmq-perm-reset>
                {resetToDefault.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}{isVi ? `Về mặc định của ${roleLabel(u.role)}` : `Reset to ${roleLabel(u.role)} defaults`}
              </button>
            </div>
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}
