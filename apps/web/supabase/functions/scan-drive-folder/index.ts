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
}

interface DriveListResponse {
  files: DriveFile[];
}

async function getAccessToken(supabaseClient: any): Promise<string | null> {
  // Get refresh token from database
  const { data: tokenData, error } = await supabaseClient
    .from('app_settings')
    .select('value')
    .eq('key', 'google_drive_refresh_token')
    .single();

  if (error || !tokenData?.value) {
    console.log("[scan-drive-folder] No refresh token found in database");
    return null;
  }

  const refreshToken = tokenData.value;
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    console.error("[scan-drive-folder] OAuth credentials not configured");
    return null;
  }

  // Exchange refresh token for access token
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
    console.error("[scan-drive-folder] Failed to refresh access token:", errorText);
    return null;
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-drive-folder] Request started");

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate authorization - simplified for prototype (no role check)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[scan-drive-folder] Missing authorization header");
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
      console.log("[scan-drive-folder] Invalid or expired token:", authError?.message);
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("[scan-drive-folder] User authenticated:", user.id);

    // Parse request body
    const { folderUrl, subfolderDate, mode } = await req.json();

    if (!folderUrl) {
      return new Response(JSON.stringify({ error: 'Missing folderUrl' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Extract folder ID from URL
    const folderIdMatch = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      return new Response(JSON.stringify({ error: 'Invalid Google Drive folder URL' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rootFolderId = folderIdMatch[1];

    // Get OAuth token using service role client
    const accessToken = await getAccessToken(supabaseAdmin);

    if (!accessToken) {
      console.log("[scan-drive-folder] Google Drive not connected");
      return new Response(JSON.stringify({ error: 'Google Drive not connected. Please connect in Settings.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // MODE: list_all_dates - List all subfolders with file counts
    if (mode === 'list_all_dates') {
      console.log("[scan-drive-folder] Mode: list_all_dates");
      const subfolderQuery = encodeURIComponent(
        `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      );
      const subfolderUrl = `https://www.googleapis.com/drive/v3/files?q=${subfolderQuery}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      
      const subfolderResponse = await fetch(subfolderUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!subfolderResponse.ok) {
        const errorText = await subfolderResponse.text();
        console.error('[scan-drive-folder] Google Drive API error (list subfolders):', errorText);
        return new Response(JSON.stringify({ 
          error: 'Failed to list subfolders',
          details: 'Token may have expired. Please reconnect Google Drive in Settings.'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const subfolderData: DriveListResponse = await subfolderResponse.json();
      
      // Get file count for each subfolder
      const dates: { date: string; fileCount: number; folderId: string }[] = [];
      
      for (const folder of subfolderData.files) {
        const imageQuery = encodeURIComponent(
          `'${folder.id}' in parents and (mimeType contains 'image/') and trashed = false`
        );
        const countUrl = `https://www.googleapis.com/drive/v3/files?q=${imageQuery}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        
        try {
          const countResponse = await fetch(countUrl, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          });
          
          if (countResponse.ok) {
            const countData: DriveListResponse = await countResponse.json();
            dates.push({
              date: folder.name,
              fileCount: countData.files.length,
              folderId: folder.id,
            });
          }
        } catch (err) {
          console.error(`[scan-drive-folder] Error counting files in folder ${folder.name}:`, err);
        }
      }
      
      // Sort by date (newest first) - convert DDMMYY to YYMMDD for comparison
      dates.sort((a, b) => {
        const toComparable = (d: string) => {
          if (d.length !== 6) return d;
          return d.slice(4) + d.slice(2, 4) + d.slice(0, 2);
        };
        return toComparable(b.date).localeCompare(toComparable(a.date));
      });

      console.log(`[scan-drive-folder] Found ${dates.length} date folders in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify({ 
        success: true, 
        mode: 'list_all_dates',
        dates,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // MODE: scan_date (default) - Scan a specific date folder and download files
    // If subfolderDate is provided, find the subfolder first
    let targetFolderId = rootFolderId;

    if (subfolderDate) {
      console.log(`[scan-drive-folder] Scanning subfolder: ${subfolderDate}`);
      // List subfolders to find the one matching the date
      const subfolderQuery = encodeURIComponent(`'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${subfolderDate}' and trashed = false`);
      const subfolderUrl = `https://www.googleapis.com/drive/v3/files?q=${subfolderQuery}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      
      const subfolderResponse = await fetch(subfolderUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!subfolderResponse.ok) {
        const errorText = await subfolderResponse.text();
        console.error('[scan-drive-folder] Google Drive API error (subfolders):', errorText);
        return new Response(JSON.stringify({ 
          error: 'Failed to access Google Drive folder',
          details: 'Token may have expired. Please reconnect Google Drive in Settings.'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const subfolderData: DriveListResponse = await subfolderResponse.json();
      
      if (subfolderData.files.length === 0) {
        console.log(`[scan-drive-folder] No subfolder found for date ${subfolderDate}`);
        return new Response(JSON.stringify({ 
          success: true, 
          files: [],
          message: `No subfolder found for date ${subfolderDate}`
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      targetFolderId = subfolderData.files[0].id;
    }

    // List image files in the target folder
    const imageQuery = encodeURIComponent(`'${targetFolderId}' in parents and (mimeType contains 'image/') and trashed = false`);
    const filesUrl = `https://www.googleapis.com/drive/v3/files?q=${imageQuery}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    
    const filesResponse = await fetch(filesUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!filesResponse.ok) {
      const errorText = await filesResponse.text();
      console.error('[scan-drive-folder] Google Drive API error (files):', errorText);
      return new Response(JSON.stringify({ error: 'Failed to list files in folder' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const filesData: DriveListResponse = await filesResponse.json();
    console.log(`[scan-drive-folder] Found ${filesData.files.length} image files`);

    // OPTIMIZED: Download files in PARALLEL (limited concurrency to avoid rate limits)
    const CONCURRENT_DOWNLOADS = 5;
    const filesWithContent: { id: string; name: string; mimeType: string; base64: string }[] = [];

    // Helper function to encode arraybuffer to base64 safely
    const encodeBase64 = (arrayBuffer: ArrayBuffer): string => {
      const uint8Array = new Uint8Array(arrayBuffer);
      let binaryString = '';
      const chunkSize = 8192;
      
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        binaryString += String.fromCharCode.apply(null, Array.from(chunk));
      }
      
      return btoa(binaryString);
    };

    // Process files in batches for parallel download
    for (let i = 0; i < filesData.files.length; i += CONCURRENT_DOWNLOADS) {
      const batch = filesData.files.slice(i, i + CONCURRENT_DOWNLOADS);
      
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
            const downloadResponse = await fetch(downloadUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            });
            
            if (!downloadResponse.ok) {
              console.error(`[scan-drive-folder] Failed to download file ${file.name}`);
              return null;
            }

            const arrayBuffer = await downloadResponse.arrayBuffer();
            const base64 = encodeBase64(arrayBuffer);

            return {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              base64: base64,
            };
          } catch (err) {
            console.error(`[scan-drive-folder] Error processing file ${file.name}:`, err);
            return null;
          }
        })
      );
      
      // Add successful downloads to result
      filesWithContent.push(...results.filter((r): r is NonNullable<typeof r> => r !== null));
    }

    console.log(`[scan-drive-folder] Completed in ${Date.now() - startTime}ms, downloaded ${filesWithContent.length} files`);
    return new Response(JSON.stringify({ 
      success: true, 
      files: filesWithContent,
      folderDate: subfolderDate || null,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[scan-drive-folder] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
