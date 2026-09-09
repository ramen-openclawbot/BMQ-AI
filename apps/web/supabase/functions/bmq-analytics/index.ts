import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { AnalyticsError } from "./core.ts";
import { executeQuery } from "./data.ts";
import { createHandler } from "./handler.ts";
import { openAIModel } from "./service.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
Deno.serve(createHandler({
  enabled: () => Deno.env.get("BMQ_ANALYTICS_ENABLED") === "true",
  warehouse: { enabled: () => Deno.env.get("BMQ_WAREHOUSE_ENABLED") === "true", url: () => Deno.env.get("BMQ_WAREHOUSE_URL") ?? "" },
  model: openAIModel(Deno.env.get("OPENAI_API_KEY") ?? ""),
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new AnalyticsError("unauthorized", 401);
    // Intentionally no service-role client: every analytical read retains the caller's RLS.
    const db = createClient(url, anon, { global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new AnalyticsError("unauthorized", 401);
    const roles = await db.from("user_roles").select("role").eq("user_id", user.id).abortSignal(signal);
    if (roles.error || !roles.data?.some(row => row.role === "owner")) throw new AnalyticsError("forbidden", 403);
    return {
      // Existing BMQ is a single-business deployment; no fictitious tenant column or model-selected tenant.
      scope: { tenant: new URL(url).hostname, user: user.id, permission: "owner:rls:v1" },
      query: (query, abort) => executeQuery(db, query, abort),
    };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
