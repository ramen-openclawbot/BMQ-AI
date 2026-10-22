// kho-review-jev — owner-triggered Jev scoring for the kho review tab.
//
// The caller's JWT is used only to authenticate and to call
// public.kho_review_list() as that user, so the database gate (and its
// kho_review_forbidden error) decides who may review.  The AI Gateway key is
// read only from the server environment and is never forwarded to the caller.
// The service-role client writes suggestions to public.kho_review_jev_marks
// only; this function never links a receipt line and never creates an item.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  createKhoReviewJevHandler,
  pairKey,
  type KhoReviewJevMarkRow,
  type KhoReviewJevReview,
} from "./handler.ts";
import {
  KHO_REVIEW_JEV_PROMPT_VERSION,
  KhoReviewJevError,
  createKhoReviewJevEvaluator,
  type KhoReviewJevEvaluator,
} from "./jev.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

let evaluatorCache: KhoReviewJevEvaluator | null | undefined;
function jevEvaluator(): KhoReviewJevEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createKhoReviewJevEvaluator({ apiKey: key }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new KhoReviewJevError("unconfigured", 503);
  return createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

Deno.serve(createKhoReviewJevHandler({
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new KhoReviewJevError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new KhoReviewJevError("unauthorized", 401);

    // Read the review list as the caller: the RPC enforces the kho edit gate.
    const { data, error: rpcError } = await db.rpc("kho_review_list").abortSignal(signal);
    if (rpcError) {
      if (errorText(rpcError).includes("kho_review_forbidden")) {
        throw new KhoReviewJevError("forbidden", 403);
      }
      throw new KhoReviewJevError("review_failed", 503);
    }
    return {
      userId: user.id,
      review: (data ?? { items: [], materials: [] }) as KhoReviewJevReview,
    };
  },
  evaluator: jevEvaluator,
  listMarkedPairs: async (promptVersion, targetKeys) => {
    const admin = adminClient();
    let query = admin
      .from("kho_review_jev_marks")
      .select("target_key, receipt_item_id")
      .eq("prompt_version", promptVersion);
    if (targetKeys.length > 0) query = query.in("target_key", targetKeys);
    const { data, error } = await query;
    if (error) throw new KhoReviewJevError("store_failed", 503);
    const rows = (data ?? []) as { target_key: string; receipt_item_id: string }[];
    return new Set(rows.map((row) => pairKey(row.target_key, row.receipt_item_id)));
  },
  upsertMarks: async (rows: KhoReviewJevMarkRow[]) => {
    if (rows.length === 0) return;
    const { error } = await adminClient()
      .from("kho_review_jev_marks")
      .upsert(rows, { onConflict: "target_key,receipt_item_id,prompt_version" });
    if (error) throw new KhoReviewJevError("store_failed", 503);
  },
  promptVersion: KHO_REVIEW_JEV_PROMPT_VERSION,
  audit: (event) => console.info(JSON.stringify(event)),
}));
