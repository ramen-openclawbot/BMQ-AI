import { createClient } from "npm:@supabase/supabase-js@2.90.1";

export type MessengerHealthEnv = { META_PAGE_ACCESS_TOKEN?: string; FACEBOOK_MESSENGER_WORKER_SECRET?: string; SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
export type MessengerHealthDeps = { getStatus: () => Promise<Record<string, unknown>> };

const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleMessengerHealth(request: Request, env: MessengerHealthEnv = Deno.env.toObject(), deps?: MessengerHealthDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
  const active = deps ?? createDeps(env);
  let status: Record<string, unknown> = {};
  try { status = await active.getStatus(); } catch { status = { feature_enabled: false, settings_present: false, page_configured: false, can_enqueue: false }; }
  return jsonResponse({
    feature_enabled: Boolean(status.feature_enabled),
    settings_present: Boolean(status.settings_present),
    page_configured: Boolean(status.page_configured),
    can_enqueue: Boolean(status.can_enqueue),
    token_present: Boolean(env.META_PAGE_ACCESS_TOKEN),
    worker_secret_present: Boolean(env.FACEBOOK_MESSENGER_WORKER_SECRET),
  });
}

function createDeps(env: MessengerHealthEnv): MessengerHealthDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    getStatus: async () => {
      const { data, error } = await admin.rpc("facebook_messenger_health_status");
      if (error) throw error;
      return data || {};
    },
  };
}

if (import.meta.main) Deno.serve((request) => handleMessengerHealth(request));
