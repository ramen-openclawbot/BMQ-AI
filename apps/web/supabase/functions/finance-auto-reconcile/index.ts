import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const vnDate = (d = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const sendEmail = async (subject: string, html: string) => {
  const emailEnabled = (Deno.env.get("FINANCE_EMAIL_ENABLED") || "true").toLowerCase() !== "false";
  if (!emailEnabled) {
    return { skipped: true, reason: "FINANCE_EMAIL_ENABLED=false" };
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FINANCE_REPORT_FROM") || "ramen@bmq.vn";
  const toRaw = Deno.env.get("FINANCE_REPORT_TO") || "ketoantruong@bmq.vn,tam@bmq.vn";
  const to = toRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (!RESEND_API_KEY) {
    console.warn("[finance-auto-reconcile] RESEND_API_KEY missing, skip email send");
    return { skipped: true, reason: "RESEND_API_KEY missing" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${text}`);
  return { ok: true, response: text };
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const CRON_SECRET = Deno.env.get("FINANCE_CRON_SECRET");
    if (CRON_SECRET) {
      const token = req.headers.get("x-cron-secret");
      if (token !== CRON_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json().catch(() => ({}));
    const closingDate = body?.closingDate || vnDate();

    const [detailByCreatedAt, detailByInvoiceDate] = await Promise.all([
      supabase
        .from("payment_requests")
        .select("id,total_amount")
        .eq("payment_method", "bank_transfer")
        .gte("created_at", `${closingDate}T00:00:00`)
        .lte("created_at", `${closingDate}T23:59:59.999`),
      supabase
        .from("payment_requests")
        .select("id,total_amount,invoices!payment_requests_invoice_id_fkey(invoice_date)")
        .eq("payment_method", "bank_transfer")
        .eq("invoices.invoice_date", closingDate),
    ]);

    if (detailByCreatedAt.error) throw detailByCreatedAt.error;
    if (detailByInvoiceDate.error) throw detailByInvoiceDate.error;

    const merged = new Map<string, number>();
    for (const row of (detailByCreatedAt.data || []) as any[]) {
      merged.set(row.id, Number(row.total_amount || 0));
    }
    for (const row of (detailByInvoiceDate.data || []) as any[]) {
      if (!merged.has(row.id)) merged.set(row.id, Number(row.total_amount || 0));
    }

    const uncDetail = Array.from(merged.values()).reduce((s, amount) => s + Number(amount || 0), 0);

    const { data: declaration, error: declarationError } = await supabase
      .from("ceo_daily_closing_declarations")
      .select("unc_total_declared,cash_fund_topup_amount,notes")
      .eq("closing_date", closingDate)
      .maybeSingle();

    if (declarationError) throw declarationError;

    const uncDeclared = Number(declaration?.unc_total_declared || 0);
    const topup = Number(declaration?.cash_fund_topup_amount || 0);
    const variance = uncDetail - uncDeclared;
    const tolerance = 0;
    const status = declaration ? (Math.abs(variance) <= tolerance ? "match" : "mismatch") : "pending";

    const { error: upsertError } = await supabase.from("daily_reconciliations").upsert(
      {
        closing_date: closingDate,
        unc_detail_amount: uncDetail,
        unc_declared_amount: uncDeclared,
        cash_fund_topup_amount: topup,
        variance_amount: variance,
        status,
        tolerance_amount: tolerance,
        matched_at: new Date().toISOString(),
        notes: declaration?.notes || null,
      },
      { onConflict: "closing_date" }
    );

    if (upsertError) throw upsertError;

    const vnd = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n || 0);

    const subject = `[Finance Reconcile] ${closingDate} - ${status.toUpperCase()}`;
    const html = `
      <h3>Daily Reconciliation Report - ${closingDate}</h3>
      <p><b>Status:</b> ${status.toUpperCase()}</p>
      <ul>
        <li>UNC Detail (auto): <b>${vnd(uncDetail)}</b></li>
        <li>UNC Declared (CEO): <b>${vnd(uncDeclared)}</b></li>
        <li>Cash Fund Top-up: <b>${vnd(topup)}</b></li>
        <li>Variance: <b>${vnd(variance)}</b></li>
      </ul>
      <p>Generated at: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>
    `;

    const emailResult = await sendEmail(subject, html);

    return new Response(JSON.stringify({
      success: true,
      closingDate,
      status,
      uncDetail,
      uncDeclared,
      variance,
      emailResult,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[finance-auto-reconcile] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
