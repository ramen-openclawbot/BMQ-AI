import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { KFM_EMAIL_RETIRED } from "../_shared/kfm-po-source.ts";

// Retired after the approved portal-only cutover. Keep a clear response for old
// callers; do not read Gmail, promote historical mail, or mutate any PO.
serve((req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  return new Response(JSON.stringify(KFM_EMAIL_RETIRED), {
    status: 410,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
});
