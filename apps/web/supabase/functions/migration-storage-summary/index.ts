import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

interface StorageStats {
  files: number;
  totalBytes: number;
  imageFiles: number;
  imageBytes: number;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff", "avif"]);

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

function looksLikeFileObject(item?: any) {
  const name = String(item?.name || "");
  if (!name) return false;

  if (item?.id || item?.metadata) return true;
  if (typeof item?.size === "number") return true;
  if (getObjectMime(item)) return true;

  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() || "" : "";
  return IMAGE_EXTS.has(ext);
}

function isImageObject(item?: any) {
  const mime = getObjectMime(item);
  if (mime.startsWith("image/")) return true;

  const lower = String(item?.name || "").toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() || "" : "";
  return IMAGE_EXTS.has(ext);
}

async function collectBucketStats(storage: any, bucketId: string): Promise<StorageStats> {
  const stats: StorageStats = { files: 0, totalBytes: 0, imageFiles: 0, imageBytes: 0 };
  const queue: string[] = [""];
  const pageSize = 100;

  while (queue.length > 0) {
    const prefix = queue.shift() || "";
    let offset = 0;

    while (true) {
      const { data, error } = await storage.from(bucketId).list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

      if (error) {
        throw new Error(`Không thể đọc bucket ${bucketId}${prefix ? `/${prefix}` : ""}: ${error.message}`);
      }

      const rows = data || [];
      if (!rows.length) break;

      for (const item of rows as any[]) {
        const name = String(item?.name || "");
        if (!name) continue;

        const isFile = looksLikeFileObject(item);
        if (!isFile) {
          const childPrefix = prefix ? `${prefix}/${name}` : name;
          queue.push(childPrefix);
          continue;
        }

        const size = getObjectSize(item);
        stats.files += 1;
        stats.totalBytes += size;

        if (isImageObject(item)) {
          stats.imageFiles += 1;
          stats.imageBytes += size;
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }
  }

  return stats;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const { data: roleRows } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .limit(10);

    const isOwner = (roleRows || []).some((r: any) => r.role === "owner");
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden. Owner role required." }), {
        status: 403,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
    if (bucketsError) throw bucketsError;

    const bucketIds = (buckets || []).map((b: any) => String(b.id || b.name)).filter(Boolean);
    const bucketStats = await Promise.all(bucketIds.map((bucketId) => collectBucketStats(supabaseAdmin.storage, bucketId)));

    const summary = bucketStats.reduce(
      (acc, s) => ({
        files: acc.files + s.files,
        totalBytes: acc.totalBytes + s.totalBytes,
        imageFiles: acc.imageFiles + s.imageFiles,
        imageBytes: acc.imageBytes + s.imageBytes,
      }),
      { files: 0, totalBytes: 0, imageFiles: 0, imageBytes: 0 },
    );

    return new Response(JSON.stringify({
      buckets: bucketIds,
      files: summary.files,
      totalBytes: summary.totalBytes,
      imageFiles: summary.imageFiles,
      imageBytes: summary.imageBytes,
    }), {
      status: 200,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[migration-storage-summary] fatal", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
