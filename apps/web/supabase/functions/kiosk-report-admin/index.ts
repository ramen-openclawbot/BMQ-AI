import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, getCorsHeaders } from "../_shared/cors.ts";
import { normalizeDealerPhone } from "../_shared/dealer.ts";

function jsonResponse(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requireOwner(req: Request, supabaseAdmin: any) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response(JSON.stringify({ error: "Missing authorization header" }), {
      status: 401,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    throw new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  const { data: roleRows, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .limit(10);

  if (roleError) throw roleError;

  const isOwner = (roleRows || []).some((row: any) => row.role === "owner");
  if (!isOwner) {
    throw new Response(JSON.stringify({ error: "Forbidden: owner role required" }), {
      status: 403,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  return user;
}

const sanitizeText = (value: unknown) => String(value || "").trim();

const parseMoney = (value: unknown) => {
  const numberValue = Number(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return jsonResponse(req, 405, { success: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await requireOwner(req, supabaseAdmin);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "list");

    if (action === "list") {
      const [locationsRes, staffRes] = await Promise.all([
        supabaseAdmin
          .from("kiosk_report_locations")
          .select("id, location_code, location_name, address, active, created_at, updated_at")
          .order("location_code", { ascending: true }),
        supabaseAdmin
          .from("kiosk_report_staff")
          .select("id, full_name, phone_raw, phone_normalized, location_id, monthly_salary_vnd, active, created_at, updated_at, kiosk_report_locations(id, location_code, location_name, address)")
          .order("full_name", { ascending: true }),
      ]);

      if (locationsRes.error) throw locationsRes.error;
      if (staffRes.error) throw staffRes.error;

      return jsonResponse(req, 200, {
        success: true,
        locations: locationsRes.data || [],
        staff: staffRes.data || [],
      });
    }

    if (action === "upsert_location") {
      const id = sanitizeText(body?.location?.id);
      const locationName = sanitizeText(body?.location?.location_name);
      const locationCode = sanitizeText(body?.location?.location_code).toUpperCase();
      const address = sanitizeText(body?.location?.address) || null;
      const active = body?.location?.active !== false;

      if (!locationName) {
        return jsonResponse(req, 400, { success: false, error: "Tên điểm bán là bắt buộc" });
      }
      if (!locationCode) {
        return jsonResponse(req, 400, { success: false, error: "Mã điểm bán là bắt buộc" });
      }

      const payload = {
        location_name: locationName,
        location_code: locationCode,
        address,
        active,
      };

      const query = id
        ? supabaseAdmin.from("kiosk_report_locations").update(payload).eq("id", id)
        : supabaseAdmin.from("kiosk_report_locations").insert(payload);

      const { data, error } = await query
        .select("id, location_code, location_name, address, active, updated_at")
        .single();

      if (error) throw error;
      return jsonResponse(req, 200, { success: true, location: data });
    }

    if (action === "upsert_staff" || action === "reassign_staff") {
      const staffPayload = body?.staff || {};
      const id = sanitizeText(staffPayload?.id || body?.staff_id);
      const fullName = sanitizeText(staffPayload?.full_name);
      const phoneRaw = sanitizeText(staffPayload?.phone_raw);
      const phoneNormalized = normalizeDealerPhone(phoneRaw);
      const locationId = sanitizeText(staffPayload?.location_id || body?.location_id);
      const active = staffPayload?.active !== false;

      if (!id && action === "reassign_staff") {
        return jsonResponse(req, 400, { success: false, error: "Thiếu nhân viên để đổi điểm bán" });
      }
      if (action === "upsert_staff" && !fullName) {
        return jsonResponse(req, 400, { success: false, error: "Tên nhân viên là bắt buộc" });
      }
      if (action === "upsert_staff" && !phoneNormalized) {
        return jsonResponse(req, 400, { success: false, error: "SĐT nhân viên không hợp lệ" });
      }
      if (!locationId) {
        return jsonResponse(req, 400, { success: false, error: "Mỗi nhân viên cần đúng 1 điểm bán" });
      }

      const { data: locationRow, error: locationError } = await supabaseAdmin
        .from("kiosk_report_locations")
        .select("id")
        .eq("id", locationId)
        .maybeSingle();

      if (locationError) throw locationError;
      if (!locationRow?.id) {
        return jsonResponse(req, 400, { success: false, error: "Điểm bán không tồn tại" });
      }

      const payload = action === "reassign_staff"
        ? { location_id: locationId }
        : {
            full_name: fullName,
            phone_raw: phoneRaw,
            phone_normalized: phoneNormalized,
            location_id: locationId,
            monthly_salary_vnd: parseMoney(staffPayload?.monthly_salary_vnd),
            active,
          };

      const query = id
        ? supabaseAdmin.from("kiosk_report_staff").update(payload).eq("id", id)
        : supabaseAdmin.from("kiosk_report_staff").insert(payload);

      const { data, error } = await query
        .select("id, full_name, phone_raw, phone_normalized, location_id, monthly_salary_vnd, active, updated_at, kiosk_report_locations(id, location_code, location_name, address)")
        .single();

      if (error) throw error;
      return jsonResponse(req, 200, { success: true, staff: data });
    }

    return jsonResponse(req, 400, { success: false, error: "Unsupported kiosk report admin action" });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[kiosk-report-admin] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể cập nhật dữ liệu báo cáo điểm bán";
    return jsonResponse(req, 500, { success: false, error: message });
  }
});
