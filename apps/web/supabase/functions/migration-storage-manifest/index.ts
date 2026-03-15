import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const PAGE_SIZE = 1000;

function getObjectMime(metadata?: any) {
  return String(
    metadata?.mimetype ||
      metadata?.mimeType ||
      metadata?.contentType ||
      metadata?.content_type ||
      "",
  ).toLowerCase();
}

function getObjectSize(metadata?: any) {
  return Number(metadata?.size ?? metadata?.contentLength ?? 0);
}

function getObjectChecksum(metadata?: any) {
  return String(metadata?.eTag || metadata?.etag || metadata?.checksum || "");
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

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "public" },
    });

    const user = await requireOwner(req, supabaseAdmin, corsHeaders);

    let from = 0;
    const allRows: any[] = [];

    while (true) {
      const { data, error } = await supabaseAdmin
        .schema("storage")
        .from("objects")
        .select("id,bucket_id,name,created_at,updated_at,metadata")
        .order("bucket_id", { ascending: true })
        .order("name", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;

      const rows = data || [];
      allRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      source: "storage.objects",
      exportedBy: user.id,
      files: allRows.map((row: any) => ({
        objectId: row.id,
        bucket: row.bucket_id,
        path: row.name,
        size: getObjectSize(row.metadata),
        contentType: getObjectMime(row.metadata),
        checksum: getObjectChecksum(row.metadata),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };

    return new Response(JSON.stringify(manifest, null, 2), {
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
