import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const PAGE_SIZE = 100;

function getObjectMime(item?: any) {
  return String(
    item?.metadata?.mimetype ||
      item?.metadata?.mimeType ||
      item?.metadata?.contentType ||
      item?.metadata?.content_type ||
      item?.mimetype ||
      item?.mimeType ||
      item?.contentType ||
      item?.content_type ||
      "",
  ).toLowerCase();
}

function getObjectSize(item?: any) {
  return Number(item?.metadata?.size ?? item?.size ?? item?.metadata?.contentLength ?? 0);
}

function getObjectChecksum(item?: any) {
  return String(item?.metadata?.eTag || item?.metadata?.etag || item?.metadata?.checksum || "");
}

function looksLikeFileObject(item?: any) {
  const name = String(item?.name || "");
  if (!name) return false;
  if (item?.id || item?.metadata) return true;
  if (typeof item?.size === "number") return true;
  if (getObjectMime(item)) return true;
  return name.includes(".");
}

async function requireOwner(req: Request, supabaseAdmin: any, corsHeaders: Record<string, string>) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response(JSON.stringify({ error: "Missing authorization header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    throw new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: roleRows } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .limit(10);

  const isOwner = (roleRows || []).some((r: any) => r.role === "owner");
  if (!isOwner) {
    throw new Response(JSON.stringify({ error: "Forbidden. Owner role required." }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return user;
}

async function listBucketObjects(storage: any, bucketId: string) {
  const results: any[] = [];
  const queue: string[] = [""];

  while (queue.length > 0) {
    const prefix = queue.shift() || "";
    let offset = 0;

    while (true) {
      const { data, error } = await storage.from(bucketId).list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

      if (error) {
        throw new Error(`Không thể đọc bucket ${bucketId}${prefix ? `/${prefix}` : ""}: ${error.message}`);
      }

      const rows = data || [];
      if (!rows.length) break;

      for (const item of rows) {
        const name = String(item?.name || "");
        if (!name) continue;

        if (looksLikeFileObject(item)) {
          const path = prefix ? `${prefix}/${name}` : name;
          results.push({
            objectId: item?.id || null,
            bucket: bucketId,
            path,
            size: getObjectSize(item),
            contentType: getObjectMime(item),
            checksum: getObjectChecksum(item),
            createdAt: item?.created_at || null,
            updatedAt: item?.updated_at || null,
          });
        } else {
          queue.push(prefix ? `${prefix}/${name}` : name);
        }
      }

      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const user = await requireOwner(req, supabaseAdmin, corsHeaders);
    const body = await req.json().catch(() => ({}));
    const requestedBucketIds = Array.isArray(body?.bucketIds)
      ? body.bucketIds.map((v: unknown) => String(v || "").trim()).filter(Boolean)
      : [];

    const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
    if (bucketsError) throw bucketsError;

    const files = [] as any[];
    for (const bucket of buckets || []) {
      const bucketId = String((bucket as any)?.id || (bucket as any)?.name || "");
      if (!bucketId) continue;
      if (requestedBucketIds.length > 0 && !requestedBucketIds.includes(bucketId)) continue;
      const bucketFiles = await listBucketObjects(supabaseAdmin.storage, bucketId);
      files.push(...bucketFiles);
    }

    return new Response(JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "supabase.storage",
      exportedBy: user.id,
      files,
    }, null, 2), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="storage-manifest.json"',
      },
    });
  } catch (error: any) {
    if (error instanceof Response) return error;
    console.error("[migration-storage-manifest] fatal", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
