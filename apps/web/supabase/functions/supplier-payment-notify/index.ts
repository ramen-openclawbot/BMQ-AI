// Email ảnh UNC cho nhà cung cấp sau khi duyệt chi.
//
// pg_cron gọi function mỗi phút với x-worker-secret của robot_worker_config id
// 'supplier-payment-notify'. Function claim tối đa 3 thông báo pending, tải mọi
// ảnh UNC của payment từ bucket 'payment-unc', gửi Gmail từ order@bmq.vn kèm
// ảnh, rồi mark sent/failed. Khi thành công, RPC mark xếp đúng 1 tin Zalo vào
// supplier_zalo_notifications.
//
// Log chỉ gồm { id, code }. Không log token, nội dung email, đường dẫn hay ảnh.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  getGmailAccessToken,
  type GmailAttachment,
  GmailSendError,
  sendGmail,
} from "../_shared/gmail-send.ts";
import { buildSupplierPaymentEmail } from "../_shared/supplier-payment-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WORKER_ID = "supplier-payment-notify";
const UNC_BUCKET = "payment-unc";
const CLAIM_LIMIT = 3;
const FROM = "BMQ Thanh toán <order@bmq.vn>";
const REPLY_TO = "order@bmq.vn";

type AdminClient = ReturnType<typeof createClient<any>>;

type ClaimedNotification = {
  id: string;
  payment_id: string;
  payment_number: string;
  amount: number | string | null;
  payment_date: string | null;
  reference_number: string | null;
  supplier_name: string | null;
  supplier_email: string | null;
  mode: string | null;
  test_email: string | null;
  po_numbers: string[] | null;
  request_numbers: string[] | null;
  unc_paths: string[] | null;
  ocr_reference: string | null;
};

type Result = { id: string; ok: boolean; code: string };

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeEmails(value: string | null): string {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .join(", ");
}

function objectName(storagePath: string): string {
  const prefix = `${UNC_BUCKET}/`;
  return storagePath.startsWith(prefix)
    ? storagePath.slice(prefix.length)
    : storagePath;
}

function extensionOf(storagePath: string): string {
  const name = storagePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function mimeForExtension(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function amountValue(value: number | string | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textArray(value: string[] | null): string[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

async function mark(
  admin: AdminClient,
  id: string,
  ok: boolean,
  toEmail: string | null,
  messageId: string | null,
  error: string | null,
): Promise<void> {
  const { error: rpcError } = await admin.rpc(
    "mark_supplier_payment_notification",
    {
      p_id: id,
      p_ok: ok,
      p_to_email: toEmail,
      p_gmail_message_id: messageId,
      p_error: error,
    },
  );
  if (rpcError) {
    console.error(JSON.stringify({ id, code: "mark_failed" }));
  }
}

function logFailure(id: string, code: string): void {
  console.error(JSON.stringify({ id, code }));
}

async function processNotification(
  admin: AdminClient,
  row: ClaimedNotification,
): Promise<Result> {
  const attachments: GmailAttachment[] = [];

  for (const storagePath of textArray(row.unc_paths)) {
    if (storagePath === "") continue;
    try {
      const { data, error } = await admin.storage
        .from(UNC_BUCKET)
        .download(objectName(storagePath));
      if (error || !data) {
        logFailure(row.id, "storage_download_failed");
        continue;
      }
      const extension = extensionOf(storagePath);
      attachments.push({
        filename: `UNC-${row.payment_number}-${attachments.length + 1}.${
          extension || "bin"
        }`,
        mimeType: mimeForExtension(extension),
        data: new Uint8Array(await data.arrayBuffer()),
      });
    } catch {
      logFailure(row.id, "storage_download_failed");
    }
  }

  if (attachments.length === 0) {
    logFailure(row.id, "no_unc_file");
    await mark(admin, row.id, false, null, null, "no_unc_file");
    return { id: row.id, ok: false, code: "no_unc_file" };
  }

  const mode = row.mode === null || row.mode === "" ? "test" : row.mode;
  const test = mode === "test";
  const toEmail = normalizeEmails(test ? row.test_email : row.supplier_email);
  const email = buildSupplierPaymentEmail({
    supplierName: row.supplier_name ?? "",
    paymentNumber: row.payment_number,
    amount: amountValue(row.amount),
    paymentDate: row.payment_date,
    poNumbers: textArray(row.po_numbers),
    requestNumbers: textArray(row.request_numbers),
    reference: row.reference_number ?? row.ocr_reference,
    test,
  });

  try {
    const accessToken = await getGmailAccessToken(
      admin as unknown as Parameters<typeof getGmailAccessToken>[0],
      "order_gmail_refresh_token",
    );
    const sent = await sendGmail({
      accessToken,
      from: FROM,
      to: toEmail,
      replyTo: REPLY_TO,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments,
    });
    await mark(admin, row.id, true, toEmail, sent.id, null);
    return { id: row.id, ok: true, code: "sent" };
  } catch (error) {
    const code = error instanceof GmailSendError ? error.code : "send_failed";
    logFailure(row.id, code);
    await mark(admin, row.id, false, toEmail, null, code);
    return { id: row.id, ok: false, code };
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  if (SUPABASE_URL === "" || SERVICE_ROLE_KEY === "") {
    return json(500, { error: "server_misconfigured" });
  }

  const admin = createClient<any>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const provided = request.headers.get("x-worker-secret") ?? "";
  const { data: worker, error: workerError } = await admin
    .from("robot_worker_config")
    .select("worker_secret")
    .eq("id", WORKER_ID)
    .maybeSingle();

  const stored = typeof worker?.worker_secret === "string"
    ? worker.worker_secret
    : "";
  if (
    workerError
    || stored === ""
    || provided === ""
    || !timingSafeEqual(provided, stored)
  ) {
    return json(401, { error: "unauthorized" });
  }

  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_supplier_payment_notifications",
    { p_limit: CLAIM_LIMIT },
  );
  if (claimError) {
    console.error(JSON.stringify({ id: null, code: "claim_failed" }));
    return json(500, { error: "claim_failed" });
  }

  const rows = Array.isArray(claimed) ? claimed as ClaimedNotification[] : [];
  const results: Result[] = [];
  for (const row of rows) {
    results.push(await processNotification(admin, row));
  }

  return json(200, { processed: results.length, results });
});
