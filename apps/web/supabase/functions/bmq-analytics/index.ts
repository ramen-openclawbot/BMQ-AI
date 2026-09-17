import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { AnalyticsError } from "./core.ts";
import { COST_CONTEXT_MIN_SECRET_LENGTH } from "./context.ts";
import { executeQuery } from "./data.ts";
import { createHandler } from "./handler.ts";
import { openAIModel } from "./service.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
// Dedicated server-side signing secret for the bounded conversation state. It is
// never the caller bearer token or any client-known value. When it is absent or
// too short the context stays disabled (fail closed) even if the flag is on, and
// the value is never logged or echoed.
const contextSecret = Deno.env.get("BMQ_CHAT_CONTEXT_SECRET") ?? "";
const contextSecretReady = contextSecret.length >= COST_CONTEXT_MIN_SECRET_LENGTH;
Deno.serve(createHandler({
  enabled: () => Deno.env.get("BMQ_ANALYTICS_ENABLED") === "true",
  warehouse: { enabled: () => Deno.env.get("BMQ_WAREHOUSE_ENABLED") === "true", url: () => Deno.env.get("BMQ_WAREHOUSE_URL") ?? "" },
  // Rollbackable: default off keeps the legacy chat flow; enabling also requires
  // the coordinator-provisioned BMQ_CHAT_CONTEXT_SECRET.
  context: { enabled: () => Deno.env.get("BMQ_CHAT_CONTEXT_ENABLED") === "true" && contextSecretReady },
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
      // A token refresh keeps the same user id and the same server secret, so the
      // conversation scope survives a refresh instead of being lost.
      ...(contextSecretReady ? { signingSecret: contextSecret } : {}),
      query: (query, abort) => executeQuery(db, query, abort),
    };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
