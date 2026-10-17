import { createServiceClient } from "./dealer.ts";
import { refreshZaloOaAccessToken } from "./dealer-warehouse-notification.ts";

// Shared Zalo OA access-token resolver for the server-only Zalo workers.
//
// This is a copy of the token logic that finance-zalo-notify/index.ts keeps
// inlined (readZaloTokenState, validStoredAccessToken, the OAuth refresh lock and
// persistence to dealer_notification_worker_config id 'warehouse-zalo'). The
// finance worker is intentionally left byte-identical; new workers import this
// module instead of duplicating the refresh flow again.

type SupabaseClient = ReturnType<typeof createServiceClient>;

type ZaloTokenState = {
  zalo_access_token: string | null;
  zalo_refresh_token: string | null;
  zalo_access_token_expires_at: string | null;
};

const readZaloTokenState = async (supabase: SupabaseClient): Promise<ZaloTokenState> => {
  const { data, error } = await supabase
    .from("dealer_notification_worker_config")
    .select("zalo_access_token,zalo_refresh_token,zalo_access_token_expires_at")
    .eq("id", "warehouse-zalo")
    .single();
  if (error) throw new Error(`Unable to read Zalo token state: ${error.message}`);
  return data as ZaloTokenState;
};

const validStoredAccessToken = (state: ZaloTokenState): string | null => {
  const expiresAtMs = Date.parse(String(state.zalo_access_token_expires_at || ""));
  const token = String(state.zalo_access_token || "").trim();
  return token && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 5 * 60_000 ? token : null;
};

const releaseRefreshLock = async (supabase: SupabaseClient, lockId: string) => {
  const { error } = await supabase.rpc("release_zalo_oauth_refresh_lock", { p_lock_id: lockId });
  if (error) console.error("[zalo-oa-token] Could not release OAuth refresh lock", error.message);
};

export const resolveZaloAccessToken = async (supabase: SupabaseClient): Promise<string> => {
  const initialState = await readZaloTokenState(supabase);
  const storedToken = validStoredAccessToken(initialState);
  if (storedToken) return storedToken;

  const appId = Deno.env.get("ZALO_OA_APP_ID") || "";
  const appSecret = Deno.env.get("ZALO_OA_APP_SECRET") || "";
  const environmentRefreshToken = Deno.env.get("ZALO_OA_REFRESH_TOKEN") || "";
  const staticAccessToken = Deno.env.get("ZALO_OA_ACCESS_TOKEN") || "";
  if (!appId || !appSecret || (!initialState.zalo_refresh_token && !environmentRefreshToken)) {
    if (staticAccessToken) return staticAccessToken;
    throw new Error("Zalo OA credentials are not configured");
  }

  const lockId = crypto.randomUUID();
  const { data: lockClaimed, error: lockError } = await supabase.rpc("claim_zalo_oauth_refresh_lock", {
    p_lock_id: lockId,
  });
  if (lockError) throw new Error(`Unable to claim Zalo OAuth refresh lock: ${lockError.message}`);

  if (!lockClaimed) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshedByPeer = validStoredAccessToken(await readZaloTokenState(supabase));
      if (refreshedByPeer) return refreshedByPeer;
    }
    throw new Error("Zalo OA token refresh is already in progress");
  }

  try {
    const lockedState = await readZaloTokenState(supabase);
    const tokenRefreshedBeforeLock = validStoredAccessToken(lockedState);
    if (tokenRefreshedBeforeLock) return tokenRefreshedBeforeLock;

    const refreshToken = String(lockedState.zalo_refresh_token || environmentRefreshToken).trim();
    const refreshed = await refreshZaloOaAccessToken({ appId, appSecret, refreshToken });
    const expiresAt = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();
    let lastPersistError = "unknown_error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("dealer_notification_worker_config")
        .update({
          zalo_access_token: refreshed.accessToken,
          zalo_refresh_token: refreshed.refreshToken,
          zalo_access_token_expires_at: expiresAt,
          zalo_refresh_lock_id: null,
          zalo_refresh_locked_at: null,
        })
        .eq("id", "warehouse-zalo")
        .eq("zalo_refresh_lock_id", lockId)
        .select("id")
        .maybeSingle();
      if (!error && data) return refreshed.accessToken;
      lastPersistError = error?.message || "refresh_lock_lost";
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error(`Unable to persist refreshed Zalo token: ${lastPersistError}`);
  } finally {
    await releaseRefreshLock(supabase, lockId);
  }
};
