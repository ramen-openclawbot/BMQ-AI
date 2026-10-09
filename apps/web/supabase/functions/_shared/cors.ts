/**
 * Shared CORS helper for all Supabase Edge Functions.
 * Restricts Access-Control-Allow-Origin to known domains only.
 */

const ALLOWED_ORIGINS: string[] = [
  "https://bmqvn.lovable.app",
  "https://bmq-ai.vercel.app",
  "https://ai.banhmique.vn",
  "https://dathang.banhmique.vn",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
];

const REPORT_PORTAL_ORIGIN = "https://baocao.banhmique.vn";
const REPORT_PORTAL_FUNCTIONS = new Set([
  "report-auth-start",
  "report-auth-verify",
  "report-session",
  "report-bootstrap",
  "report-daily-save",
  "report-auth-logout",
]);

const PAYSLIP_PORTAL_ORIGIN = "https://payroll.banhmique.vn";
const PAYSLIP_PORTAL_FUNCTIONS = new Set([
  "payslip-auth-start",
  "payslip-auth-verify",
  "payslip-list",
  "payslip-auth-logout",
  "payslip-missions",
  "payslip-mission-accept",
]);

function pathSegments(req: Request): string[] {
  return new URL(req.url).pathname.split("/").filter(Boolean);
}

function isReportPortalFunction(req: Request): boolean {
  return pathSegments(req).some((segment) => REPORT_PORTAL_FUNCTIONS.has(segment));
}

function isPayslipPortalFunction(req: Request): boolean {
  return pathSegments(req).some((segment) => PAYSLIP_PORTAL_FUNCTIONS.has(segment));
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  // Each public portal gets its own origin, and only its own functions.
  let allowedOrigins = ALLOWED_ORIGINS;
  if (isReportPortalFunction(req)) {
    allowedOrigins = [...ALLOWED_ORIGINS, REPORT_PORTAL_ORIGIN];
  } else if (isPayslipPortalFunction(req)) {
    allowedOrigins = [...ALLOWED_ORIGINS, PAYSLIP_PORTAL_ORIGIN];
  }
  const allowedOrigin = allowedOrigins.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0]; // fallback to primary domain

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret, x-debug-secret, x-dealer-session, x-report-session, x-region, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/** Convenience: return a preflight (OPTIONS) response */
export function corsPreflightResponse(req: Request): Response {
  return new Response(null, { headers: getCorsHeaders(req) });
}
