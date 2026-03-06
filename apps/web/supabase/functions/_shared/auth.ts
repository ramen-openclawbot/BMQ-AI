/**
 * Shared auth helpers for Supabase Edge Functions.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Validate JWT from Authorization header and return the user.
 * Throws a Response (401) if invalid.
 */
export async function requireAuth(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<{ user: any; token: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response(
      JSON.stringify({ error: "Missing or invalid Authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    throw new Response(
      JSON.stringify({ error: "Invalid or expired token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return { user, token };
}

/**
 * Validate cron secret from x-cron-secret header.
 * Fails hard if env var is missing (prevents misconfiguration).
 */
export function requireCronSecret(
  req: Request,
  envKey: string,
  corsHeaders: Record<string, string>
): void {
  const secret = Deno.env.get(envKey);
  if (!secret) {
    console.error(`[auth] CRITICAL: ${envKey} environment variable is NOT set.`);
    throw new Response(
      JSON.stringify({ error: `Server misconfigured: ${envKey} not set` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const token = req.headers.get("x-cron-secret");
  if (token !== secret) {
    throw new Response(
      JSON.stringify({ error: "Unauthorized: invalid cron secret" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
