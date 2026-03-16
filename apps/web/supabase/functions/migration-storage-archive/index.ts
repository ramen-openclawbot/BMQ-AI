import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import JSZip from "npm:jszip@3.10.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const PAGE_SIZE = 100;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

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

  const { data: roleRows } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", user.id).limit(10);
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

      if (error) throw new Error(`Không thể đọc bucket ${bucketId}${prefix ? `/${prefix}` : ""}: ${error.message}`);

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
    const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
    if (bucketsError) throw bucketsError;

    const objects: any[] = [];
    for (const bucket of buckets || []) {
      const bucketId = String((bucket as any)?.id || (bucket as any)?.name || "");
      if (!bucketId) continue;
      const bucketFiles = await listBucketObjects(supabaseAdmin.storage, bucketId);
      objects.push(...bucketFiles);
    }

    if (!objects.length) {
      return new Response(JSON.stringify({ error: "No storage objects found." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (objects.length > MAX_FILES) {
      return new Response(JSON.stringify({ error: `Too many files (${objects.length}). Max is ${MAX_FILES}.` }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const estimatedBytes = objects.reduce((sum, row) => sum + Number(row.size || 0), 0);
    if (estimatedBytes > MAX_TOTAL_BYTES) {
      return new Response(JSON.stringify({ error: `Archive too large (${Math.round(estimatedBytes / 1024 / 1024)}MB). Max is ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB.` }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const zip = new JSZip();
    const failed: Array<{ bucket: string; path: string; reason: string }> = [];

    for (const row of objects) {
      const bucket = String(row.bucket || "");
      const path = String(row.path || "");
      if (!bucket || !path) continue;

      try {
        const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
        if (error || !data) {
          failed.push({ bucket, path, reason: error?.message || "download_failed" });
          continue;
        }

        const bytes = new Uint8Array(await data.arrayBuffer());
        zip.file(`${bucket}/${path}`, bytes);
      } catch (err: any) {
        failed.push({ bucket, path, reason: err?.message || "download_failed" });
      }
    }

    zip.file("storage-manifest.json", JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "supabase.storage",
      exportedBy: user.id,
      files: objects.map((row: any) => ({
        objectId: row.objectId,
        bucket: row.bucket,
        path: row.path,
        size: row.size,
        contentType: row.contentType,
        checksum: row.checksum,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      failed,
    }, null, 2));

    const zipBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="bmq-storage-archive-${stamp}.zip"`,
      },
    });
  } catch (error: any) {
    if (error instanceof Response) return error;
    console.error("[migration-storage-archive] fatal", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
