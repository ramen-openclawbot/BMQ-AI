// Service-role-only merchant draft guard endpoint.
//
// The merchant-agent host calls this after inserting a staged change. The guard
// is advisory: provider failures return 200 with empty notes so staging is never
// blocked. No caller token is forwarded anywhere; only the dedicated server-side
// AI Gateway key is used for the Jev fallback.

import { JEV_ENDPOINT } from "../bmq-analytics/jev.ts";
import { handleGuardRequest } from "./guard.ts";

const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const gatewayKey = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";

Deno.serve((request: Request) =>
  handleGuardRequest(request, {
    serviceRoleKey,
    gatewayKey,
    gatewayUrl: JEV_ENDPOINT,
    fetcher: fetch,
    env: (name: string) => Deno.env.get(name),
  })
);
