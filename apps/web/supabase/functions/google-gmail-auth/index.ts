import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let redirectBase = "https://bmqvn.lovable.app";
  if (state) {
    try {
      const stateData = JSON.parse(atob(state));
      if (stateData.redirect) redirectBase = stateData.redirect;
    } catch (_) {}
  }
  const miniCrmUrl = `${redirectBase}/mini-crm`;

  if (error) {
    return Response.redirect(`${miniCrmUrl}?gmail_error=${encodeURIComponent(error)}`, 302);
  }

  if (!code) {
    if (!clientId) {
      return new Response(JSON.stringify({ error: "GOOGLE_CLIENT_ID not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let appRedirect = redirectBase;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body.redirect) appRedirect = body.redirect;
      } catch (_) {}
    }

    const redirectUri = `${supabaseUrl}/functions/v1/google-gmail-auth`;
    const stateParam = btoa(JSON.stringify({ redirect: appRedirect }));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly email profile");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", stateParam);

    return new Response(JSON.stringify({ authUrl: authUrl.toString() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!clientId || !clientSecret) {
    return Response.redirect(`${miniCrmUrl}?gmail_error=${encodeURIComponent("OAuth credentials not configured")}`, 302);
  }

  try {
    const redirectUri = `${supabaseUrl}/functions/v1/google-gmail-auth`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      return Response.redirect(`${miniCrmUrl}?gmail_error=${encodeURIComponent(errorData)}`, 302);
    }

    const tokens = await tokenResponse.json();
    if (!tokens.refresh_token) {
      return Response.redirect(`${miniCrmUrl}?gmail_error=${encodeURIComponent("No refresh token from Google")}`, 302);
    }

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let userEmail = "Unknown";
    if (userInfoResponse.ok) {
      const userInfo = await userInfoResponse.json();
      userEmail = userInfo.email || "Unknown";
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    await supabaseAdmin.from("app_settings").upsert(
      { key: "google_gmail_refresh_token", value: tokens.refresh_token, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

    await supabaseAdmin.from("app_settings").upsert(
      { key: "google_gmail_connected_email", value: userEmail, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

    return Response.redirect(`${miniCrmUrl}?gmail_success=true&gmail_email=${encodeURIComponent(userEmail)}`, 302);
  } catch (e: any) {
    return Response.redirect(`${miniCrmUrl}?gmail_error=${encodeURIComponent(e?.message || "Unknown error")}`, 302);
  }
});
