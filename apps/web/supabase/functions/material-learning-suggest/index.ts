// Owner-auth, read-only Material Master learning suggestion endpoint.
//
// Feature flag is default OFF and there is an independent kill switch. Even when
// the flag is on, a missing server-side AI Gateway key keeps the deterministic
// matching usable and returns the bounded shortlist without any provider call.
// The caller bearer token is used only for owner-scoped reads and is never
// forwarded to the model provider; no service-role client is used.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { createMaterialJevEvaluator } from "./material-jev.ts";
import { createMaterialLearningSuggestHandler, type MaterialSuggestIdentity } from "./handler.ts";
import { createMaterialDataSource, type MaterialSourceClient } from "./material-source.ts";
import { MaterialSuggestError, type MaterialEvaluator } from "./material-suggest.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

let evaluatorCache: MaterialEvaluator | null | undefined;
function jevEvaluator(): MaterialEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createMaterialJevEvaluator({ apiKey: key }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

Deno.serve(createMaterialLearningSuggestHandler({
  enabled: () => Deno.env.get("BMQ_MATERIAL_LEARNING_ENABLED") === "true"
    && Deno.env.get("BMQ_MATERIAL_LEARNING_KILL_SWITCH") !== "true",
  evaluator: jevEvaluator,
  authenticate: async (request, signal): Promise<MaterialSuggestIdentity> => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new MaterialSuggestError("unauthorized", 401);
    const db = createClient(url, anon, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new MaterialSuggestError("unauthorized", 401);
    const roles = await db.from("user_roles").select("role").eq("user_id", user.id).abortSignal(signal);
    if (roles.error || !roles.data?.some((row) => row.role === "owner")) throw new MaterialSuggestError("forbidden", 403);
    return { userId: user.id, dataSource: createMaterialDataSource(db as unknown as MaterialSourceClient) };
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
