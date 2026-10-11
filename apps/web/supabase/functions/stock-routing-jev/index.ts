// Stock routing Jev endpoint (owner or Q7 stock editor only).
//
// The handler authenticates the caller's token itself. Reads use a service-role
// client with fixed SELECTs/RPCs; the only writes are supplier_routing_suggestions
// / material_category_suggestions rows, the shared stock_catalog_jev_usage
// counter and the two routing RPCs that apply an approved suggestion. The AI
// Gateway key is read only from the server environment (AI_GATEWAY_API_KEY) and
// is never forwarded to the caller; `BMQ_JEV_KILL_SWITCH=true` refuses the
// request with 503 before any data is read.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createStockRoutingHandler, StockRoutingError } from "./handler.ts";
import { createJevEvaluator, JEV_TIMEOUT_MS, type JevEvaluator } from "./jev.ts";
import { createStockRoutingStore } from "./store.ts";

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
  if (!serviceRole) throw new StockRoutingError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Owner or Q7 / kitchen inventory editor (same rule as material_alias_can_admin). */
async function canAdmin(admin: ReturnType<typeof adminClient>, userId: string): Promise<boolean> {
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

Deno.serve(createStockRoutingHandler({
  killSwitch: () => Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true",
  evaluator: jevEvaluator,
  getUsage: (usageDate) => createStockRoutingStore(adminClient()).getUsage(usageDate),
  recordUsage: (usage) => createStockRoutingStore(adminClient()).recordUsage(usage),
  listSupplierCandidates: (promptVersion, limit) =>
    createStockRoutingStore(adminClient()).listSupplierCandidates(promptVersion, limit),
  putSupplierSuggestion: (input) => createStockRoutingStore(adminClient()).putSupplierSuggestion(input),
  applySupplierRouting: (supplierId, location, source, suggestionId) =>
    createStockRoutingStore(adminClient()).applySupplierRouting(supplierId, location, source, suggestionId),
  listMaterialCandidates: (promptVersion, limit) =>
    createStockRoutingStore(adminClient()).listMaterialCandidates(promptVersion, limit),
  listCategories: () => createStockRoutingStore(adminClient()).listCategories(),
  putMaterialSuggestion: (input) => createStockRoutingStore(adminClient()).putMaterialSuggestion(input),
  decideMaterialCategory: (suggestionId, action) =>
    createStockRoutingStore(adminClient()).decideMaterialCategory(suggestionId, action),
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new StockRoutingError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new StockRoutingError("unauthorized", 401);
    const admin = adminClient();
    const allowed = await canAdmin(admin, user.id);
    if (!allowed) throw new StockRoutingError("forbidden", 403);
    return { userId: user.id, admin: true };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
