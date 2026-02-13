import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

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
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate authorization - simplified for prototype (no role check)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[sync-drive-index] Missing authorization header");
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
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
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("[sync-drive-index] User authenticated:", user.id);

    // Parse request
    const { folderType } = await req.json();
    
    if (!folderType || !['po', 'bank_slip'].includes(folderType)) {
      return new Response(JSON.stringify({ error: 'Invalid folderType. Must be "po" or "bank_slip"' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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
      return new Response(JSON.stringify({ 
        error: `Folder ${folderType} chưa được cấu hình` 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Extract folder ID
    const folderIdMatch = settingData.value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      return new Response(JSON.stringify({ error: 'Invalid Google Drive folder URL' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rootFolderId = folderIdMatch[1];

    // Get access token
    const accessToken = await getAccessToken(supabaseAdmin);
    if (!accessToken) {
      return new Response(JSON.stringify({ 
        error: 'Google Drive not connected. Please connect in Settings.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // List all date subfolders
    console.log(`[sync-drive-index] Starting sync for ${folderType}`);
    const dateFolders = await listSubfolders(accessToken, rootFolderId);
    console.log(`[sync-drive-index] Found ${dateFolders.length} date folders`);

    let totalFilesSynced = 0;
    const errors: string[] = [];
    const now = new Date().toISOString();

    // Process each date folder
    for (const folder of dateFolders) {
      try {
        const files = await listAllFilesInFolder(accessToken, folder.id);
        
        if (files.length === 0) continue;

        // Prepare upsert data
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

        // Batch upsert into drive_file_index
        const { error: upsertError } = await supabaseAdmin
          .from('drive_file_index')
          .upsert(upsertData, { 
            onConflict: 'file_id',
            ignoreDuplicates: false
          });

        if (upsertError) {
          console.error(`[sync-drive-index] Error upserting files from folder ${folder.name}:`, upsertError);
          errors.push(`Folder ${folder.name}: ${upsertError.message}`);
        } else {
          totalFilesSynced += files.length;
        }
      } catch (err) {
        console.error(`[sync-drive-index] Error processing folder ${folder.name}:`, err);
        errors.push(`Folder ${folder.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
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

    return new Response(JSON.stringify({
      success: true,
      folderType,
      foldersScanned: dateFolders.length,
      filesSynced: totalFilesSynced,
      status: syncStatus,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[sync-drive-index] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
