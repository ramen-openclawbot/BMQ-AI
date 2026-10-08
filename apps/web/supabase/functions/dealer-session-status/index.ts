import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractDealerSessionToken,
  jsonResponse,
  readJsonBody,
  resolveDealerSessionWithLock,
} from "../_shared/dealer.ts";
import { dealerOrderLockedResponseBody } from "../_shared/dealer-order-lock.ts";

// Lightweight session probe for the dealer portal. It performs no writes beyond
// the last_seen_at touch already done by resolveDealerSession.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<Record<string, unknown>>(req) : {};
    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);

    if (!token) {
      return errorResponse(req, "dealer_session_invalid", 401, "dealer_session_invalid");
    }

    const resolution = await resolveDealerSessionWithLock(supabase, token);
    if (resolution?.locked) {
      return jsonResponse(req, dealerOrderLockedResponseBody(), 423);
    }

    if (!resolution?.session) {
      return errorResponse(req, "dealer_session_invalid", 401, "dealer_session_invalid");
    }

    return jsonResponse(req, { ok: true });
  } catch (error) {
    console.error("[dealer-session-status] Unexpected error", error);
    return errorResponse(req, "Không kiểm tra được phiên đại lý.", 500, "dealer_session_status_failed");
  }
});
