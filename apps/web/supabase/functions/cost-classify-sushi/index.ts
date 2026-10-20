// Sushi cost classification endpoint (owner user or the 'sushi-cost' worker).
//
// The handler authenticates the caller itself. A valid x-worker-secret is
// matched against public.robot_worker_config; otherwise the Bearer token is
// validated with auth.getUser and the caller must be an owner. Reads use a
// service-role client with fixed SELECTs/RPCs; the only write is the audited
// robot_apply_cost_classification RPC. The AI Gateway key is read only from the
// server environment (AI_GATEWAY_API_KEY) and is never forwarded to the caller.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createCostClassifyHandler, CostClassifyError } from "./handler.ts";
import { createCostEvaluator, JEV_TIMEOUT_MS, type CostEvaluator } from "./jev.ts";
import { createCostClassifyStore } from "./store.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

let evaluatorCache: CostEvaluator | null | undefined;
function costEvaluator(): CostEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createCostEvaluator({ apiKey: key, timeoutMs: JEV_TIMEOUT_MS }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new CostClassifyError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function isOwner(admin: ReturnType<typeof adminClient>, userId: string): Promise<boolean> {
  const { data, error } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if (error) return false;
  return ((data ?? []) as { role: string }[]).some((row) => row.role === "owner");
}

Deno.serve(createCostClassifyHandler({
  evaluator: costEvaluator,
  getSettings: () => createCostClassifyStore(adminClient()).getSettings(),
  listCategories: () => createCostClassifyStore(adminClient()).listCategories(),
  listCandidates: (limit) => createCostClassifyStore(adminClient()).listCandidates(limit),
  getFeedback: (subjectKeys) => createCostClassifyStore(adminClient()).getFeedback(subjectKeys),
  apply: (input) => createCostClassifyStore(adminClient()).apply(input),
  getWorkerSecret: () => createCostClassifyStore(adminClient()).getWorkerSecret(),
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new CostClassifyError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new CostClassifyError("unauthorized", 401);
    const owner = await isOwner(adminClient(), user.id);
    if (!owner) throw new CostClassifyError("forbidden", 403);
    return { userId: user.id, owner: true };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
