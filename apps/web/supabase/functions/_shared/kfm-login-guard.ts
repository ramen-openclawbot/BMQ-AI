import type { KfmPasswordLoginGuard } from "./kfm-portal.ts";

/**
 * A password probe must not run from every Edge isolate at once: the partner
 * portal locks accounts after repeated failures. The database guard below
 * leases the password path and starts a shared cooldown before the POST.
 */
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;
const LOGIN_LEASE_MS = 90 * 1000;

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export function createKfmPasswordLoginGuard(
  admin: SupabaseRpcClient,
  options: { guardKey?: string; cooldownMs?: number; leaseMs?: number } = {},
): KfmPasswordLoginGuard {
  const guardKey = options.guardKey ?? "kfm_portal";
  const cooldownSeconds = Math.ceil((options.cooldownMs ?? LOGIN_COOLDOWN_MS) / 1000);
  const leaseSeconds = Math.ceil((options.leaseMs ?? LOGIN_LEASE_MS) / 1000);
  return {
    async acquirePasswordLoginLease() {
      const leaseToken = crypto.randomUUID();
      const { data, error } = await admin.rpc("kfm_login_guard_acquire", {
        p_guard_key: guardKey,
        p_lease_token: leaseToken,
        p_cooldown_seconds: cooldownSeconds,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error("kfm_login_guard_unavailable");
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object" || typeof (row as { acquired?: unknown }).acquired !== "boolean") {
        throw new Error("kfm_login_guard_unavailable");
      }
      const retryAfterSeconds = Math.max(0, Number((row as { retry_after_seconds?: unknown; retryAfterSeconds?: unknown }).retry_after_seconds ?? (row as { retryAfterSeconds?: unknown }).retryAfterSeconds ?? 0) || 0);
      const reason = String((row as { reason?: unknown }).reason || ((row as { acquired: boolean }).acquired ? "acquired" : "cooldown"));
      if (!(row as { acquired: boolean }).acquired) return { acquired: false, retryAfterSeconds, reason };
      const returnedToken = String((row as { lease_token?: unknown; leaseToken?: unknown }).lease_token ?? (row as { leaseToken?: unknown }).leaseToken ?? "");
      if (returnedToken !== leaseToken) throw new Error("kfm_login_guard_unavailable");
      return { acquired: true, leaseToken, retryAfterSeconds, reason };
    },
    async releasePasswordLoginLease(leaseToken: string, outcome: string) {
      const safeOutcome = ["success", "login", "exchange", "sso_form", "error"].includes(outcome)
        ? outcome
        : "error";
      const { data, error } = await admin.rpc("kfm_login_guard_release", {
        p_guard_key: guardKey,
        p_lease_token: leaseToken,
        p_outcome: safeOutcome,
      });
      if (error || data !== true) throw new Error("kfm_login_guard_release_failed");
    },
  };
}
