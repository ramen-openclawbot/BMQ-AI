import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface DriveListResponse {
  files: DriveFile[];
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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

async function listChildFolders(parentFolderId: string, accessToken: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(
    `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000);
  if (!res.ok) throw new Error(`Failed listing child folders: ${await res.text()}`);
  const data: DriveListResponse = await res.json();
  return data.files || [];
}

async function resolveFolderPath(rootFolderId: string, path: string, accessToken: string): Promise<string | null> {
  const segments = String(path || "").split("/").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return rootFolderId;

  let currentFolderId = rootFolderId;
  for (const segment of segments) {
    // Try exact match first
    const qExact = encodeURIComponent(
      `'${currentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${segment.replace(/'/g, "\\'")}' and trashed = false`
    );
    const urlExact = `https://www.googleapis.com/drive/v3/files?q=${qExact}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const resExact = await fetchWithTimeout(urlExact, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000);
    if (!resExact.ok) throw new Error(`Failed resolving path segment '${segment}': ${await resExact.text()}`);
    const dataExact: DriveListResponse = await resExact.json();

    if (dataExact.files?.length) {
      currentFolderId = dataExact.files[0].id;
      continue;
    }

    // Fallback: case-insensitive match — list all child folders and match by lowercased name
    console.log(`[scan-drive-folder] Exact match failed for '${segment}', trying case-insensitive fallback`);
    const qAll = encodeURIComponent(
      `'${currentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const urlAll = `https://www.googleapis.com/drive/v3/files?q=${qAll}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`;
    const resAll = await fetchWithTimeout(urlAll, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000);
    if (!resAll.ok) return null;
    const dataAll: DriveListResponse = await resAll.json();
    const match = (dataAll.files || []).find((f) => f.name.toLowerCase() === segment.toLowerCase());
    if (!match) {
      console.log(`[scan-drive-folder] No folder found for segment '${segment}' (case-insensitive). Available: ${(dataAll.files || []).map(f => f.name).join(', ')}`);
      return null;
    }
    console.log(`[scan-drive-folder] Case-insensitive match: '${segment}' → '${match.name}' (${match.id})`);
    currentFolderId = match.id;
  }

  return currentFolderId;
}

async function countImagesInFolder(folderId: string, accessToken: string): Promise<number> {
  const q = encodeURIComponent(`'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000);
  if (!res.ok) return 0;
  const data: DriveListResponse = await res.json();
  return data.files?.length || 0;
}

async function countChildFolders(folderId: string, accessToken: string): Promise<number> {
  const q = encodeURIComponent(
    `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000);
  if (!res.ok) return 0;
  const data: DriveListResponse = await res.json();
  return data.files?.length || 0;
}

async function listImagesInFolder(folderId: string, accessToken: string): Promise<DriveFile[]> {
  const imageQuery = encodeURIComponent(`'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`);
  const filesUrl = `https://www.googleapis.com/drive/v3/files?q=${imageQuery}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000`;
  const filesResponse = await fetchWithTimeout(filesUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  }, 12000);
  if (!filesResponse.ok) {
    throw new Error(`Failed to list files in folder: ${await filesResponse.text()}`);
  }
  const filesData: DriveListResponse = await filesResponse.json();
  return Array.isArray(filesData.files) ? filesData.files : [];
}

async function listImagesRecursiveOneLevel(folderId: string, accessToken: string): Promise<{ files: DriveFile[]; directCount: number; childFolderCount: number; recursiveChildFileCount: number; recursiveUsed: boolean }> {
  const directFiles = await listImagesInFolder(folderId, accessToken);
  if (directFiles.length > 0) {
    return {
      files: directFiles,
      directCount: directFiles.length,
      childFolderCount: 0,
      recursiveChildFileCount: 0,
      recursiveUsed: false,
    };
  }

  const childFolders = await listChildFolders(folderId, accessToken);
  if (!childFolders.length) {
    return {
      files: directFiles,
      directCount: 0,
      childFolderCount: 0,
      recursiveChildFileCount: 0,
      recursiveUsed: false,
    };
  }

  const nestedLists = await Promise.all(childFolders.map((child) => listImagesInFolder(child.id, accessToken).catch(() => [])));
  const nestedFiles = nestedLists.flat();
  return {
    files: nestedFiles,
    directCount: 0,
    childFolderCount: childFolders.length,
    recursiveChildFileCount: nestedFiles.length,
    recursiveUsed: nestedFiles.length > 0,
  };
}

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-drive-folder] Request started");

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return corsPreflightResponse(req);
  }

  try {
    // Gateway/client auth contract: frontend must send apikey + Bearer token.
    // Avoid double-validating JWT here because service-role-based getUser checks can
    // fail when secrets drift, which surfaces as false "session expired" errors.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[scan-drive-folder] Missing authorization header");
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[scan-drive-folder] Missing Supabase env for service role client');
      return new Response(JSON.stringify({ error: 'Server misconfigured: missing Supabase secrets' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Parse request body
    const { folderUrl, subfolderDate, mode, parentPath, includeBase64 = true, skipProcessed = false, folderType = 'bank_slip', fileId, fileName, mimeType } = await req.json();

    if (!folderUrl) {
      return new Response(JSON.stringify({ error: 'Missing folderUrl' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Extract folder ID from URL
    const folderIdMatch = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      return new Response(JSON.stringify({ error: 'Invalid Google Drive folder URL' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const rootFolderId = folderIdMatch[1];

    // Get OAuth token using service role client
    const accessToken = await getAccessToken(supabaseAdmin);

    if (!accessToken) {
      console.log("[scan-drive-folder] Google Drive not connected");
      return new Response(JSON.stringify({ error: 'Google Drive not connected. Please connect in Settings.' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // MODE: list_children - Browse hierarchy under a parent path (e.g. YYYY/MM)
    if (mode === 'list_children') {
      const normalizedParentPath = String(parentPath || '').replace(/^\/+|\/+$/g, '');
      const resolvedParentId = await resolveFolderPath(rootFolderId, normalizedParentPath, accessToken);

      if (!resolvedParentId) {
        return new Response(JSON.stringify({ success: true, mode: 'list_children', folders: [], parentPath: normalizedParentPath, currentFolderId: resolvedParentId }), {
          status: 200,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
        });
      }

      const children = await listChildFolders(resolvedParentId, accessToken);
      const folders = await Promise.all(children.map(async (f) => {
        const [imageCount, childFolderCount] = await Promise.all([
          countImagesInFolder(f.id, accessToken),
          countChildFolders(f.id, accessToken),
        ]);

        return {
          name: f.name,
          folderId: f.id,
          imageCount,
          hasChildren: childFolderCount > 0,
          childFolderCount,
        };
      }));

      folders.sort((a, b) => a.name.localeCompare(b.name));

      return new Response(JSON.stringify({ success: true, mode: 'list_children', parentPath: normalizedParentPath, currentFolderId: resolvedParentId, folders }), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // MODE: list_all_dates - List all subfolders with file counts
    if (mode === 'list_all_dates') {
      console.log("[scan-drive-folder] Mode: list_all_dates");
      const subfolderQuery = encodeURIComponent(
        `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      );
      const subfolderUrl = `https://www.googleapis.com/drive/v3/files?q=${subfolderQuery}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      
      const subfolderResponse = await fetchWithTimeout(subfolderUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }, 10000);

      if (!subfolderResponse.ok) {
        const errorText = await subfolderResponse.text();
        console.error('[scan-drive-folder] Google Drive API error (list subfolders):', errorText);
        return new Response(JSON.stringify({ 
          error: 'Failed to list subfolders',
          details: 'Token may have expired. Please reconnect Google Drive in Settings.'
        }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
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
          const countResponse = await fetchWithTimeout(countUrl, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          }, 8000);
          
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
      
      // Sort by date (newest first) - support both DDMMYY and DDMMYYYY
      dates.sort((a, b) => {
        const toComparable = (d: string) => {
          if (/^\d{8}$/.test(d)) {
            // ddmmyyyy => yyyymmdd
            return d.slice(4, 8) + d.slice(2, 4) + d.slice(0, 2);
          }
          if (/^\d{6}$/.test(d)) {
            // ddmmyy => yymmdd
            return d.slice(4, 6) + d.slice(2, 4) + d.slice(0, 2);
          }
          return d;
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
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // MODE: download_file - Download a single file by id (used for lazy OCR pipeline)
    if (mode === 'download_file') {
      if (!fileId) {
        return new Response(JSON.stringify({ error: 'Missing fileId' }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
        });
      }

      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const downloadResponse = await fetchWithTimeout(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }, 10000);

      if (!downloadResponse.ok) {
        const errorText = await downloadResponse.text().catch(() => '');
        return new Response(JSON.stringify({ error: 'Failed to download file', details: errorText }), {
          status: 400,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
        });
      }

      const arrayBuffer = await downloadResponse.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binaryString = '';
      const chunkSize = 8192;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        binaryString += String.fromCharCode.apply(null, Array.from(chunk));
      }
      const base64 = btoa(binaryString);

      return new Response(JSON.stringify({
        success: true,
        file: {
          id: String(fileId),
          name: String(fileName || fileId),
          mimeType: String(mimeType || 'image/jpeg'),
          base64,
        },
      }), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // MODE: scan_date (default) - Scan a specific date folder and download files
    // If subfolderDate is provided, find the subfolder first
    let targetFolderId = rootFolderId;

    if (subfolderDate) {
      console.log(`[scan-drive-folder] Scanning subfolder path: ${subfolderDate}`);
      const resolvedFolderId = await resolveFolderPath(rootFolderId, String(subfolderDate), accessToken);

      if (!resolvedFolderId) {
        console.log(`[scan-drive-folder] No subfolder found for path ${subfolderDate}`);
        return new Response(JSON.stringify({
          success: true,
          files: [],
          message: `No subfolder found for path ${subfolderDate}`
        }), {
          status: 200,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
        });
      }

      targetFolderId = resolvedFolderId;
    }

    // List image files in the target folder. If none are found directly,
    // fallback to scan one nested folder level because some UNC/QTM days store
    // slips inside child folders under the day folder.
    let fileScanMeta = { directCount: 0, childFolderCount: 0, recursiveChildFileCount: 0, recursiveUsed: false };
    let allImageFiles: DriveFile[] = [];
    try {
      const fileScan = await listImagesRecursiveOneLevel(targetFolderId, accessToken);
      fileScanMeta = {
        directCount: fileScan.directCount,
        childFolderCount: fileScan.childFolderCount,
        recursiveChildFileCount: fileScan.recursiveChildFileCount,
        recursiveUsed: fileScan.recursiveUsed,
      };
      allImageFiles = fileScan.files;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error('[scan-drive-folder] Google Drive API error (files):', errorText);
      return new Response(JSON.stringify({ error: 'Failed to list files in folder', details: errorText }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }
    console.log(`[scan-drive-folder] Found ${allImageFiles.length} image files (direct=${fileScanMeta.directCount}, childFolders=${fileScanMeta.childFolderCount}, nested=${fileScanMeta.recursiveChildFileCount}, recursiveUsed=${fileScanMeta.recursiveUsed})`);

    let targetFiles = allImageFiles;
    let skippedProcessedCount = 0;

    // Optional fast-path: skip files already processed in drive_file_index (huge speed-up for reconciliation reruns).
    if (skipProcessed && targetFiles.length > 0) {
      const fileIds = targetFiles.map((f) => f.id);
      const processedSet = new Set<string>();
      const CHUNK = 500;

      for (let i = 0; i < fileIds.length; i += CHUNK) {
        const idsChunk = fileIds.slice(i, i + CHUNK);
        const { data: processedRows } = await supabaseAdmin
          .from('drive_file_index')
          .select('file_id')
          .eq('folder_type', folderType === 'po' ? 'po' : 'bank_slip')
          .eq('processed', true)
          .in('file_id', idsChunk);

        for (const row of processedRows || []) {
          if (row?.file_id) processedSet.add(String(row.file_id));
        }
      }

      targetFiles = targetFiles.filter((f) => !processedSet.has(f.id));
      skippedProcessedCount = allImageFiles.length - targetFiles.length;
      console.log(`[scan-drive-folder] Skip processed enabled: skipped ${skippedProcessedCount}, remaining ${targetFiles.length}`);
    }

    if (!includeBase64) {
      return new Response(JSON.stringify({
        success: true,
        files: targetFiles,
        folderDate: subfolderDate || null,
        skippedProcessedCount,
        totalFilesFound: allImageFiles.length,
        directFilesFound: fileScanMeta.directCount,
        childFoldersFound: fileScanMeta.childFolderCount,
        recursiveFilesFound: fileScanMeta.recursiveChildFileCount,
        recursiveUsed: fileScanMeta.recursiveUsed,
      }), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

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
    for (let i = 0; i < targetFiles.length; i += CONCURRENT_DOWNLOADS) {
      const batch = targetFiles.slice(i, i + CONCURRENT_DOWNLOADS);
      
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
            const downloadResponse = await fetchWithTimeout(downloadUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            }, 10000);
            
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

    console.log(`[scan-drive-folder] Completed in ${Date.now() - startTime}ms, downloaded ${filesWithContent.length}/${targetFiles.length} files`);
    return new Response(JSON.stringify({ 
      success: true, 
      files: filesWithContent,
      folderDate: subfolderDate || null,
      skippedProcessedCount,
      totalFilesFound: allImageFiles.length,
      directFilesFound: fileScanMeta.directCount,
      childFoldersFound: fileScanMeta.childFolderCount,
      recursiveFilesFound: fileScanMeta.recursiveChildFileCount,
      recursiveUsed: fileScanMeta.recursiveUsed,
      targetFilesCount: targetFiles.length,
    }), {
      status: 200,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[scan-drive-folder] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
