import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TestResult {
  success: boolean;
  folderName?: string;
  itemCount?: number;
  error?: string;
}

async function getAccessToken(supabaseClient: any): Promise<string | null> {
  // Get refresh token from database
  const { data: tokenData, error } = await supabaseClient
    .from('app_settings')
    .select('value')
    .eq('key', 'google_drive_refresh_token')
    .single();

  if (error || !tokenData?.value) {
    console.log("No refresh token found in database");
    return null;
  }

  const refreshToken = tokenData.value;
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    console.error("OAuth credentials not configured");
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
    console.error("Failed to refresh access token:", errorText);
    return null;
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { folderUrl } = await req.json();

    if (!folderUrl) {
      return new Response(
        JSON.stringify({ success: false, error: "Thiếu URL folder" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract folder ID from URL
    const folderIdMatch = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch) {
      return new Response(
        JSON.stringify({ success: false, error: "URL folder không hợp lệ. Vui lòng sử dụng link Google Drive folder" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const folderId = folderIdMatch[1];

    // Create Supabase client for database access
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

    // Get access token via OAuth
    const accessToken = await getAccessToken(supabaseClient);

    if (!accessToken) {
      return new Response(
        JSON.stringify({ success: false, error: "Chưa kết nối Google Drive. Vui lòng kết nối Google account trong Settings." }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Test 1: Get folder metadata
    const folderMetaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`;
    const folderResponse = await fetch(folderMetaUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!folderResponse.ok) {
      const errorData = await folderResponse.json();
      console.error("Folder metadata error:", errorData);
      const errorMessage = errorData?.error?.message || '';

      if (folderResponse.status === 404) {
        return new Response(
          JSON.stringify({ success: false, error: "Không tìm thấy folder. Kiểm tra lại URL hoặc quyền truy cập" }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (folderResponse.status === 403) {
        // Check if this is API disabled error vs permission error
        if (errorMessage.includes('API has not been used') || errorMessage.includes('is disabled')) {
          return new Response(
            JSON.stringify({ 
              success: false, 
              error: "Google Drive API chưa được bật trong Google Cloud Console. Vui lòng bật tại: https://console.developers.google.com/apis/api/drive.googleapis.com và thử lại sau vài phút." 
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        return new Response(
          JSON.stringify({ success: false, error: "Không có quyền truy cập folder này. Đảm bảo Google account đã được cấp quyền." }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (folderResponse.status === 401) {
        return new Response(
          JSON.stringify({ success: false, error: "Token hết hạn. Vui lòng kết nối lại Google Drive." }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: `Lỗi Google API: ${errorMessage || 'Unknown error'}` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const folderMeta = await folderResponse.json();

    // Verify it's a folder
    if (folderMeta.mimeType !== 'application/vnd.google-apps.folder') {
      return new Response(
        JSON.stringify({ success: false, error: "URL này không phải là folder. Vui lòng sử dụng link folder" }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Test 2: Count items in folder
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&pageSize=100&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const listResponse = await fetch(listUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    let itemCount = 0;
    if (listResponse.ok) {
      const listData = await listResponse.json();
      itemCount = listData.files?.length || 0;
    }

    const result: TestResult = {
      success: true,
      folderName: folderMeta.name,
      itemCount: itemCount
    };

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error("Test connection error:", error);
    const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
