// Owner-only finance Jev duplicate scan endpoint.
//
// The handler authenticates the caller's token itself and requires the "owner"
// role. Reads use a service-role client with fixed SELECTs; the only write is
// the `run`-mode upsert of the Jev result, which never overwrites a CEO review.
// The AI Gateway key is read only from the server environment (AI_GATEWAY_API_KEY)
// and is never forwarded to the caller; `BMQ_JEV_KILL_SWITCH=true` refuses the
// request with 503 before any data is read.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createJevScanHandler, JevScanError } from "./handler.ts";
import { createJevEvaluator, JEV_TIMEOUT_MS, type JevEvaluator } from "./jev.ts";
import { createServiceDataSource, createServiceSink } from "./store.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

let evaluatorCache: JevEvaluator | null | undefined;
function jevEvaluator(): JevEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createJevEvaluator({ apiKey: key, timeoutMs: JEV_TIMEOUT_MS }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new JevScanError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(createJevScanHandler({
  killSwitch: () => Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true",
  evaluator: jevEvaluator,
  dataSource: () => createServiceDataSource(adminClient()),
  sink: () => createServiceSink(adminClient()),
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new JevScanError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new JevScanError("unauthorized", 401);
    const roles = await db.from("user_roles").select("role").eq("user_id", user.id).abortSignal(signal);
    if (roles.error || !roles.data?.some((row) => row.role === "owner")) {
      throw new JevScanError("forbidden", 403);
    }
    return { userId: user.id };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
