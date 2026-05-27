import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

type DeletePaymentRequestBody = {
  id?: string;
};

type AuthUser = {
  id: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requirePaymentRequestEdit(req: Request, supabaseAdmin: ReturnType<typeof createClient>): Promise<AuthUser | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(req, 401, { error: "Missing authorization header" });
  }

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse(req, 401, { error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." });
  }

  const [{ data: roleRows, error: roleError }, { data: permissionRows, error: permissionError }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", user.id).limit(10),
    supabaseAdmin
      .from("user_module_permissions")
      .select("can_edit")
      .eq("user_id", user.id)
      .eq("module_key", "payment_requests")
      .limit(1),
  ]);

  if (roleError || permissionError) {
    console.error("[delete-payment-request] permission lookup failed", { roleError, permissionError });
    return jsonResponse(req, 500, { error: "Không kiểm tra được quyền xoá duyệt chi" });
  }

  const isOwner = (roleRows || []).some((row: { role?: string | null }) => row.role === "owner");
  const canEditPaymentRequests = (permissionRows || []).some((row: { can_edit?: boolean | null }) => row.can_edit === true);

  if (!isOwner && !canEditPaymentRequests) {
    return jsonResponse(req, 403, { error: "Anh không có quyền xoá duyệt chi" });
  }

  return { id: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return jsonResponse(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(req, 500, { error: "Supabase service configuration is missing" });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
  const authResult = await requirePaymentRequestEdit(req, supabaseAdmin);
  if (authResult instanceof Response) return authResult;

  let body: DeletePaymentRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, 400, { error: "Invalid JSON body" });
  }

  const id = String(body.id || "").trim();
  if (!UUID_RE.test(id)) {
    return jsonResponse(req, 400, { error: "Mã duyệt chi không hợp lệ" });
  }

  const { data: existingRequest, error: lookupError } = await supabaseAdmin
    .from("payment_requests")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    console.error("[delete-payment-request] lookup failed", lookupError);
    return jsonResponse(req, 500, { error: "Không kiểm tra được duyệt chi cần xoá" });
  }

  if (!existingRequest) {
    return jsonResponse(req, 404, { error: "Không tìm thấy duyệt chi cần xoá" });
  }

  const { data: linkedInvoices, error: unlinkError } = await supabaseAdmin
    .from("invoices")
    .update({ payment_request_id: null })
    .eq("payment_request_id", id)
    .select("id");

  if (unlinkError) {
    console.error("[delete-payment-request] invoice unlink failed", unlinkError);
    return jsonResponse(req, 500, { error: "Không gỡ được liên kết hóa đơn trước khi xoá duyệt chi" });
  }

  const { data: deletedRows, error: deleteError } = await supabaseAdmin
    .from("payment_requests")
    .delete()
    .eq("id", id)
    .select("id");

  if (deleteError) {
    console.error("[delete-payment-request] delete failed", deleteError);
    return jsonResponse(req, 500, { error: `Không xoá được duyệt chi: ${deleteError.message}` });
  }

  if (!deletedRows || deletedRows.length === 0) {
    return jsonResponse(req, 404, { error: "Không tìm thấy duyệt chi cần xoá" });
  }

  return jsonResponse(req, 200, {
    success: true,
    id,
    unlinked_invoice_count: linkedInvoices?.length || 0,
    deleted_by: authResult.id,
  });
});
