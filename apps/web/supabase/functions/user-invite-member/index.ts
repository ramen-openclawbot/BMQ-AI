import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type AppRole = "owner" | "staff" | "warehouse" | "viewer";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user: actor },
      error: actorError,
    } = await userClient.auth.getUser();

    if (actorError || !actor) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

    const { data: actorRole, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", actor.id)
      .maybeSingle();

    if (roleErr || actorRole?.role !== "owner") {
      return new Response(JSON.stringify({ error: "Forbidden: owner role required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const email = String(body?.email || "").trim().toLowerCase();
    const role = String(body?.role || "staff") as AppRole;

    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Invalid email" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["staff", "warehouse", "viewer", "owner"].includes(role)) {
      return new Response(JSON.stringify({ error: "Invalid role" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (role === "owner") {
      return new Response(JSON.stringify({ error: "Cannot invite owner from this flow" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authUserRows } = await admin
      .schema("auth")
      .from("users")
      .select("id,email")
      .ilike("email", email)
      .limit(1);

    const authUserId = authUserRows?.[0]?.id as string | undefined;

    if (authUserId) {
      await admin
        .from("profiles")
        .upsert(
          {
            user_id: authUserId,
            email,
          },
          { onConflict: "user_id" },
        );

      const { data: existingRole } = await admin
        .from("user_roles")
        .select("id")
        .eq("user_id", authUserId)
        .maybeSingle();

      if (existingRole) {
        await admin.from("user_roles").update({ role }).eq("user_id", authUserId);
      } else {
        await admin.from("user_roles").insert({ user_id: authUserId, role });
      }
    }

    await admin
      .from("user_invitations")
      .update({ status: "cancelled" })
      .eq("email", email)
      .eq("status", "pending");

    const { error: invErr } = await admin.from("user_invitations").insert({
      email,
      role,
      invited_by: actor.id,
      status: "pending",
    });

    if (invErr) {
      return new Response(JSON.stringify({ error: invErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const inviteRes = await admin.auth.admin.inviteUserByEmail(email, {
      data: { invited_role: role },
    });

    const inviteErrorText = String(inviteRes.error?.message || "").toLowerCase();
    const emailSent = !inviteRes.error;
    const alreadyExists =
      inviteErrorText.includes("already") ||
      inviteErrorText.includes("registered") ||
      inviteErrorText.includes("exists");

    return new Response(
      JSON.stringify({
        success: true,
        email,
        role,
        email_sent: emailSent,
        already_exists: alreadyExists,
        note: emailSent
          ? "Invitation email sent"
          : alreadyExists
            ? "User already exists in auth; invitation record created"
            : inviteRes.error?.message || "Invitation record created",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
