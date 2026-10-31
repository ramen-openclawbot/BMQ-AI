// dispatch-report-jev — classify saved dispatch-report photos with Jev.
//
// The caller's JWT is used only to authenticate and to call
// public.dispatch_report_save()/kfm_daily_delivery_report() as that user, so the
// database gate decides who may save and view. The AI Gateway key and the
// service-role key are read only from the server environment; neither is ever
// returned to the caller. Signed photo URLs live for a few minutes inside this
// function and are never included in the response.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  createDispatchReportJevHandler,
  type DispatchReportJevCaller,
  type DispatchReportJevMark,
} from "./handler.ts";
import {
  DISPATCH_REPORT_JEV_PROMPT_VERSION,
  DispatchReportJevError,
  createDispatchReportJevEvaluator,
  type DispatchReportJevEvaluator,
} from "./jev.ts";
import {
  callIndraOcr,
  readIndraOcrConfig,
  type IndraOcrConfig,
} from "../_shared/indra-ocr.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "dispatch-report-photos";
const SIGNED_URL_SECONDS = 120;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

let evaluatorCache: DispatchReportJevEvaluator | null | undefined;
function jevEvaluator(): DispatchReportJevEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key ? createDispatchReportJevEvaluator({ apiKey: key }) : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new DispatchReportJevError("unconfigured", 503);
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

function ocrConfig(): IndraOcrConfig | null {
  try {
    return readIndraOcrConfig();
  } catch {
    return null;
  }
}

Deno.serve(createDispatchReportJevHandler({
  authenticate: async (request, signal): Promise<DispatchReportJevCaller> => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new DispatchReportJevError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new DispatchReportJevError("unauthorized", 401);

    return {
      userId: user.id,
      save: async (date, photoIds) => {
        const { data, error: rpcError } = await db
          .rpc("dispatch_report_save", { p_date: date, p_photo_ids: photoIds })
          .abortSignal(signal);
        if (rpcError) throw rpcError;
        return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
      },
      loadReport: async (date) => {
        const { data, error: rpcError } = await db
          .rpc("kfm_daily_delivery_report", { p_date: date })
          .abortSignal(signal);
        if (rpcError) throw rpcError;
        return data;
      },
    };
  },
  loadPhotos: async (ids) => {
    if (ids.length === 0) return [];
    const { data, error } = await adminClient()
      .from("dispatch_report_photos")
      .select("id,storage_path")
      .in("id", ids);
    if (error) throw new DispatchReportJevError("store_failed", 503);
    return (data ?? [])
      .map((row) => ({
        id: String((row as { id?: unknown }).id ?? ""),
        storagePath: String((row as { storage_path?: unknown }).storage_path ?? ""),
      }))
      .filter((row) => row.id !== "" && row.storagePath !== "");
  },
  signPhoto: async (storagePath, signal) => {
    signal.throwIfAborted();
    const { data, error } = await adminClient()
      .storage.from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) {
      throw new DispatchReportJevError("photo_unavailable", 502);
    }
    return data.signedUrl;
  },
  ocrPhoto: async (signedUrl, signal) => {
    const config = ocrConfig();
    if (!config || !config.url || !config.token) {
      return null;
    }
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(signedUrl, { method: "GET", redirect: "error", signal });
    } catch {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new DispatchReportJevError("photo_download_failed", 502);
    }
    if (!response.ok) {
      throw new DispatchReportJevError("photo_download_failed", 502);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new DispatchReportJevError("photo_too_large", 413);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new DispatchReportJevError("photo_too_large", 413);
    }
    try {
      const result = await callIndraOcr({
        bytes,
        mimeType: response.headers.get("content-type") || "image/jpeg",
        config,
        signal,
      });
      return result.markdown.trim() ? result.markdown : result.text;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new DispatchReportJevError(
        typeof code === "string" && code !== "" ? `ocr_${code}` : "ocr_failed",
        502,
      );
    }
  },
  evaluator: jevEvaluator,
  markPhoto: async (mark: DispatchReportJevMark) => {
    const { error } = await adminClient().rpc("dispatch_report_jev_mark", {
      p_id: mark.id,
      p_status: mark.status,
      p_kind: mark.kind,
      p_po_numbers: mark.poNumbers.length > 0 ? mark.poNumbers : null,
      p_quantities: mark.quantities.length > 0
        ? mark.quantities.map((item) => ({ po_number: item.po_number, qty: item.qty }))
        : null,
      p_summary: mark.summary,
      p_mismatch: mark.mismatch,
      p_error: mark.error,
      p_prompt_version: mark.promptVersion,
    });
    if (error) {
      // Never log or return the provider body; the code is enough for audit.
      console.error(JSON.stringify({
        event: "dispatch_report_jev_mark_error",
        code: String((error as { code?: unknown }).code ?? "store_failed"),
        detail: errorText(error).slice(0, 200),
      }));
      throw new DispatchReportJevError("store_failed", 503);
    }
  },
  promptVersion: DISPATCH_REPORT_JEV_PROMPT_VERSION,
  audit: (event) => console.info(JSON.stringify(event)),
}));
