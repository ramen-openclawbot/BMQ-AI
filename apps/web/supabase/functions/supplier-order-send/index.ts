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
import {
  buildSupplierOrderEmail,
  buildSupplierOrderEmailLines,
  type SupplierOrderEmailLine,
} from "../_shared/supplier-order-email.ts";

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
  if (
    message.includes("invalid_lines")
    || message.includes("duplicate_items")
    || message.includes("invalid_item_id")
  ) {
    return { status: 400, code: "invalid_lines" };
  }
  if (message.includes("supplier_not_found") || message.includes("item_not_found") || code === "P0002") {
    return { status: 404, code: "item_not_found" };
  }
  return { status: 500, code: "create_failed" };
}

function mapMultiCreateError(error: unknown): { status: number; code: string } {
  if (errorMessage(error).includes("no_supplier_email")) {
    return { status: 409, code: "no_supplier_email" };
  }
  return mapCreateError(error);
}

type MultiLineRequest = { item_id: string; quantity: number };

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

type QuoteLine = {
  position: number;
  item_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number | null;
  line_total: number | null;
  vat_rate: number;
  vat_amount: number | null;
  gross_amount: number | null;
  list_price: number | null;
  list_price_includes_vat: boolean;
};

function readQuoteLines(value: unknown): QuoteLine[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    return {
      position: numberValue(line.position) ?? index + 1,
      item_id: String(line.item_id ?? ""),
      product_name: String(line.product_name ?? ""),
      quantity: numberValue(line.quantity) ?? 0,
      unit: String(line.unit ?? ""),
      unit_price: numberValue(line.unit_price),
      line_total: numberValue(line.line_total),
      vat_rate: numberValue(line.vat_rate) ?? 0,
      vat_amount: numberValue(line.vat_amount),
      gross_amount: numberValue(line.gross_amount),
      list_price: numberValue(line.list_price),
      list_price_includes_vat: line.list_price_includes_vat === true,
    };
  });
}

function readMultiLines(value: unknown): MultiLineRequest[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const output: MultiLineRequest[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const itemId = String(record.item_id ?? "").trim();
    const quantity = Number(record.quantity);
    if (!UUID_RE.test(itemId) || !Number.isFinite(quantity) || quantity <= 0) {
      return null;
    }
    if (seen.has(itemId)) return null;
    seen.add(itemId);
    output.push({ item_id: itemId, quantity });
  }
  return output;
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

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return respond({ code: "invalid_body" }, 400, "invalid_body");
    }

    // A preview sends nothing: it gets its own, larger daily budget so checking
    // an order a few times never uses up the 30 real sends.
    const isPreview = Array.isArray(body.lines) && String(body.mode ?? "").trim() === "preview";
    const rate = isPreview
      ? await checkAndRecordRateLimit(user.id, "supplier-order-preview", 300)
      : await checkAndRecordRateLimit(user.id, "supplier-order-send", 30);
    if (!rate.allowed) {
      return respond({ code: "rate_limited" }, 429, "rate_limited");
    }

    requestId = String(body.request_id ?? "").trim();

    // ------------------------------------------------------------------
    // Multi-line supplier order (new page). The single-item body path below
    // stays untouched.
    // ------------------------------------------------------------------
    if (Array.isArray(body.lines)) {
      const supplierId = String(body.supplier_id ?? "").trim();
      const mode = String(body.mode ?? "").trim();
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
      const prepay = body.prepay === true;

      if (!UUID_RE.test(supplierId)) {
        return respond({ code: "invalid_supplier_id" }, 400, "invalid_supplier_id");
      }
      if (!UUID_RE.test(requestId)) {
        return respond({ code: "invalid_request_id" }, 400, "invalid_request_id");
      }
      if (mode !== "preview" && mode !== "send") {
        return respond({ code: "invalid_mode" }, 400, "invalid_mode");
      }
      const requestedLines = readMultiLines(body.lines);
      if (!requestedLines) {
        return respond({ code: "invalid_lines" }, 400, "invalid_lines");
      }

      const userDb = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Permission gate: the SQL function raises insufficient_privilege for a
      // caller who is neither owner nor a purchase_orders editor.
      const catalogResult = await userDb.rpc("supplier_order_catalog", {
        p_supplier_id: supplierId,
      });
      if (catalogResult.error) {
        const message = errorMessage(catalogResult.error);
        const code = errorCode(catalogResult.error);
        if (code === "42501" || message.includes("insufficient_privilege")) {
          return respond({ code: "forbidden" }, 403, "forbidden");
        }
        if (code === "P0002" || message.includes("supplier_not_found")) {
          return respond({ code: "supplier_not_found" }, 404, "supplier_not_found");
        }
        return respond({ code: "catalog_failed" }, 400, "catalog_failed");
      }

      const catalog = (catalogResult.data ?? {}) as Record<string, unknown>;
      const supplier = (catalog.supplier ?? {}) as Record<string, unknown>;
      const delivery = (catalog.delivery ?? {}) as Record<string, unknown>;
      const toEmail = String(supplier.email ?? "").trim();
      const supplierName = String(supplier.name ?? "").trim();
      const prepayRow = catalog.prepay && typeof catalog.prepay === "object"
        ? (catalog.prepay as Record<string, unknown>)
        : null;
      const prepayRecent = Boolean(prepayRow?.recent_submission);

      if (mode === "preview") {
        // The preview uses the same server-side quote as the create RPC, so the
        // email totals always match what will be stored on the PO.
        const quoteResult = await userDb.rpc("supplier_order_quote", {
          p_supplier_id: supplierId,
          p_lines: requestedLines,
        });
        if (quoteResult.error) {
          const mapped = mapCreateError(quoteResult.error);
          return respond({ code: mapped.code }, mapped.status, mapped.code);
        }

        const quote = (quoteResult.data ?? {}) as Record<string, unknown>;
        const orderLines = readQuoteLines(quote.lines);
        const subtotal = numberValue(quote.subtotal) ?? 0;
        const vatAmount = numberValue(quote.vat_amount) ?? 0;
        const total = numberValue(quote.total) ?? 0;
        const email = buildSupplierOrderEmailLines({
          poNumber: "",
          supplierName,
          lines: orderLines.map((line) => ({
            productName: line.product_name,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unit_price,
            lineTotal: line.line_total,
            vatRate: line.vat_rate,
          })),
          subtotal,
          vatAmount,
          total,
          deliveryAddress: String(delivery.address ?? ""),
          contactName: String(delivery.contact_name ?? ""),
          contactPhone: String(delivery.contact_phone ?? ""),
          note: note || String(delivery.note ?? ""),
          requestedDate: vnToday(),
          uploadUrl: "",
          subjectName: supplierName,
        });
        return respond(
          {
            subject: email.subject,
            html: email.html,
            text: email.text,
            to_email: toEmail,
            lines: orderLines.map((line) => ({
              position: line.position,
              item_id: line.item_id,
              product_name: line.product_name,
              quantity: line.quantity,
              unit: line.unit,
              unit_price: line.unit_price,
              line_total: line.line_total,
              vat_rate: line.vat_rate,
              vat_amount: line.vat_amount,
              gross_amount: line.gross_amount,
              list_price: line.list_price,
              list_price_includes_vat: line.list_price_includes_vat,
            })),
            subtotal,
            vat_amount: vatAmount,
            total,
            prepay: prepayRow && !prepayRecent ? prepayRow : null,
            prepay_reason: prepayRow ? (prepayRecent ? "recent" : null) : "none",
          },
          200,
          "preview",
        );
      }

      if (!toEmail) {
        return respond({ code: "no_supplier_email" }, 409, "no_supplier_email");
      }

      // The edge never sends before the server-side create succeeds and never
      // trusts the client's line prices: the RPC recomputes them.
      const createResult = await admin.rpc("create_supplier_order_multi", {
        p_request_id: requestId,
        p_supplier_id: supplierId,
        p_lines: requestedLines,
        p_note: note || null,
        p_actor: user.id,
      });
      if (createResult.error) {
        const mapped = mapMultiCreateError(createResult.error);
        return respond({ code: mapped.code }, mapped.status, mapped.code);
      }

      const created = (createResult.data ?? {}) as Record<string, unknown>;
      const orderRequestId = String(created.request_id ?? requestId);

      if (created.replayed === true && created.in_progress === true) {
        return respond({ code: "in_progress" }, 409, "in_progress");
      }

      if (String(created.status ?? "") === "sent") {
        return respond(
          {
            status: "sent",
            po_number: created.po_number ?? null,
            to_email: created.to_email ?? null,
            sent_at: created.sent_at ?? null,
            prepay: created.prepay ?? null,
            replayed: true,
          },
          200,
          "replayed_sent",
        );
      }

      const connectedEmail = (await readSetting(admin, "order_gmail_connected_email")).trim();
      if (connectedEmail.toLowerCase() !== ORDER_MAILBOX) {
        return respond({ code: "mailbox_not_connected" }, 409, "mailbox_not_connected");
      }

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const uploadToken = base64Url(tokenBytes);
      const uploadTokenHash = await sha256Hex(uploadToken);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const createdRows = Array.isArray(created.lines) ? created.lines : [];
      const emailLines: SupplierOrderEmailLine[] = createdRows.map((raw) => {
        const line = (raw ?? {}) as Record<string, unknown>;
        return {
          productName: String(line.product_name ?? ""),
          quantity: Number(line.quantity ?? 0),
          unit: String(line.unit ?? ""),
          unitPrice: numberValue(line.unit_price),
          lineTotal: numberValue(line.line_total),
          vatRate: numberValue(line.vat_rate) ?? 0,
        };
      });
      const createdSubtotal = numberValue(created.subtotal) ?? 0;
      const createdVatAmount = numberValue(created.vat_amount) ?? 0;
      const createdTotal = numberValue(created.total) ?? 0;
      const mail = buildSupplierOrderEmailLines({
        poNumber: String(created.po_number ?? ""),
        supplierName: String(created.supplier_name ?? supplierName),
        lines: emailLines,
        subtotal: createdSubtotal,
        vatAmount: createdVatAmount,
        total: createdTotal,
        deliveryAddress: String(delivery.address ?? ""),
        contactName: String(delivery.contact_name ?? ""),
        contactPhone: String(delivery.contact_phone ?? ""),
        note: note || String(delivery.note ?? ""),
        requestedDate: vnToday(),
        uploadUrl: `${UPLOAD_BASE}/${uploadToken}`,
        subjectName: String(created.supplier_name ?? supplierName),
      });

      try {
        const accessToken = await getGmailAccessToken(admin as any, "order_gmail_refresh_token");
        const sent = await sendGmail({
          accessToken,
          from: FROM_ADDRESS,
          to: String(created.to_email ?? toEmail),
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

        // Gối đầu runs only after the order is recorded as sent. Failures are
        // recorded but never turn the sent order into an error.
        let prepayResult: Record<string, unknown> | null = null;
        if (prepay) {
          let prepayStatus = "skipped_none";
          let submissionId: string | null = null;
          let submissionNumber: string | null = null;
          if (prepayRow) {
            if (prepayRecent) {
              prepayStatus = "skipped_recent";
            } else {
              try {
                const submission = await userDb.rpc("create_payment_submission", {
                  p_request_ids: [String(prepayRow.id ?? "")],
                  p_note: `Gối đầu khi đặt ${String(created.po_number ?? "")} cho NCC`,
                  p_idempotency_key: `supplier-order:${requestId}`,
                });
                if (submission.error) {
                  const message = errorMessage(submission.error);
                  const code = errorCode(submission.error);
                  if (
                    code === "42501"
                    || message.includes("insufficient_privilege")
                    || message.includes("not_owner")
                  ) {
                    prepayStatus = "forbidden";
                  } else if (
                    message.includes("not_payable")
                    || message.includes("not_pending")
                    || message.includes("request_not_found")
                    || message.includes("request_ids_required")
                  ) {
                    prepayStatus = "declined";
                  } else {
                    prepayStatus = "failed";
                  }
                } else {
                  const submissionData = (submission.data ?? {}) as Record<string, unknown>;
                  prepayStatus = "created";
                  submissionId = String(submissionData.submission_id ?? "");
                  submissionNumber = String(submissionData.submission_number ?? "");
                }
              } catch {
                prepayStatus = "failed";
              }
            }
          }

          try {
            await admin.rpc("record_supplier_order_prepay", {
              p_request_id: orderRequestId,
              p_status: prepayStatus,
              p_pr_id: prepayRow ? String(prepayRow.id ?? "") : null,
              p_submission_id: submissionId,
            });
          } catch {
            // Recording the prepay outcome must not fail the sent order.
          }

          prepayResult = {
            status: prepayStatus,
            request_number: prepayRow ? String(prepayRow.request_number ?? "") : null,
            submission_number: submissionNumber,
          };
        }

        return respond(
          {
            status: "sent",
            po_number: created.po_number ?? null,
            to_email: created.to_email ?? null,
            sent_at: (marked.data as { sent_at?: string } | null)?.sent_at
              ?? new Date().toISOString(),
            prepay: prepayResult,
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
    }

    itemId = String(body.item_id ?? "").trim();
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
