import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { AnalyticsError } from "./core.ts";
import { COST_CONTEXT_MIN_SECRET_LENGTH } from "./context.ts";
import { executeQuery } from "./data.ts";
import { createHandler } from "./handler.ts";
import { buildInteractionRecord, buildJevRow, type CaptureEvent } from "./interaction-log.ts";
import { openAIModel } from "./service.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

// Interaction capture is the only service-role use in this function. It calls
// the single atomic RPC `vnagent_capture_chat`, which writes the interaction,
// its initial raw dataset asset and the Jev telemetry in one transaction and is
// idempotent on retry (so a retry recovers a partially captured asset). The RPC
// is executable by service_role only. Analytical reads above still keep the
// caller's RLS.
//
// Capture runs under its own bounded deadline so it can never consume the
// business request budget or fail a successfully computed reply: the handler
// catches every throw and audits it instead of changing the response.
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const captureEnabled = Deno.env.get("VNAGENT_CAPTURE_ENABLED") === "true";
const CAPTURE_BUDGET_MS = 5000;

async function captureInteraction(event: CaptureEvent): Promise<void> {
  if (!captureEnabled) throw new Error("capture_disabled");
  if (!serviceRole) throw new Error("capture_unconfigured");
  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const row = await buildInteractionRecord(event);
  const jev = buildJevRow(event);
  const timeout = AbortSignal.timeout(CAPTURE_BUDGET_MS);
  const signal = event.signal ? AbortSignal.any([event.signal, timeout]) : timeout;
  const { error } = await admin
    .rpc("vnagent_capture_chat", { p_interaction: row, p_jev: jev })
    .abortSignal(signal);
  if (error) throw new Error("capture_write_failed");
}
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
  // Selective Jev routing stays default off. `BMQ_JEV_KILL_SWITCH=true` is an
  // independent immediate kill switch that forces Jev off even when the rollout flag
  // is on. When the flag is on but the server-only gateway key is absent, Jev is
  // skipped (fail closed) and the planner is unchanged. The key is never the caller
  // bearer token and is never logged or echoed.
  jev: {
    enabled: () => Deno.env.get("BMQ_JEV_ENABLED") === "true" && Deno.env.get("BMQ_JEV_KILL_SWITCH") !== "true",
    apiKey: () => Deno.env.get("AI_GATEWAY_API_KEY") ?? "",
  },
  model: openAIModel(Deno.env.get("OPENAI_API_KEY") ?? ""),
  // Only wire capture when the flag is on, so a disabled pipeline does not emit
  // fake capture-failure audits on every chat. When the flag is on but the
  // service-role key is absent, capture throws and is audited honestly.
  capture: captureEnabled ? captureInteraction : undefined,
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
