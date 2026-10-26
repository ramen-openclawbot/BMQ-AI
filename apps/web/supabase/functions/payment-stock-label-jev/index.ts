// Payment request stock label endpoint (pg_cron worker or service role only).
//
// The handler authenticates the caller itself: a valid x-worker-secret is
// matched against public.robot_worker_config, otherwise the Bearer token must
// be the service-role key. Reads use a service-role client with fixed
// SELECTs/RPCs; the only write is the audited
// apply_payment_request_stock_label_jev RPC. The AI Gateway key is read only
// from the server environment (AI_GATEWAY_API_KEY) and is never forwarded to
// the caller. `BMQ_JEV_KILL_SWITCH=true` refuses the request with 503 before
// any settings or candidate is read.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  createStockLabelHandler,
  StockLabelError,
  timingSafeEqual,
} from "./handler.ts";
import {
  createStockLabelEvaluator,
  JEV_TIMEOUT_MS,
  type StockLabelEvaluator,
} from "./jev.ts";
import { createStockLabelStore } from "./store.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

let evaluatorCache: StockLabelEvaluator | null | undefined;
function stockLabelEvaluator(): StockLabelEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createStockLabelEvaluator({ apiKey: key, timeoutMs: JEV_TIMEOUT_MS }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new StockLabelError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(createStockLabelHandler({
  killSwitch: () => Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true",
  evaluator: stockLabelEvaluator,
  getSettings: () => createStockLabelStore(adminClient()).getSettings(),
  countToday: () => createStockLabelStore(adminClient()).countToday(),
  listCandidates: (limit) => createStockLabelStore(adminClient()).listCandidates(limit),
  apply: (input) => createStockLabelStore(adminClient()).apply(input),
  getWorkerSecret: () => createStockLabelStore(adminClient()).getWorkerSecret(),
  authenticate: (request) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new StockLabelError("unauthorized", 401);
    }
    if (serviceRole === "" || !timingSafeEqual(authorization.slice(7), serviceRole)) {
      throw new StockLabelError("forbidden", 403);
    }
    return Promise.resolve({ service: true });
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
