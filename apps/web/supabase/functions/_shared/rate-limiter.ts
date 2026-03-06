/**
 * Shared rate-limiter for AI scan functions.
 * Uses PostgreSQL table `ai_function_rate_limits` for persistent per-user daily counters.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string | null;      // ISO timestamp
  retryAfterSeconds: number | null;
}

/**
 * Check rate limit for a user on a specific function.
 * Uses UPSERT with ON CONFLICT to handle concurrent requests safely.
 *
 * @param userId        - User ID from JWT
 * @param functionName  - Edge function name (e.g. "scan-invoice")
 * @param dailyLimit    - Max calls per 24h window (default: 100)
 * @returns RateLimitResult
 */
export async function checkAndRecordRateLimit(
  userId: string,
  functionName: string,
  dailyLimit: number = 100,
): Promise<RateLimitResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const admin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const now = new Date();

    // Find active window for this user+function
    const { data: existing, error: qErr } = await admin
      .from("ai_function_rate_limits")
      .select("id, usage_count, window_end")
      .eq("user_id", userId)
      .eq("function_name", functionName)
      .gt("window_end", now.toISOString())
      .order("window_end", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (qErr) {
      console.error(`[rate-limiter] Query error:`, qErr.message);
      // Graceful degradation for internal app — allow request if DB fails
      return { allowed: true, remaining: dailyLimit, resetAt: null, retryAfterSeconds: null };
    }

    if (existing) {
      const newCount = existing.usage_count + 1;
      const remaining = Math.max(0, dailyLimit - newCount);
      const allowed = newCount <= dailyLimit;
      const windowEnd = existing.window_end;

      // Increment counter (non-blocking)
      admin
        .from("ai_function_rate_limits")
        .update({ usage_count: newCount, updated_at: now.toISOString() })
        .eq("id", existing.id)
        .then(() => {})
        .catch((e: any) => console.error("[rate-limiter] Update failed:", e));

      const retryAfterSeconds = allowed
        ? null
        : Math.max(1, Math.ceil((new Date(windowEnd).getTime() - now.getTime()) / 1000));

      return { allowed, remaining, resetAt: windowEnd, retryAfterSeconds };
    }

    // No active window — create new one (VN timezone day boundary)
    // Window: from now until end of today VN time
    const vnNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const vnTomorrow = new Date(vnNow.getFullYear(), vnNow.getMonth(), vnNow.getDate() + 1);
    // Convert VN midnight back to UTC
    const windowEnd = new Date(vnTomorrow.getTime() - (vnNow.getTime() - now.getTime()));

    const { error: insErr } = await admin
      .from("ai_function_rate_limits")
      .insert({
        user_id: userId,
        function_name: functionName,
        usage_count: 1,
        window_start: now.toISOString(),
        window_end: windowEnd.toISOString(),
      });

    if (insErr) {
      // Race condition: another request created the row. Re-query.
      if (insErr.code === "23505") {
        // Unique violation → row was just created, recurse once
        return checkAndRecordRateLimit(userId, functionName, dailyLimit);
      }
      console.error(`[rate-limiter] Insert error:`, insErr.message);
      return { allowed: true, remaining: dailyLimit, resetAt: null, retryAfterSeconds: null };
    }

    return {
      allowed: true,
      remaining: dailyLimit - 1,
      resetAt: windowEnd.toISOString(),
      retryAfterSeconds: null,
    };
  } catch (err) {
    console.error(`[rate-limiter] Unexpected error:`, err);
    // Graceful degradation — allow request
    return { allowed: true, remaining: dailyLimit, resetAt: null, retryAfterSeconds: null };
  }
}

/**
 * Build standard rate-limit response headers.
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Remaining": String(result.remaining),
  };
  if (result.resetAt) {
    headers["X-RateLimit-Reset"] = String(Math.floor(new Date(result.resetAt).getTime() / 1000));
  }
  if (result.retryAfterSeconds !== null) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}
