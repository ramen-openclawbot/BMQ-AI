import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import JSZip from "npm:jszip@3.10.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB hard-limit to protect edge runtime

interface DriveFileRow {
  file_id: string;
  file_name: string;
  folder_type: string;
  folder_date: string;
  parent_folder_id: string | null;
  file_size: number | null;
}

async function getAccessToken(supabaseAdmin: any): Promise<string | null> {
  const { data: tokenData, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .single();

  if (error || !tokenData?.value) return null;

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokenData.value,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) return null;
  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

function sanitizeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|\x00-\x1F]/g, "_");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
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
      return new Response(JSON.stringify({ error: "Forbidden. Owner role required." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const folderType = body?.folderType as "po" | "bank_slip" | "all" | undefined;
    const fromDate = body?.fromDate as string | undefined;
    const toDate = body?.toDate as string | undefined;

    let query = supabaseAdmin
      .from("drive_file_index")
      .select("file_id,file_name,folder_type,folder_date,parent_folder_id,file_size")
      .order("folder_date", { ascending: false })
      .limit(MAX_FILES + 1);

    if (folderType && folderType !== "all") {
      query = query.eq("folder_type", folderType);
    }
    if (fromDate) query = query.gte("folder_date", fromDate);
    if (toDate) query = query.lte("folder_date", toDate);

    const { data, error } = await query;
    if (error) throw error;

    const files = (data || []) as DriveFileRow[];
    if (!files.length) {
      return new Response(JSON.stringify({ error: "No files found for selected filter." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (files.length > MAX_FILES) {
      return new Response(JSON.stringify({
        error: `Too many files (${files.length}). Please filter smaller range (max ${MAX_FILES}).`,
      }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const estimatedBytes = files.reduce((sum, f) => sum + Number(f.file_size || 0), 0);
    if (estimatedBytes > MAX_TOTAL_BYTES) {
      return new Response(JSON.stringify({
        error: `Archive too large (${Math.round(estimatedBytes / 1024 / 1024)}MB). Max is ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB.`,
      }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken(supabaseAdmin);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Google Drive not connected." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const zip = new JSZip();
    const failed: Array<{ fileId: string; reason: string }> = [];

    for (const file of files) {
      try {
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${file.file_id}?alt=media&supportsAllDrives=true`;
        const resp = await fetch(driveUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!resp.ok) {
          failed.push({ fileId: file.file_id, reason: `HTTP ${resp.status}` });
          continue;
        }

        const bytes = new Uint8Array(await resp.arrayBuffer());
        const filePath = `${file.folder_type}/${file.folder_date}/${sanitizeFileName(file.file_name)}`;
        zip.file(filePath, bytes);
      } catch (err: any) {
        failed.push({ fileId: file.file_id, reason: err?.message || "download_failed" });
      }
    }

    zip.file(
      "storage-manifest.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          exportedBy: user.id,
          filters: { folderType: folderType || "all", fromDate, toDate },
          files: files.map((f) => ({
            fileId: f.file_id,
            fileName: f.file_name,
            folderType: f.folder_type,
            folderDate: f.folder_date,
            fileSize: f.file_size,
          })),
          failed,
        },
        null,
        2,
      ),
    );

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
    console.error("[migration-storage-archive] fatal", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
