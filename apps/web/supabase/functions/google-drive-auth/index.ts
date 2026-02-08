import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state'); // Contains redirect URL

  // Get environment variables
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Parse state to get redirect URL
  let redirectBase = 'https://bmqvn.lovable.app';
  if (state) {
    try {
      const stateData = JSON.parse(atob(state));
      if (stateData.redirect) {
        redirectBase = stateData.redirect;
      }
    } catch (e) {
      console.log('Could not parse state:', e);
    }
  }

  const settingsUrl = `${redirectBase}/settings`;

  // Handle errors from Google
  if (error) {
    console.error('Google OAuth error:', error);
    return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent(error)}`, 302);
  }

  // No code means this is the initial auth request - redirect to Google
  if (!code) {
    if (!clientId) {
      return new Response(JSON.stringify({ error: 'GOOGLE_CLIENT_ID not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get redirect URL from request body or query
    let appRedirect = redirectBase;
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body.redirect) {
          appRedirect = body.redirect;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    const redirectUri = `${supabaseUrl}/functions/v1/google-drive-auth`;
    const stateParam = btoa(JSON.stringify({ redirect: appRedirect }));
    
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.readonly email profile');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
    authUrl.searchParams.set('state', stateParam);

    return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Exchange code for tokens
  if (!clientId || !clientSecret) {
    return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent('OAuth credentials not configured')}`, 302);
  }

  try {
    const redirectUri = `${supabaseUrl}/functions/v1/google-drive-auth`;
    
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Token exchange failed:', errorData);
      return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent('Failed to exchange authorization code')}`, 302);
    }

    const tokens = await tokenResponse.json();
    console.log('Tokens received:', { 
      has_access_token: !!tokens.access_token, 
      has_refresh_token: !!tokens.refresh_token 
    });

    if (!tokens.refresh_token) {
      console.error('No refresh token received. User may have previously authorized without revoking.');
      return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent('No refresh token. Please revoke access at https://myaccount.google.com/permissions and try again.')}`, 302);
    }

    // Get user info
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });

    let userEmail = 'Unknown';
    if (userInfoResponse.ok) {
      const userInfo = await userInfoResponse.json();
      userEmail = userInfo.email || 'Unknown';
    }

    // Save tokens to database using service role key
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Save refresh token
    const { error: tokenError } = await supabaseAdmin
      .from('app_settings')
      .upsert({ 
        key: 'google_drive_refresh_token', 
        value: tokens.refresh_token,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    if (tokenError) {
      console.error('Failed to save refresh token:', tokenError);
      return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent('Failed to save token to database')}`, 302);
    }

    // Save connected email
    const { error: emailError } = await supabaseAdmin
      .from('app_settings')
      .upsert({ 
        key: 'google_drive_connected_email', 
        value: userEmail,
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' });

    if (emailError) {
      console.error('Failed to save email:', emailError);
    }

    // Delete old API key if exists (migration from old system)
    await supabaseAdmin
      .from('app_settings')
      .delete()
      .eq('key', 'google_drive_api_key');

    console.log('Successfully saved Google Drive OAuth tokens for:', userEmail);
    return Response.redirect(`${settingsUrl}?drive_success=true&drive_email=${encodeURIComponent(userEmail)}`, 302);

  } catch (error: unknown) {
    console.error('OAuth callback error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.redirect(`${settingsUrl}?drive_error=${encodeURIComponent(message)}`, 302);
  }
});
