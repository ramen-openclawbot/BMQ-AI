// Supplier order send endpoint (phase 1: one order email, no cron).
//
// Authenticated owner / purchase_orders editor. The authenticated user calls
// prepare_supplier_order so the SQL permission gate is enforced with the user
// JWT; the service role then creates the draft PO idempotently and records every
// send attempt. The upload token and email body never appear in logs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth } from "../_shared/auth.ts";
import { corsPreflightResponse, getCorsHeaders } from "../_shared/cors.ts";
import { checkAndRecordRateLimit } from "../_shared/rate-limiter.ts";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import { buildSupplierOrderEmail } from "../_shared/supplier-order-email.ts";

const ORDER_MAILBOX = "order@bmq.vn";
const FROM_ADDRESS = "BMQ Đặt hàng <order@bmq.vn>";
const UPLOAD_BASE = "https://ai.banhmique.vn/ncc/hoa-don";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function vnToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type AdminClient = any;

async function readSetting(db: AdminClient, key: string): Promise<string> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  const row = data as { value?: string | null } | null;
  return row?.value ? String(row.value) : "";
}

function errorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }
  return "";
}

function mapCreateError(error: unknown): { status: number; code: string } {
  const message = errorMessage(error);
  const code = errorCode(error);
  for (const blocker of [
    "no_supplier",
    "no_supplier_email",
    "no_price",
    "no_po_unit",
  ]) {
    if (message.includes(blocker)) return { status: 409, code: blocker };
  }
  if (message.includes("over_quantity_limit")) {
    return { status: 400, code: "over_quantity_limit" };
  }
  if (message.includes("over_amount_limit")) {
    return { status: 400, code: "over_amount_limit" };
  }
  if (message.includes("invalid_quantity")) {
    return { status: 400, code: "invalid_quantity" };
  }
  if (message.includes("item_not_found") || code === "P0002") {
    return { status: 404, code: "item_not_found" };
  }
  return { status: 500, code: "create_failed" };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, corsHeaders);
  }

  let requestId = "";
  let itemId = "";
  let logStatus = 0;
  let logCode: string | null = null;
  const respond = (body: unknown, status: number, code: string | null = null) => {
    logStatus = status;
    logCode = code;
    return jsonResponse(body, status, corsHeaders);
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const { user, token } = await requireAuth(req, corsHeaders);
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const rate = await checkAndRecordRateLimit(user.id, "supplier-order-send", 30);
    if (!rate.allowed) {
      return respond({ code: "rate_limited" }, 429, "rate_limited");
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return respond({ code: "invalid_body" }, 400, "invalid_body");
    }

    itemId = String(body.item_id ?? "").trim();
    requestId = String(body.request_id ?? "").trim();
    const quantity = Number(body.quantity);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";

    if (!UUID_RE.test(itemId)) {
      return respond({ code: "invalid_item_id" }, 400, "invalid_item_id");
    }
    if (!UUID_RE.test(requestId)) {
      return respond({ code: "invalid_request_id" }, 400, "invalid_request_id");
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return respond({ code: "invalid_quantity" }, 400, "invalid_quantity");
    }

    // Permission gate: the SQL function raises insufficient_privilege for a
    // caller who is neither owner nor a purchase_orders editor.
    const userDb = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const preparedResult = await userDb.rpc("prepare_supplier_order", {
      p_item_id: itemId,
    });
    if (preparedResult.error) {
      const message = errorMessage(preparedResult.error);
      const code = errorCode(preparedResult.error);
      if (code === "42501" || message.includes("insufficient_privilege")) {
        return respond({ code: "forbidden" }, 403, "forbidden");
      }
      if (code === "P0002" || message.includes("item_not_found")) {
        return respond({ code: "item_not_found" }, 404, "item_not_found");
      }
      return respond({ code: "prepare_failed" }, 400, "prepare_failed");
    }
    const prepared = (preparedResult.data ?? {}) as Record<string, unknown>;
    const preparedProposal = (prepared.proposal ?? {}) as Record<string, unknown>;
    const preparedSupplier = (prepared.supplier ?? {}) as Record<string, unknown>;
    const delivery = (prepared.delivery ?? {}) as Record<string, unknown>;

    const createResult = await admin.rpc("create_supplier_order_po", {
      p_request_id: requestId,
      p_item_id: itemId,
      p_quantity: quantity,
      p_note: note || null,
      p_actor: user.id,
    });
    if (createResult.error) {
      const mapped = mapCreateError(createResult.error);
      return respond({ code: mapped.code }, mapped.status, mapped.code);
    }

    const created = (createResult.data ?? {}) as Record<string, unknown>;
    const orderRequestId = String(created.request_id ?? requestId);
    const status = String(created.status ?? "preparing");

    if (created.replayed === true && created.in_progress === true) {
      return respond({ code: "in_progress" }, 409, "in_progress");
    }

    if (status === "sent") {
      return respond(
        {
          status: "sent",
          po_number: created.po_number ?? null,
          to_email: created.to_email ?? null,
          sent_at: created.sent_at ?? null,
          replayed: true,
        },
        200,
        "replayed_sent",
      );
    }

    const connectedEmail = (await readSetting(admin, "order_gmail_connected_email")).trim();
    if (connectedEmail.toLowerCase() !== "order@bmq.vn") {
      return respond({ code: "mailbox_not_connected" }, 409, "mailbox_not_connected");
    }

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const uploadToken = base64Url(tokenBytes);
    const uploadTokenHash = await sha256Hex(uploadToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const supplierName = String(
      created.supplier_name ?? preparedSupplier.name ?? "",
    );
    const productName = String(
      created.product_name ?? preparedProposal.product_name ?? "",
    );
    const mail = buildSupplierOrderEmail({
      poNumber: String(created.po_number ?? ""),
      supplierName,
      productName,
      quantity: Number(created.quantity ?? quantity),
      unit: String(created.unit ?? ""),
      unitPrice: Number(created.unit_price ?? 0),
      lineTotal: Number(created.line_total ?? 0),
      deliveryAddress: String(delivery.address ?? ""),
      contactName: String(delivery.contact_name ?? ""),
      contactPhone: String(delivery.contact_phone ?? ""),
      // The orderer's note for this order wins over the standing delivery note.
      note: note || String(delivery.note ?? ""),
      requestedDate: vnToday(),
      uploadUrl: `${UPLOAD_BASE}/${uploadToken}`,
    });

    try {
      const accessToken = await getGmailAccessToken(admin as any, "order_gmail_refresh_token");
      const sent = await sendGmail({
        accessToken,
        from: FROM_ADDRESS,
        to: String(created.to_email ?? ""),
        replyTo: ORDER_MAILBOX,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });

      const marked = await admin.rpc("mark_supplier_order_sent", {
        p_request_id: orderRequestId,
        p_gmail_message_id: sent.id,
        p_upload_token_hash: uploadTokenHash,
        p_expires_at: expiresAt,
      });
      if (marked.error) {
        await admin.rpc("mark_supplier_order_failed", {
          p_request_id: orderRequestId,
          p_error: "state_update_failed",
        });
        return respond({ code: "state_update_failed" }, 502, "state_update_failed");
      }

      return respond(
        {
          status: "sent",
          po_number: created.po_number ?? null,
          to_email: created.to_email ?? null,
          sent_at: (marked.data as { sent_at?: string } | null)?.sent_at ?? new Date().toISOString(),
        },
        200,
        "sent",
      );
    } catch {
      await admin.rpc("mark_supplier_order_failed", {
        p_request_id: orderRequestId,
        p_error: "email_failed",
      });
      return respond({ code: "email_failed" }, 502, "email_failed");
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      JSON.stringify({
        fn: "supplier-order-send",
        event: "unhandled",
        request_id: requestId || null,
        error: errorMessage(error).slice(0, 300),
      }),
    );
    return respond({ code: "internal_error" }, 500, "internal_error");
  } finally {
    console.log(
      JSON.stringify({
        fn: "supplier-order-send",
        event: "request",
        request_id: requestId || null,
        item_id: itemId || null,
        status: logStatus,
        code: logCode,
      }),
    );
  }
});
