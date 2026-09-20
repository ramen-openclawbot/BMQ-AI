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
import { DEFAULT_GENERATION_MODEL, generationApiKey } from "./generation.ts";
import { verifiedGenerationPricing, type GenerationPricing } from "./generation-pricing.ts";
import { createGenerationClient } from "./generation-client.ts";
import { createDataAdminStore } from "./store.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;

// Generation is default OFF and uses ONLY the dedicated server-only DeepSeek key.
// Pricing comes from the VERIFIED official DeepSeek price list entry for the
// configured model (no invented env placeholder): when the model is not in the
// reviewed price list AND no explicit override is configured, the action fails
// closed before any paid call. The caller bearer token is never used as the model
// credential, and the Jev/Vercel Gateway key is never a fallback.
const generateEnabled = Deno.env.get("VNAGENT_GENERATE_ENABLED") === "true";
const deepseekKey = generationApiKey(Deno.env);
const generationModel = Deno.env.get("VNAGENT_GENERATE_MODEL") ?? DEFAULT_GENERATION_MODEL;
function generationPricing(): GenerationPricing | null {
  // An explicit, complete server-side override is honoured but recorded as an
  // override; otherwise the reviewed official DeepSeek price is used.
  const inputRaw = Deno.env.get("VNAGENT_GENERATE_INPUT_USD_PER_1K");
  const outputRaw = Deno.env.get("VNAGENT_GENERATE_OUTPUT_USD_PER_1K");
  if (inputRaw !== undefined && outputRaw !== undefined) {
    const input = Number(inputRaw);
    const output = Number(outputRaw);
    if (Number.isFinite(input) && input > 0 && Number.isFinite(output) && output > 0) {
      return {
        inputPer1kUsd: input,
        outputPer1kUsd: output,
        cachedInputPer1kUsd: input,
        provenance: { source: "env_override", env: ["VNAGENT_GENERATE_INPUT_USD_PER_1K", "VNAGENT_GENERATE_OUTPUT_USD_PER_1K"] },
      };
    }
    return null;
  }
  return verifiedGenerationPricing(generationModel);
}

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
  generate: generateEnabled && deepseekKey
    ? createGenerationClient({ apiKey: deepseekKey, model: generationModel, prices: generationPricing() })
    : undefined,
  generationModel: () => generationModel,
  generationPricing,
  audit: (event) => console.info(JSON.stringify(event)),
}));
