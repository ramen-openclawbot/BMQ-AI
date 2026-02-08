import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Safety timeout: if auth bootstrap takes longer than this, allow fallback UI
const AUTH_BOOTSTRAP_TIMEOUT_MS = 20000;

interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  timedOut: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  
  // Track if initial load is complete to prevent listener from affecting loading state
  const initialLoadCompleteRef = useRef(false);
  const fetchingProfileForRef = useRef<string | null>(null);

  const fetchProfile = useCallback(async (userId: string) => {
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
        .single();
      if (error) {
        console.error("Error fetching profile:", error);
        setProfile(null);
      } else {
        setProfile(data);
      }
    } catch (err) {
      console.error("Error fetching profile:", err);
      setProfile(null);
    } finally {
      fetchingProfileForRef.current = null;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user?.id) {
      await fetchProfile(user.id);
    }
  }, [user?.id, fetchProfile]);

  useEffect(() => {
    let mounted = true;

    // Watchdog: if loading takes too long, stop spinner and allow recovery UI
    const timeoutId = setTimeout(async () => {
      if (mounted && loading) {
        console.warn("[AuthContext] Auth bootstrap timed out after", AUTH_BOOTSTRAP_TIMEOUT_MS, "ms");
        try {
          const { data: { session: retrySession } } = await supabase.auth.getSession();
          if (retrySession?.user) {
            setSession(retrySession);
            setUser(retrySession.user);
            await fetchProfile(retrySession.user.id);
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
          // Fire-and-forget profile fetch for ongoing changes
          fetchProfile(newSession.user.id);
        } else {
          setProfile(null);
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
          // AWAIT profile fetch during initial load to ensure data is ready
          await fetchProfile(initialSession.user.id);
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

    initializeAuth();

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
    window.location.href = "/auth";
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      profile, 
      loading, 
      timedOut,
      signOut, 
      refreshProfile
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
