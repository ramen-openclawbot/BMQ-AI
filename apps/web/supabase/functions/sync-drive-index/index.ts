import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const jsonResponse = (body: unknown, status = 200, corsHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

async function getAccessToken(supabaseClient: any): Promise<string | null> {
  const { data: tokenData, error } = await supabaseClient
    .from('app_settings')
    .select('value')
    .eq('key', 'google_drive_refresh_token')
    .single();

  if (error || !tokenData?.value) {
    console.log("[sync-drive-index] No refresh token found in database");
    return null;
  }

  const refreshToken = tokenData.value;
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    console.error("[sync-drive-index] OAuth credentials not configured");
    return null;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("[sync-drive-index] Failed to refresh access token:", errorText);
    return null;
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function listAllFilesInFolder(accessToken: string, folderId: string): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const query = encodeURIComponent(
      `'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`
    );
    let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,size),nextPageToken&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    if (pageToken) {
      url += `&pageToken=${pageToken}`;
    }

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      console.error('[sync-drive-index] Failed to list files in folder:', folderId);
      break;
    }

    const data: DriveListResponse = await response.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

async function listSubfolders(accessToken: string, rootFolderId: string): Promise<{ id: string; name: string }[]> {
  const allFolders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;

  do {
    const query = encodeURIComponent(
      `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true,nextPageToken&pageSize=1000`;
    if (pageToken) {
      url += `&pageToken=${pageToken}`;
    }

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      console.error('[sync-drive-index] Failed to list subfolders');
      break;
    }

    const data = await response.json();
    allFolders.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFolders;
}

serve(async (req) => {
  const startTime = Date.now();
  console.log("[sync-drive-index] Request started");

  if (req.method === 'OPTIONS') {
    return corsPreflightResponse(req);
  }

  try {
    // Validate authorization - simplified for prototype (no role check)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[sync-drive-index] Missing authorization header");
      return jsonResponse({ error: 'Missing authorization header' }, 401, getCorsHeaders(req));
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    // Use service role client for stable auth verification
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Validate user token using service role key (stable pattern)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.log("[sync-drive-index] Invalid or expired token:", authError?.message);
      return jsonResponse({ error: 'Invalid or expired token' }, 401, getCorsHeaders(req));
    }

    console.log("[sync-drive-index] User authenticated:", user.id);

    // Parse request
    const { folderType, maxFolders } = await req.json();
    
    if (!folderType || !['po', 'bank_slip'].includes(folderType)) {
      return jsonResponse({ error: 'Invalid folderType. Must be "po" or "bank_slip"' }, 400, getCorsHeaders(req));
    }

    const cappedFolders = Math.max(1, Math.min(Number(maxFolders || 60), 200));

    // Get folder URL from settings
    const settingKey = folderType === 'po' 
      ? 'google_drive_po_folder' 
      : 'google_drive_receipts_folder';

    const { data: settingData } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', settingKey)
      .single();

    if (!settingData?.value) {
      return jsonResponse({ error: `Folder ${folderType} chưa được cấu hình` }, 400, getCorsHeaders(req));
    }

    // Extract folder ID
    const folderIdMatch = settingData.value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      return jsonResponse({ error: 'Invalid Google Drive folder URL' }, 400, getCorsHeaders(req));
    }

    const rootFolderId = folderIdMatch[1];

    // Get access token
    const accessToken = await getAccessToken(supabaseAdmin);
    if (!accessToken) {
      return jsonResponse({ error: 'Google Drive not connected. Please connect in Settings.' }, 400, getCorsHeaders(req));
    }

    // List all date subfolders
    console.log(`[sync-drive-index] Starting sync for ${folderType}`);
    const allDateFolders = await listSubfolders(accessToken, rootFolderId);
    const dateFolders = allDateFolders.slice(0, cappedFolders);
    console.log(`[sync-drive-index] Found ${allDateFolders.length} folders, scanning ${dateFolders.length}`);

    let totalFilesSynced = 0;
    const errors: string[] = [];
    const now = new Date().toISOString();

    // Process folders with bounded concurrency to avoid long serial runtime / 504.
    const concurrency = 6;
    for (let i = 0; i < dateFolders.length; i += concurrency) {
      const chunk = dateFolders.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(async (folder) => {
          const files = await listAllFilesInFolder(accessToken, folder.id);
          if (!files.length) return { folder: folder.name, files: 0, ok: true as const };

          const upsertData = files.map(file => ({
            file_id: file.id,
            file_name: file.name,
            folder_date: folder.name,
            folder_type: folderType,
            mime_type: file.mimeType,
            parent_folder_id: folder.id,
            file_size: file.size ? parseInt(file.size) : null,
            last_seen_at: now,
          }));

          const { error: upsertError } = await supabaseAdmin
            .from('drive_file_index')
            .upsert(upsertData, {
              onConflict: 'file_id',
              ignoreDuplicates: false,
            });

          if (upsertError) {
            throw new Error(`Folder ${folder.name}: ${upsertError.message}`);
          }

          return { folder: folder.name, files: files.length, ok: true as const };
        })
      );

      for (const r of chunkResults) {
        if (r.status === 'fulfilled') {
          totalFilesSynced += Number(r.value?.files || 0);
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason || 'Unknown error');
          console.error('[sync-drive-index] Chunk item failed:', msg);
          errors.push(msg);
        }
      }
    }

    // Update sync config
    const syncStatus = errors.length === 0 ? 'success' : 'partial';
    const syncError = errors.length > 0 ? errors.join('; ') : null;

    await supabaseAdmin
      .from('drive_sync_config')
      .update({
        last_synced_at: now,
        last_sync_status: syncStatus,
        last_sync_error: syncError,
        files_synced_count: totalFilesSynced,
        updated_at: now,
      })
      .eq('folder_type', folderType);

    console.log(`[sync-drive-index] Sync complete in ${Date.now() - startTime}ms: ${totalFilesSynced} files, status: ${syncStatus}`);

    return jsonResponse({
      success: true,
      folderType,
      foldersScanned: dateFolders.length,
      filesSynced: totalFilesSynced,
      status: syncStatus,
      errors: errors.length > 0 ? errors : undefined,
    }, 200, getCorsHeaders(req));

  } catch (error: unknown) {
    console.error('[sync-drive-index] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return jsonResponse({ error: message }, 500, getCorsHeaders(req));
  }
});
