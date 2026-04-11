import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Safety timeout: if auth bootstrap takes longer than this, allow fallback UI
const AUTH_BOOTSTRAP_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type AppRole = "owner" | "staff" | "viewer" | "warehouse";

interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
}

interface ModulePermission {
  module_key: string;
  can_view: boolean;
  can_edit: boolean;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  timedOut: boolean;
  roles: AppRole[];
  isOwner: boolean;
  canAccessModule: (moduleKey: string) => boolean;
  canEditModule: (moduleKey: string) => boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshRoles: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [permissions, setPermissions] = useState<ModulePermission[]>([]);

  // Track if initial load is complete to prevent listener from affecting loading state
  const initialLoadCompleteRef = useRef(false);
  const fetchingProfileForRef = useRef<string | null>(null);

  const isAllowedCompanyEmail = useCallback((email?: string | null) => {
    return String(email || "").trim().toLowerCase().endsWith("@bmq.vn");
  }, []);

  // -------------------------------------------------------------------------
  // Fetch roles + permissions for a user
  // -------------------------------------------------------------------------
  const fetchRolesAndPermissions = useCallback(async (userId: string, userEmail?: string | null) => {
    try {
      let [rolesRes, permsRes] = await Promise.all([
        (supabase as any)
          .from("user_roles")
          .select("role")
          .eq("user_id", userId),
        (supabase as any)
          .from("user_module_permissions")
          .select("module_key,can_view,can_edit")
          .eq("user_id", userId),
      ]);

      // Fallback auto-provision for @bmq.vn accounts (if migration/trigger not applied yet)
      const normalizedEmail = String(userEmail || "").trim().toLowerCase();
      const isBmqEmail = normalizedEmail.endsWith("@bmq.vn");
      const hasAnyRole = (rolesRes.data || []).length > 0;

      if (isBmqEmail && !hasAnyRole && !rolesRes.error) {
        await (supabase as any).from("user_roles").insert({ user_id: userId, role: "viewer" });

        const viewerRows = [
          "dashboard", "reports", "niraan_dashboard", "finance_cost", "finance_revenue", "crm",
          "sales_po_inbox", "purchase_orders", "inventory", "goods_receipts", "sku_costs",
          "suppliers", "invoices", "payment_requests", "low_stock", "settings",
        ].map((moduleKey) => ({
          user_id: userId,
          module_key: moduleKey,
          can_view: ["dashboard", "inventory", "low_stock", "settings"].includes(moduleKey),
          can_edit: false,
        }));

        await (supabase as any)
          .from("user_module_permissions")
          .upsert(viewerRows, { onConflict: "user_id,module_key" });

        [rolesRes, permsRes] = await Promise.all([
          (supabase as any).from("user_roles").select("role").eq("user_id", userId),
          (supabase as any)
            .from("user_module_permissions")
            .select("module_key,can_view,can_edit")
            .eq("user_id", userId),
        ]);
      }

      if (rolesRes.error) {
        console.error("[AuthContext] Error fetching roles:", rolesRes.error);
      } else {
        setRoles((rolesRes.data || []).map((r: any) => r.role as AppRole));
      }

      if (permsRes.error) {
        console.error("[AuthContext] Error fetching permissions:", permsRes.error);
      } else {
        setPermissions(
          (permsRes.data || []).map((p: any) => ({
            module_key: p.module_key,
            can_view: !!p.can_view,
            can_edit: !!p.can_edit,
          }))
        );
      }
    } catch (err) {
      console.error("[AuthContext] Error fetching roles/permissions:", err);
    }
  }, []);

  const fetchProfile = useCallback(async (userId: string, userEmail?: string | null) => {
    // Debounce: skip if already fetching for this user
    if (fetchingProfileForRef.current === userId) {
      return;
    }
    fetchingProfileForRef.current = userId;

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("Error fetching profile:", error);
        setProfile(null);
      } else {
        // No profile row yet is acceptable for newly created users.
        setProfile(data ?? null);
      }

      // Also fetch roles and permissions
      await fetchRolesAndPermissions(userId, userEmail ?? data?.email ?? null);
    } catch (err) {
      console.error("Error fetching profile:", err);
      setProfile(null);
    } finally {
      fetchingProfileForRef.current = null;
    }
  }, [fetchRolesAndPermissions]);

  const refreshProfile = useCallback(async () => {
    if (user?.id) {
      await fetchProfile(user.id, user?.email ?? null);
    }
  }, [user?.id, user?.email, fetchProfile]);

  const refreshRoles = useCallback(async () => {
    if (user?.id) {
      await fetchRolesAndPermissions(user.id, user?.email ?? null);
    }
  }, [user?.id, user?.email, fetchRolesAndPermissions]);

  // -------------------------------------------------------------------------
  // Derived: isOwner, canAccessModule, canEditModule
  // -------------------------------------------------------------------------
  const isOwner = roles.includes("owner");

  const canAccessModule = useCallback(
    (moduleKey: string) => {
      if (isOwner) return true;
      // No permission rows = no access (secure by default)
      const perm = permissions.find((p) => p.module_key === moduleKey);
      return perm?.can_view ?? false;
    },
    [isOwner, permissions]
  );

  const canEditModule = useCallback(
    (moduleKey: string) => {
      if (isOwner) return true;
      const perm = permissions.find((p) => p.module_key === moduleKey);
      return perm?.can_edit ?? false;
    },
    [isOwner, permissions]
  );

  useEffect(() => {
    let mounted = true;
    const isAuthRoute = window.location.pathname === "/auth";
    const isOAuthCallback = isAuthRoute && (window.location.search.includes("code=") || window.location.hash.includes("access_token") || window.location.search.includes("error=") || window.location.hash.includes("error="));

    // Watchdog: if loading takes too long, stop spinner and allow recovery UI
    const timeoutId = setTimeout(async () => {
      if (mounted && loading) {
        console.warn("[AuthContext] Auth bootstrap timed out after", AUTH_BOOTSTRAP_TIMEOUT_MS, "ms");
        try {
          const { data: { session: retrySession } } = await supabase.auth.getSession();
          if (retrySession?.user) {
            const allowed = isAllowedCompanyEmail(retrySession.user.email);
            if (!allowed) {
              await supabase.auth.signOut();
              setSession(null);
              setUser(null);
              setProfile(null);
              setRoles([]);
              setPermissions([]);
              setTimedOut(false);
              setLoading(false);
              initialLoadCompleteRef.current = true;
              if (window.location.pathname !== "/auth") {
                window.location.href = "/auth?error=company_email_only";
              }
              return;
            }

            setSession(retrySession);
            setUser(retrySession.user);
            await fetchProfile(retrySession.user.id, retrySession.user.email ?? null);
            setTimedOut(false);
            setLoading(false);
            initialLoadCompleteRef.current = true;
            return;
          }
        } catch (err) {
          console.error("[AuthContext] Retry auth failed:", err);
        }
        setTimedOut(true);
        setLoading(false);
        initialLoadCompleteRef.current = true;
      }
    }, AUTH_BOOTSTRAP_TIMEOUT_MS);

    // 1. Setup listener FIRST - handles ONGOING changes only (token refresh, logout, etc.)
    // This listener does NOT control loading state
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (!mounted) return;

        // Update session and user state
        setSession(newSession);
        setUser(newSession?.user ?? null);

        if (newSession?.user) {
          const allowed = isAllowedCompanyEmail(newSession.user.email);
          if (!allowed) {
            console.warn("[AuthContext] Block non-company email:", newSession.user.email);
            await supabase.auth.signOut();
            setProfile(null);
            setRoles([]);
            setPermissions([]);
            setSession(null);
            setUser(null);
            if (window.location.pathname !== "/auth") {
              window.location.href = "/auth?error=company_email_only";
            }
            return;
          }

          // Fire-and-forget profile fetch for ongoing changes
          fetchProfile(newSession.user.id, newSession.user.email ?? null);
        } else {
          setProfile(null);
          setRoles([]);
          setPermissions([]);
        }

        // Only clear timeout and update loading if initial load hasn't completed yet
        // This prevents ongoing auth events from affecting loading state after initial load
        if (!initialLoadCompleteRef.current) {
          clearTimeout(timeoutId);
          setTimedOut(false);
          setLoading(false);
          initialLoadCompleteRef.current = true;
        }
      }
    );

    // 2. Initial load - this is the primary source for setting loading = false
    const initializeAuth = async () => {
      try {
        const { data: { session: initialSession } } = await supabase.auth.getSession();

        if (!mounted) return;

        setSession(initialSession);
        setUser(initialSession?.user ?? null);

        if (initialSession?.user) {
          const allowed = isAllowedCompanyEmail(initialSession.user.email);
          if (!allowed) {
            await supabase.auth.signOut();
            setSession(null);
            setUser(null);
            setProfile(null);
            setRoles([]);
            setPermissions([]);
            if (window.location.pathname !== "/auth") {
              window.location.href = "/auth?error=company_email_only";
            }
            return;
          }

          // AWAIT profile fetch during initial load to ensure data is ready
          await fetchProfile(initialSession.user.id, initialSession.user.email ?? null);
        }
      } catch (err) {
        console.error("[AuthContext] Error during initial auth:", err);
      } finally {
        if (mounted && !initialLoadCompleteRef.current) {
          clearTimeout(timeoutId);
          setTimedOut(false);
          setLoading(false);
          initialLoadCompleteRef.current = true;
        }
      }
    };

    if (isOAuthCallback) {
      // Avoid racing Auth.tsx / Supabase URL session detection during OAuth callback.
      // Let the callback page finish first, then auth state listener will update session.
      setLoading(false);
      initialLoadCompleteRef.current = true;
    } else {
      initializeAuth();
    }

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn("SignOut error:", err);
    }

    setSession(null);
    setUser(null);
    setProfile(null);
    setRoles([]);
    setPermissions([]);
    window.location.href = "/auth";
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      profile,
      loading,
      timedOut,
      roles,
      isOwner,
      canAccessModule,
      canEditModule,
      signOut,
      refreshProfile,
      refreshRoles,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
