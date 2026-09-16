 
import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Safety timeout: if auth bootstrap takes longer than this, allow fallback UI
const AUTH_BOOTSTRAP_TIMEOUT_MS = 6000;

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
  authzLoaded: boolean;
  authzError: boolean;
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
  const [authzLoaded, setAuthzLoaded] = useState(false);
  const [authzError, setAuthzError] = useState(false);

  // Track if initial load is complete to prevent listener from affecting loading state
  const initialLoadCompleteRef = useRef(false);
  const fetchingProfileForRef = useRef<string | null>(null);
  // Identity whose roles/permissions are currently loaded. A same-user auth
  // event re-checks rights in the background without unmounting module routes;
  // a different identity must not inherit the previous rights.
  const authzUserRef = useRef<string | null>(null);
  // Latest identity observed from an auth event / bootstrap. Guards every async
  // result so a late response from an old identity or an old refresh is dropped.
  const currentUserIdRef = useRef<string | null>(null);
  // Monotonic version of the authoritative auth state. Every auth event, local
  // signOut and unmount bumps it, so a session read that started earlier can
  // never commit a stale identity. A SIGNED_OUT null is a real changed state.
  const authEventSeqRef = useRef(0);
  const authzSeqRef = useRef(0);
  const profileSeqRef = useRef(0);

  // Drop the current identity's authorization and invalidate any in-flight
  // check so a late response cannot restore it.
  const clearIdentityAuthz = useCallback(() => {
    authzUserRef.current = null;
    authzSeqRef.current += 1;
    profileSeqRef.current += 1;
    fetchingProfileForRef.current = null;
    setAuthzLoaded(false);
    setAuthzError(false);
  }, []);

  const isAllowedCompanyEmail = useCallback((email?: string | null) => {
    return String(email || "").trim().toLowerCase().endsWith("@bmq.vn");
  }, []);

  // -------------------------------------------------------------------------
  // Fetch roles + permissions for a user
  //
  // A re-check for the identity whose rights are already loaded runs in the
  // background: authzLoaded stays true so mounted module state (an open KFM
  // form, an in-flight print) is not unmounted by a same-user TOKEN_REFRESHED
  // or SIGNED_IN. Any other identity, or a retry after a failure, is loaded
  // from scratch. A failed check always fails closed so stale rights are not
  // retained, and results are dropped when a newer identity/request superseded
  // them.
  // -------------------------------------------------------------------------
  const fetchRolesAndPermissions = useCallback(async (userId: string, userEmail?: string | null) => {
    const seq = ++authzSeqRef.current;
    const silentRecheck = authzUserRef.current === userId;
    if (!silentRecheck) {
      setAuthzError(false);
      setAuthzLoaded(false);
    }

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
          "dashboard", "finance_cost", "finance_revenue", "crm",
          "sales_po_inbox", "facebook_messenger", "purchase_orders", "production_q7", "production_products", "production_shifts", "production_qa", "inventory", "goods_receipts", "sku_costs",
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

      // Drop responses that a newer identity/request has already replaced.
      if (seq !== authzSeqRef.current || currentUserIdRef.current !== userId) return;

      if (rolesRes.error || permsRes.error) {
        console.error("[AuthContext] Error fetching roles/permissions:", rolesRes.error || permsRes.error);
        // Fail closed: an unverifiable check must not keep serving old rights.
        authzUserRef.current = null;
        setRoles([]);
        setPermissions([]);
        setAuthzError(true);
        setAuthzLoaded(false);
        return;
      }

      setRoles((rolesRes.data || []).map((r: any) => r.role as AppRole));
      setPermissions(
        (permsRes.data || []).map((p: any) => ({
          module_key: p.module_key,
          can_view: !!p.can_view,
          can_edit: !!p.can_edit,
        }))
      );
      authzUserRef.current = userId;
      setAuthzError(false);
      setAuthzLoaded(true);
    } catch (err) {
      console.error("[AuthContext] Error fetching roles/permissions:", err);
      if (seq !== authzSeqRef.current || currentUserIdRef.current !== userId) return;
      authzUserRef.current = null;
      setRoles([]);
      setPermissions([]);
      setAuthzError(true);
      setAuthzLoaded(false);
    }
  }, []);

  const fetchProfile = useCallback(async (userId: string, userEmail?: string | null) => {
    // Debounce: skip if already fetching for this user
    if (fetchingProfileForRef.current === userId) {
      return;
    }
    fetchingProfileForRef.current = userId;
    const seq = ++profileSeqRef.current;
    const superseded = () => seq !== profileSeqRef.current || currentUserIdRef.current !== userId;
    let profileEmail: string | null = null;

    try {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();

        if (superseded()) return;

        if (error) {
          console.error("Error fetching profile:", error);
          setProfile(null);
        } else {
          // No profile row yet is acceptable for newly created users.
          setProfile(data ?? null);
          profileEmail = data?.email ?? null;
        }
      } catch (err) {
        if (superseded()) return;
        console.error("Error fetching profile:", err);
        setProfile(null);
      }

      if (currentUserIdRef.current !== userId) return;
      // Roles/permissions are independent of the profile row, so a failed profile
      // read must still decide authorization (and fail closed if it errors too).
      // The profile email is a fallback for the @bmq.vn auto-provision policy.
      await fetchRolesAndPermissions(userId, userEmail ?? profileEmail);
    } finally {
      // Hold the debounce slot through the rights check too, so a burst of
      // same-user events coalesces into one identity/rights check.
      if (fetchingProfileForRef.current === userId) {
        fetchingProfileForRef.current = null;
      }
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
        // Same monotonic guard as the bootstrap read: a recovery session read
        // must not revive an identity that a newer auth event already replaced
        // (e.g. SIGNED_OUT while this read is pending).
        const watchdogSeq = authEventSeqRef.current;
        try {
          const { data: { session: retrySession } } = await supabase.auth.getSession();
          if (!mounted) return;
          if (authEventSeqRef.current !== watchdogSeq) return;
          if (retrySession?.user) {
            const allowed = isAllowedCompanyEmail(retrySession.user.email);
            if (!allowed) {
              await supabase.auth.signOut();
              clearIdentityAuthz();
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
            if (currentUserIdRef.current !== retrySession.user.id) {
              clearIdentityAuthz();
            }
            currentUserIdRef.current = retrySession.user.id;
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

        // This event is now the authoritative auth state: invalidate any
        // bootstrap/watchdog session read still in flight (null counts).
        authEventSeqRef.current += 1;

        const nextUserId = newSession?.user?.id ?? null;
        const identityChanged = currentUserIdRef.current !== nextUserId;
        currentUserIdRef.current = nextUserId;

        // Update session and user state
        setSession(newSession);
        setUser(newSession?.user ?? null);

        if (newSession?.user) {
          const allowed = isAllowedCompanyEmail(newSession.user.email);
          if (!allowed) {
            console.warn("[AuthContext] Block non-company email:", newSession.user.email);
            await supabase.auth.signOut();
            clearIdentityAuthz();
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

          if (identityChanged) {
            // Never let a new identity inherit the previous identity's rights
            // while its own check is still in flight.
            clearIdentityAuthz();
            setProfile(null);
            setRoles([]);
            setPermissions([]);
          }

          // Fire-and-forget profile fetch for ongoing changes. For the same
          // identity this re-checks rights without unloading module state.
          fetchProfile(newSession.user.id, newSession.user.email ?? null);
        } else {
          clearIdentityAuthz();
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
      const bootstrapSeq = authEventSeqRef.current;
      try {
        const { data: { session: initialSession } } = await supabase.auth.getSession();

        if (!mounted) return;

        // A newer auth event (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED) or a
        // local signOut/unmount happened while this read was in flight: that
        // state is authoritative. Drop the stale read so it cannot revive an
        // identity that already signed out (currentUserIdRef is null then, so
        // an identity-only guard would let it through).
        if (authEventSeqRef.current !== bootstrapSeq) return;

        const initialUserId = initialSession?.user?.id ?? null;
        if (currentUserIdRef.current !== initialUserId) {
          clearIdentityAuthz();
        }
        currentUserIdRef.current = initialUserId;

        setSession(initialSession);
        setUser(initialSession?.user ?? null);

        if (initialSession?.user) {
          const allowed = isAllowedCompanyEmail(initialSession.user.email);
          if (!allowed) {
            await supabase.auth.signOut();
            clearIdentityAuthz();
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
        const isAbortError = err instanceof Error && err.name === "AbortError";
        if (isAbortError) {
          console.warn("[AuthContext] Initial auth aborted, continuing without blocking UI");
        } else {
          console.error("[AuthContext] Error during initial auth:", err);
        }
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
      // Invalidate any bootstrap/watchdog session read still in flight so it
      // cannot commit state after unmount.
      authEventSeqRef.current += 1;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    // Invalidate the identity (and any in-flight session read) before the
    // session is dropped so a late profile/rights/bootstrap response cannot
    // restore the signed-out user.
    authEventSeqRef.current += 1;
    currentUserIdRef.current = null;
    clearIdentityAuthz();
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
      authzLoaded,
      authzError,
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
