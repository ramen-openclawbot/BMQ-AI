import { usePeopleLabels } from "@/hooks/usePeopleLabels";
import { showPeopleToast, peopleErrorDescription, peopleToast, usePeopleCopy } from "@/hooks/usePeopleCopy";
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
  type ModulePermissionRow,
} from "@/hooks/useUserManagement";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Users, Shield, Trash2, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Role badge color mapping
// ---------------------------------------------------------------------------
const ROLE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  owner: { label: "Owner", variant: "destructive" },
  staff: { label: "Staff", variant: "default" },
  warehouse: { label: "Warehouse", variant: "secondary" },
  viewer: { label: "Viewer", variant: "outline" },
};

type AppRole = "owner" | "staff" | "viewer" | "warehouse";

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function UserManagement() {
  const pc = usePeopleCopy();
  const { language } = useLanguage();
  const isVi = language === "vi";

  return (
    <div data-i18n-version="d-people-v1" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {pc("userManagement")}
        </h1>
        <p className="text-muted-foreground">
          {pc("manageRolesInviteMembersAssignModulePermissions")}
        </p>
      </div>

      <Tabs defaultValue="users" className="space-y-4">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-4 w-4" />
            {pc("users")}
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-2">
            <Shield className="h-4 w-4" />
            {pc("permissions")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <UsersTab isVi={isVi} />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionsTab isVi={isVi} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ===========================================================================
// TAB 1: Users
// ===========================================================================
function UsersTab({ isVi }: { isVi: boolean }) {
  const labels = usePeopleLabels();
  const pc = usePeopleCopy();
  const { data: users, isLoading } = useUsersList();
  const { user: currentUser } = useAuth();
  const assignRole = useAssignRole();
  const deleteUser = useDeleteUser();

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<UserWithRole | null>(null);

  const handleRoleChange = (targetUser: UserWithRole, newRole: AppRole) => {
    // Guard: cannot change your own role
    if (targetUser.user_id === currentUser?.id) {
      showPeopleToast("error", peopleToast("cannotChangeRole"), {
        description: peopleToast("youCannotChangeYourOwnRole"),
      });
      return;
    }

    // Guard: cannot demote the last owner
    if (targetUser.role === "owner") {
      const ownerCount = (users || []).filter((u) => u.role === "owner").length;
      if (ownerCount <= 1) {
        showPeopleToast("error", peopleToast("cannotChangeRole"), {
          description: peopleToast("thereMustBeAtLeastOneOwner"),
        });
        return;
      }
    }

    assignRole.mutate({ userId: targetUser.user_id, role: newRole });
  };

  const handleDeleteClick = (targetUser: UserWithRole) => {
    // Guard: cannot delete yourself
    if (targetUser.user_id === currentUser?.id) {
      showPeopleToast("error", peopleToast("cannotDelete"), {
        description: peopleToast("youCannotDeleteYourOwnAccount"),
      });
      return;
    }

    // Guard: cannot delete the last owner
    if (targetUser.role === "owner") {
      const ownerCount = (users || []).filter((u) => u.role === "owner").length;
      if (ownerCount <= 1) {
        showPeopleToast("error", peopleToast("cannotDelete"), {
          description: peopleToast("thereMustBeAtLeastOneOwner"),
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
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{pc("userList")}</CardTitle>
          <CardDescription>
            {pc("usersInTheSystem", { p0: (users || []).length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{pc("name")}</TableHead>
                <TableHead>{pc("email")}</TableHead>
                <TableHead>{pc("role")}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users || []).map((u) => {
                const isCurrentUser = u.user_id === currentUser?.id;
                const badge = ROLE_BADGE[u.role || "viewer"];
                return (
                  <TableRow key={u.user_id}>
                    <TableCell className="font-medium">
                      {u.full_name || "—"}
                      {isCurrentUser && (
                        <Badge variant="outline" className="ml-2 text-xs">
                          {pc("you")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.email || "—"}</TableCell>
                    <TableCell>
                      {isCurrentUser ? (
                        <Badge variant={badge?.variant || "outline"}>{labels.role(u.role || "viewer")}</Badge>
                      ) : (
                        <Select
                          value={u.role || "viewer"}
                          onValueChange={(val) => handleRoleChange(u, val as AppRole)}
                          disabled={assignRole.isPending}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">{pc("owner")}</SelectItem>
                            <SelectItem value="staff">{pc("staff")}</SelectItem>
                            <SelectItem value="warehouse">{pc("warehouse")}</SelectItem>
                            <SelectItem value="viewer">{pc("viewer")}</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      {!isCurrentUser && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          aria-label={pc("deleteAccount")}
                          onClick={() => handleDeleteClick(u)}
                          disabled={deleteUser.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pc("deleteUser")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pc("youAreAboutToDeleteThisWill", { p0: deleteTarget?.full_name || deleteTarget?.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{pc("cancel2")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : pc("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ===========================================================================
// TAB 2: Permissions matrix
// ===========================================================================
function PermissionsTab({ isVi }: { isVi: boolean }) {
  const labels = usePeopleLabels();
  const pc = usePeopleCopy();
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
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{pc("modulePermissions")}</CardTitle>
        <CardDescription>
          {pc("ownersAlwaysHaveFullAccessTheTable")}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {nonOwnerUsers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {pc("noNonOwnerUsersToManagePermissions")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background z-10 min-w-[160px]"> {pc("module")} </TableHead>
                {nonOwnerUsers.map((u) => (
                  <TableHead key={u.user_id} className="text-center min-w-[140px]">
                    <div className="space-y-1.5">
                      <div className="font-medium text-xs">{u.full_name || u.email || "—"}</div>
                      <Badge variant={ROLE_BADGE[u.role || "viewer"]?.variant || "outline"} className="text-[10px]">
                        {labels.role(u.role || "viewer")}
                      </Badge>
                      {/* Reset to default button */}
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px] px-1.5 text-muted-foreground hover:text-foreground gap-1"
                          onClick={() => resetToDefault.mutate({ userId: u.user_id, role: u.role || "viewer" })}
                          disabled={resetToDefault.isPending}
                          title={pc("resetToRoleDefaults")}
                        >
                          <RefreshCw className="h-2.5 w-2.5" />
                          {pc("defaults")}
                        </Button>
                      </div>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ALL_MODULES.map((mod) => (
                <TableRow key={mod.key}>
                  <TableCell className="sticky left-0 bg-background z-10 font-medium text-sm">
                    {isVi ? mod.labelVi : mod.labelEn}
                  </TableCell>
                  {nonOwnerUsers.map((u) => {
                    const key = `${u.user_id}::${mod.key}`;
                    const perm = permMap.get(key) || { can_view: false, can_edit: false };
                    return (
                      <TableCell key={u.user_id} className="text-center">
                        <div className="flex items-center justify-center gap-3">
                          <label className="flex items-center gap-1 text-xs cursor-pointer">
                            <Checkbox
                              checked={perm.can_view}
                              onCheckedChange={() =>
                                handleToggle(u.user_id, mod.key, "can_view", perm.can_view)
                              }
                            />
                            <span className="text-muted-foreground">{pc("view")}</span>
                          </label>
                          <label className="flex items-center gap-1 text-xs cursor-pointer">
                            <Checkbox
                              checked={perm.can_edit}
                              onCheckedChange={() =>
                                handleToggle(u.user_id, mod.key, "can_edit", perm.can_edit)
                              }
                            />
                            <span className="text-muted-foreground">{pc("edit")}</span>
                          </label>
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
