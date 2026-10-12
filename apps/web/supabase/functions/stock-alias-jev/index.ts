// Stock-material alias Jev endpoint (Q7 stock editor, or PO / payment editor).
//
// The handler authenticates the caller's token itself. Reads use a service-role
// client with fixed SELECTs/RPCs; the only writes are material_alias_jev_cache
// rows and the shared stock_catalog_jev_usage counter. The AI Gateway key is read
// only from the server environment (AI_GATEWAY_API_KEY) and is never forwarded to
// the caller; `BMQ_JEV_KILL_SWITCH=true` refuses the request with 503 before any
// data is read. No alias is applied here.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createMaterialAliasHandler, MaterialAliasError } from "./handler.ts";
import { createJevEvaluator, JEV_TIMEOUT_MS, type JevEvaluator } from "./jev.ts";
import { createNewItemJevEvaluator, type NewItemJevEvaluator } from "./new-items.ts";
import { createMaterialAliasStore } from "./store.ts";

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

let newItemEvaluatorCache: NewItemJevEvaluator | null | undefined;
function newItemJevEvaluator(): NewItemJevEvaluator | null {
  if (newItemEvaluatorCache !== undefined) return newItemEvaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    newItemEvaluatorCache = key ? createNewItemJevEvaluator({ apiKey: key, timeoutMs: JEV_TIMEOUT_MS }) : null;
  } catch {
    newItemEvaluatorCache = null;
  }
  return newItemEvaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new MaterialAliasError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Owner or Q7 / kitchen inventory editor. */
async function canEditQ7(admin: ReturnType<typeof adminClient>, userId: string): Promise<boolean> {
  const [{ data: roles, error: rolesError }, { data: permissions, error: permissionsError }] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin
      .from("user_module_permissions")
      .select("module_key,can_edit")
      .eq("user_id", userId)
      .in("module_key", ["q7_material_inventory", "kitchen_inventory"]),
  ]);
  if (rolesError || permissionsError) return false;
  if (((roles ?? []) as { role: string }[]).some((row) => row.role === "owner")) return true;
  return ((permissions ?? []) as { can_edit: boolean | null }[]).some((row) => row.can_edit === true);
}

/** Owner, Q7 editor, or a role allowed to write purchase orders / payment requests. */
async function canEditAlias(admin: ReturnType<typeof adminClient>, userId: string): Promise<boolean> {
  const { data: roles, error } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if (error) return false;
  const roleNames = ((roles ?? []) as { role: string }[]).map((row) => row.role);
  if (roleNames.some((role) => role === "owner" || role === "staff" || role === "warehouse")) return true;
  return canEditQ7(admin, userId);
}

Deno.serve(createMaterialAliasHandler({
  killSwitch: () => Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true",
  evaluator: jevEvaluator,
  getCache: (key) => createMaterialAliasStore(adminClient()).getCache(key),
  putCache: (key, answer, cost) => createMaterialAliasStore(adminClient()).putCache(key, answer, cost),
  getUsage: (usageDate) => createMaterialAliasStore(adminClient()).getUsage(usageDate),
  incrementUsage: (usageDate, calls, cost) =>
    createMaterialAliasStore(adminClient()).incrementUsage(usageDate, calls, cost),
  listBacklog: (location, limit) => createMaterialAliasStore(adminClient()).listBacklog(location, limit),
  candidatesFor: (name, location, limit) =>
    createMaterialAliasStore(adminClient()).candidatesFor(name, location, limit),
  catalogOptions: (location) => createMaterialAliasStore(adminClient()).catalogOptions(location),
  listUnmatched: (location, days) => createMaterialAliasStore(adminClient()).listUnmatched(location, days),
  upsertNewItemSuggestions: (location, rows) =>
    createMaterialAliasStore(adminClient()).upsertNewItemSuggestions(location, rows),
  getRawCache: (key) => createMaterialAliasStore(adminClient()).getRawCache(key),
  putRawCache: (key, answer, cost) =>
    createMaterialAliasStore(adminClient()).putRawCache(key, answer, cost),
  getCacheMany: (keys) => createMaterialAliasStore(adminClient()).getCacheMany(keys),
  getRawCacheMany: (keys) => createMaterialAliasStore(adminClient()).getRawCacheMany(keys),
  getActiveNewItemRun: (location) =>
    createMaterialAliasStore(adminClient()).getActiveNewItemRun(location),
  createNewItemRun: (location, startedBy) =>
    createMaterialAliasStore(adminClient()).createNewItemRun(location, startedBy),
  updateNewItemRun: (runId, patch) =>
    createMaterialAliasStore(adminClient()).updateNewItemRun(runId, patch),
  waitUntil: (promise) => {
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (runtime?.waitUntil) runtime.waitUntil(promise);
    else void promise;
  },
  newItemEvaluator: newItemJevEvaluator,
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new MaterialAliasError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new MaterialAliasError("unauthorized", 401);
    const admin = adminClient();
    const allowed = await canEditAlias(admin, user.id);
    if (!allowed) throw new MaterialAliasError("forbidden", 403);
    const q7Editor = await canEditQ7(admin, user.id);
    return { userId: user.id, q7Editor };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
