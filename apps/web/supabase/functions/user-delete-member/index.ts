import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
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
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
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
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const targetUserId = String(body?.userId || "").trim();

    if (!targetUserId) {
      return new Response(JSON.stringify({ error: "Missing userId" }), {
        status: 400,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    if (targetUserId === actor.id) {
      return new Response(JSON.stringify({ error: "Cannot delete your own account" }), {
        status: 400,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const { data: targetRole } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", targetUserId)
      .maybeSingle();

    if (targetRole?.role === "owner") {
      const { count: ownerCount } = await admin
        .from("user_roles")
        .select("id", { count: "exact", head: true })
        .eq("role", "owner");

      if ((ownerCount || 0) <= 1) {
        return new Response(JSON.stringify({ error: "Cannot delete the last owner" }), {
          status: 400,
          headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
        });
      }
    }

    const { data: targetAuth } = await admin.auth.admin.getUserById(targetUserId);
    const targetEmail = targetAuth?.user?.email ?? undefined;

    // Soft delete: the account can no longer sign in, but the auth row stays so
    // append-only audit logs that reference it (ON DELETE SET NULL) are not touched.
    // Disable the account before cleaning app data so a failure never leaves a
    // half-deleted user that can still sign in without a role.
    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(targetUserId, true);
    if (deleteAuthError) {
      return new Response(JSON.stringify({ error: `Không vô hiệu hoá được tài khoản: ${deleteAuthError.message}` }), {
        status: 500,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    await admin.from("user_module_permissions").delete().eq("user_id", targetUserId);
    await admin.from("user_roles").delete().eq("user_id", targetUserId);
    await admin.from("profiles").delete().eq("user_id", targetUserId);

    if (targetEmail) {
      await admin.from("user_invitations").update({ status: "cancelled" }).eq("email", targetEmail).eq("status", "pending");
    }

    // Audit log
    await admin.from("audit_logs").insert({
      actor_id: actor.id,
      action: "user_delete",
      target_id: targetUserId,
      metadata: { email: targetEmail || null },
    }).then(() => {}).catch((e: any) => console.error("[user-delete-member] audit log failed:", e));

    return new Response(JSON.stringify({ success: true, user_id: targetUserId }), {
      status: 200,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      },
    );
  }
});
