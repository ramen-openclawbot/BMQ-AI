/**
 * Shared CORS helper for all Supabase Edge Functions.
 * Restricts Access-Control-Allow-Origin to known domains only.
 */

const ALLOWED_ORIGINS: string[] = [
  "https://bmqvn.lovable.app",
  "https://bmq-ai.vercel.app",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
];

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0]; // fallback to primary domain

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret, x-debug-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/** Convenience: return a preflight (OPTIONS) response */
export function corsPreflightResponse(req: Request): Response {
  return new Response(null, { headers: getCorsHeaders(req) });
}
