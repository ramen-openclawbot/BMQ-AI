// Owner-only VNAgent data-assets admin endpoint (future admin.vnagent.ai).
//
// Feature flag is default OFF. Authentication mirrors the existing BMQ owner
// convention: the caller's bearer token is verified, then user_roles is read
// with the caller's own RLS to confirm the owner role. The same caller-scoped
// client backs every dataset read/write, so row level security is the final
// authority. No service-role client is used here.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createDataAdminHandler, type DataAdminIdentity } from "./handler.ts";
import { DataAdminError } from "./data-assets.ts";
import { createDataAdminStore } from "./store.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(createDataAdminHandler({
  enabled: () => Deno.env.get("VNAGENT_DATA_ADMIN_ENABLED") === "true",
  authenticate: async (request, signal): Promise<DataAdminIdentity> => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new DataAdminError("unauthorized", 401);
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new DataAdminError("unauthorized", 401);
    const roles = await db.from("user_roles").select("role").eq("user_id", user.id).abortSignal(signal);
    if (roles.error) throw new DataAdminError("store_unavailable", 503);
    if (!roles.data?.some((row) => row.role === "owner")) throw new DataAdminError("forbidden", 403);
    return { userId: user.id, role: "owner", store: createDataAdminStore(db) };
  },
  now: () => new Date(),
  // Honest capture status for the overview: the analytics capture flag can be on
  // while the dataset is still empty, and off while old rows exist.
  captureEnabled: () => Deno.env.get("VNAGENT_CAPTURE_ENABLED") === "true",
  audit: (event) => console.info(JSON.stringify(event)),
}));
