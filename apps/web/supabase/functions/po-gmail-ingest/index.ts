import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireCronSecret } from "../_shared/auth.ts";

type IncomingEmail = {
  messageId?: string;
  threadId?: string;
  fromEmail: string;
  fromName?: string;
  subject?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  attachmentNames?: string[];
  receivedAt?: string;
  rawPayload?: Record<string, unknown>;
};

const normalizeEmail = (value: string) => {
  const raw = String(value || "").trim().toLowerCase();
  const inBracket = raw.match(/<([^>]+)>/)?.[1] || raw;
  return inBracket.trim();
};

const explodeEmails = (value: string): string[] => {
  return String(value || "")
    .split(/[;,\n]+/)
    .map((part) => normalizeEmail(part))
    .filter(Boolean);
};

const revenueChannelFromCustomerGroup = (group: string | null | undefined) => {
  switch (String(group || "").toLowerCase()) {
    case "online":
      return "online";
    case "banhmi_agency":
      return "agency";
    case "b2b":
      return "b2b";
    case "banhmi_point":
    default:
      return "retail";
  }
};

type EmailCandidate = {
  customerId: string;
  customerName: string | null;
  revenueChannel: string | null;
  isNpp: boolean;
  suppliedByNppCustomerId: string | null;
};

const dedupeCandidates = (candidates: EmailCandidate[]) => {
  const byId = new Map<string, EmailCandidate>();
  for (const candidate of candidates) {
    if (!candidate?.customerId) continue;
    byId.set(candidate.customerId, candidate);
  }
  return Array.from(byId.values());
};

const resolveEmailCandidates = (candidates: EmailCandidate[]) => {
  const deduped = dedupeCandidates(candidates);
  const activeRoots = deduped.filter((candidate) => !candidate.suppliedByNppCustomerId);
  const rootNpps = activeRoots.filter((candidate) => candidate.isNpp);

  if (rootNpps.length === 1) {
    const rootNpp = rootNpps[0];
    const sameNppDependents = deduped.filter(
      (candidate) => candidate.suppliedByNppCustomerId && candidate.suppliedByNppCustomerId === rootNpp.customerId,
    );
    const outsideRootGroup = deduped.filter(
      (candidate) => candidate.customerId !== rootNpp.customerId && candidate.suppliedByNppCustomerId !== rootNpp.customerId,
    );
    if (sameNppDependents.length > 0 && outsideRootGroup.length === 0) {
      return {
        match: rootNpp,
        candidates: deduped,
        resolution: "npp_parent",
      } as const;
    }
  }

  if (activeRoots.length === 1) {
    return {
      match: activeRoots[0],
      candidates: deduped,
      resolution: "single_root",
    } as const;
  }

  if (deduped.length === 1) {
    return {
      match: deduped[0],
      candidates: deduped,
      resolution: "single_candidate",
    } as const;
  }

  return {
    match: null,
    candidates: deduped,
    resolution: deduped.length > 1 ? "ambiguous" : "unmatched",
  } as const;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    requireCronSecret(req, "PO_INGEST_CRON_SECRET", getCorsHeaders(req));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json().catch(() => ({}));
    const emails: IncomingEmail[] = Array.isArray(body?.emails) ? body.emails : [];

    if (!emails.length) {
      return new Response(JSON.stringify({ success: true, ingested: 0, note: "No emails provided" }), {
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const { data: crmEmails, error: crmError } = await supabase
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(customer_name,customer_group,is_active,is_npp,supplied_by_npp_customer_id)")
      .order("created_at", { ascending: true });

    if (crmError) throw crmError;

    const emailMap = new Map<string, EmailCandidate[]>();
    for (const row of crmEmails || []) {
      const customer = (row as any).mini_crm_customers || {};
      const isActive = Boolean(customer?.is_active);
      if (!isActive) continue;
      const expanded = explodeEmails(String((row as any).email || ""));
      const candidate: EmailCandidate = {
        customerId: String((row as any).customer_id || ""),
        customerName: customer?.customer_name ? String(customer.customer_name) : null,
        revenueChannel: revenueChannelFromCustomerGroup(customer?.customer_group || null),
        isNpp: Boolean(customer?.is_npp),
        suppliedByNppCustomerId: customer?.supplied_by_npp_customer_id ? String(customer.supplied_by_npp_customer_id) : null,
      };
      if (!candidate.customerId) continue;
      for (const key of expanded) {
        const existing = emailMap.get(key) || [];
        existing.push(candidate);
        emailMap.set(key, existing);
      }
    }

    let ingested = 0;
    for (const item of emails) {
      const fromEmail = normalizeEmail(String(item.fromEmail || ""));
      if (!fromEmail) continue;

      const candidateMatches = emailMap.get(fromEmail) || [];
      const resolvedMatch = resolveEmailCandidates(candidateMatches);
      const match = resolvedMatch.match;
      const matchStatus = match ? "pending_approval" : "unmatched";

      const payload = {
        gmail_message_id: item.messageId || null,
        gmail_thread_id: item.threadId || null,
        from_email: fromEmail,
        from_name: item.fromName || null,
        email_subject: item.subject || null,
        body_preview: item.bodyPreview || null,
        has_attachments: Boolean(item.hasAttachments),
        attachment_names: item.attachmentNames || [],
        received_at: item.receivedAt || new Date().toISOString(),
        matched_customer_id: match?.customerId || null,
        match_status: matchStatus,
        revenue_channel: match?.revenueChannel || null,
        raw_payload: {
          ...(item.rawPayload || item),
          customer_match_resolution: resolvedMatch.resolution,
          customer_match_candidates: resolvedMatch.candidates.map((candidate) => ({
            customer_id: candidate.customerId,
            customer_name: candidate.customerName,
            is_npp: candidate.isNpp,
            supplied_by_npp_customer_id: candidate.suppliedByNppCustomerId,
          })),
        },
      };

      const query = supabase.from("customer_po_inbox").upsert(payload, {
        onConflict: "gmail_message_id",
        ignoreDuplicates: false,
      });

      const { error } = await query;
      if (error) throw error;
      ingested += 1;
    }

    return new Response(JSON.stringify({ success: true, ingested }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-ingest] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
