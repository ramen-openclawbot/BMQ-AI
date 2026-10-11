// Stock catalog Jev endpoint (owner or Q7 material inventory editor).
//
// The handler authenticates the caller's token itself. Reads use a service-role
// client with fixed SELECTs/RPCs; the only writes are stock_catalog_suggestions
// rows and the stock_catalog_jev_usage counter. The AI Gateway key is read only
// from the server environment (AI_GATEWAY_API_KEY) and is never forwarded to the
// caller; `BMQ_JEV_KILL_SWITCH=true` refuses the request with 503 before any data
// is read. No merge is ever applied here.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createStockCatalogHandler, StockCatalogError } from "./handler.ts";
import { createJevEvaluator, JEV_TIMEOUT_MS, type JevEvaluator } from "./jev.ts";
import { createStockCatalogStore } from "./store.ts";

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
  if (!serviceRole) throw new StockCatalogError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Owner, or q7_material_inventory / kitchen_inventory edit. */
async function canEditStockCatalog(admin: ReturnType<typeof adminClient>, userId: string): Promise<boolean> {
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

Deno.serve(createStockCatalogHandler({
  killSwitch: () => Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true",
  evaluator: jevEvaluator,
  listCandidates: () => createStockCatalogStore(adminClient()).listCandidates(),
  listExistingMergePairKeys: (promptVersion) =>
    createStockCatalogStore(adminClient()).listExistingMergePairKeys(promptVersion),
  listUnclassifiedItems: (promptVersion) =>
    createStockCatalogStore(adminClient()).listUnclassifiedItems(promptVersion),
  getUsage: (usageDate) => createStockCatalogStore(adminClient()).getUsage(usageDate),
  recordUsage: (usage) => createStockCatalogStore(adminClient()).recordUsage(usage),
  insertSuggestions: (rows) => createStockCatalogStore(adminClient()).insertSuggestions(rows),
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new StockCatalogError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new StockCatalogError("unauthorized", 401);
    const allowed = await canEditStockCatalog(adminClient(), user.id);
    if (!allowed) throw new StockCatalogError("forbidden", 403);
    return { userId: user.id };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
