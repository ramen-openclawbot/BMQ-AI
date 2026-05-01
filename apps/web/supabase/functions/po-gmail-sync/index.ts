import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

type GmailMessage = {
  id: string;
  threadId: string;
};

type EmailCandidate = {
  customerId: string;
  customerName: string | null;
  revenueChannel: string | null;
  isNpp: boolean;
  suppliedByNppCustomerId: string | null;
};

const extractPoNumber = (subject: string) => {
  const m = subject.match(/PO\s*([0-9]{6,})/i) || subject.match(/\b(PO[0-9]{6,})\b/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

const extractDeliveryDate = (subject: string) => {
  const m = subject.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
};

const decodeBase64Url = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const base64 = normalized + padding;
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
};

const normalizeEmail = (value: string) => {
  const raw = String(value || "").trim().toLowerCase();
  const inBracket = raw.match(/<([^>]+)>/)?.[1] || raw;
  const candidate = inBracket.trim();
  const direct = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (direct) return direct.toLowerCase();
  const fallback = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  return (fallback || candidate).trim().toLowerCase();
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

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  // backward compatibility: fallback to old shared token key
  const { data: legacyTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value || legacyTokenData?.value;

  if (!refreshToken) {
    throw new Error("Chưa kết nối Gmail PO hoặc thiếu refresh token");
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Thiếu GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Không thể refresh Google access token: ${err}`);
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${err}`);
  }
  return await res.json();
}


const KINGFOOD_AUTOMATION = {
  sender: "dathang@kingfoodmart.com",
  xlsxName: "Export-PO-Data.xlsx",
} as const;

const toNum = (v: any) => {
  const raw = String(v ?? "").trim();
  if (!raw) return 0;
  const s = raw.replace(/[^\d,.-]/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  const normalize = (input: string, decimalSep: "," | ".") => {
    const parts = input.split(decimalSep);
    if (parts.length === 1) return input.replace(/[,.]/g, "");
    const decimal = parts.pop() || "";
    const integer = parts.join("").replace(/[,.]/g, "");
    return `${integer}.${decimal}`;
  };
  let normalized = s;
  if (hasComma && hasDot) normalized = s.lastIndexOf(",") > s.lastIndexOf(".") ? normalize(s, ",") : normalize(s, ".");
  else if (hasComma) normalized = /,\d{1,2}$/.test(s) ? normalize(s, ",") : s.replace(/,/g, "");
  else if (hasDot) normalized = /\.\d{1,2}$/.test(s) ? normalize(s, ".") : s.replace(/\./g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};

const decodeBase64UrlToBytes = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + padding);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const sanitizeVat = (subtotal: number, vat: number) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  if (s <= 0) return 0;
  if (v <= 0 || v > s * 0.3) return Math.round(s * 0.08);
  return v;
};

const sanitizeTotal = (subtotal: number, vat: number, total: number) => {
  const expected = Number(subtotal || 0) + Number(vat || 0);
  const t = Number(total || 0);
  if (expected <= 0) return t > 0 ? t : 0;
  if (t <= 0 || t > expected * 1.5 || t < expected * 0.5) return expected;
  return t;
};

function parseKingfoodXlsx(bytes: Uint8Array) {
  const workbook = XLSX.read(bytes, { type: "array" });
  let best = { sheetName: null as string | null, items: [] as any[], subtotal: 0, vat: 0, total: 0, totalQty: 0, itemCount: 0 };

  for (const sheetName of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    const items = rows
      .map((row) => {
        const sku = String(row?.[14] || "").trim();
        const productName = String(row?.[15] || "").trim();
        const qty = toNum(row?.[17] ?? row?.[18] ?? 0);
        const unitPrice = toNum(row?.[20]);
        const explicitLineTotal = toNum(row?.[31]);
        return {
          date: String(row?.[11] || "").trim(),
          product_name: productName,
          source_column_name: "row_item",
          sku,
          qty,
          unit: String(row?.[16] || "").trim(),
          unit_price: unitPrice,
          line_total: explicitLineTotal || qty * unitPrice,
        };
      })
      .filter((item) => /^SP\d+/i.test(item.sku) && item.product_name && item.qty > 0);

    const firstItemRow = rows.find((row) => /^SP\d+/i.test(String(row?.[14] || "").trim())) || [];
    const subtotal = toNum(firstItemRow?.[33]);
    const vat = toNum(firstItemRow?.[34]);
    const total = toNum(firstItemRow?.[35]);
    const totalQty = toNum(firstItemRow?.[37]);
    const itemCount = toNum(firstItemRow?.[38]);

    if (items.length > best.items.length) {
      best = { sheetName, items, subtotal, vat, total, totalQty, itemCount };
    }
  }

  const itemSubtotal = best.items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
  const itemQty = best.items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const subtotal = best.subtotal > 0 ? best.subtotal : itemSubtotal;
  const vat = sanitizeVat(subtotal, best.vat);
  const total = sanitizeTotal(subtotal, vat, best.total);
  const subtotalDiff = Math.abs(itemSubtotal - subtotal);
  const qtyDiff = best.totalQty > 0 ? Math.abs(itemQty - best.totalQty) : 0;
  const itemCountDiff = best.itemCount > 0 ? Math.abs(best.items.length - best.itemCount) : 0;

  return {
    ...best,
    subtotal,
    vat,
    total,
    itemSubtotal,
    itemQty,
    subtotalDiff,
    qtyDiff,
    itemCountDiff,
    isValid: best.items.length > 0 && subtotalDiff <= 1 && qtyDiff <= 1 && itemCountDiff <= 0,
  };
}

const isKingfoodCancelSubject = (subject: string) => /THÔNG\s*BÁO\s*H[ỦUỶY]|HUY\s*DON|HỦY\s*ĐƠN|HUỶ\s*ĐƠN/i.test(subject || "");

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Enforce JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "preview").toLowerCase(); // preview | import
    const includeOnlyCrm = body?.includeOnlyCrm !== false;
    const maxResults = Math.min(Math.max(Number(body?.maxResults || 20), 1), 100);
    const query = String(body?.query || "in:anywhere deliveredto:po@bmq.vn newer_than:30d");
    const importMessageIds = new Set<string>(Array.isArray(body?.messageIds) ? body.messageIds.map((x: any) => String(x)) : []);

    const accessToken = await getGoogleAccessToken(supabaseAdmin);

    const profile = await gmailApi(accessToken, "profile");
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    const messages: GmailMessage[] = Array.isArray(list?.messages) ? list.messages : [];

    const { data: crmEmails } = await supabaseAdmin
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(customer_name,customer_group,is_active,is_npp,supplied_by_npp_customer_id)");

    const emailMap = new Map<string, EmailCandidate[]>();
    for (const row of crmEmails || []) {
      const rawEmail = String((row as any).email || "");
      const expanded = explodeEmails(rawEmail);
      const customer = (row as any).mini_crm_customers || {};
      const isActive = Boolean(customer?.is_active);
      if (!isActive) continue;
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

    const activeCustomerIds = Array.from(
      new Set(Array.from(emailMap.values()).flat().map((v) => v.customerId).filter(Boolean)),
    );
    const { data: activeTemplates } = await supabaseAdmin
      .from("mini_crm_po_templates")
      .select("id, customer_id, template_name, file_name, parser_config, sample_preview, is_active, updated_at")
      .eq("is_active", true)
      .in("customer_id", activeCustomerIds.length ? activeCustomerIds : ["00000000-0000-0000-0000-000000000000"]);

    const templateMap = new Map<string, any>();
    for (const t of activeTemplates || []) {
      templateMap.set(String((t as any).customer_id), t);
    }

    let synced = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let nppResolvedCount = 0;
    let skippedInvalidFrom = 0;
    let upsertErrorCount = 0;
    let skippedNotInCrm = 0;
    const skippedNotInCrmSamples: string[] = [];
    const upsertErrors: Array<{ messageId: string; error: string }> = [];
    const previews: any[] = [];

    for (const m of messages) {
      const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
      const headers: Array<{ name: string; value: string }> = detail?.payload?.headers || [];

      const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateHeader = getHeader("Date");

      const fromEmail = normalizeEmail(from);
      if (!fromEmail || !fromEmail.includes("@")) {
        skippedInvalidFrom += 1;
        continue;
      }
      const fromName = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : null;

      const snippet = detail?.snippet || "";
      const attachmentParts: Array<{ filename: string; mimeType: string; attachmentId: string | null }> = [];
      const attachmentNames: string[] = [];

      const walkParts = (parts: any[] = []) => {
        for (const p of parts) {
          if (p?.filename) {
            const filename = String(p.filename);
            attachmentNames.push(filename);
            attachmentParts.push({
              filename,
              mimeType: String(p?.mimeType || ""),
              attachmentId: p?.body?.attachmentId ? String(p.body.attachmentId) : null,
            });
          }
          if (Array.isArray(p?.parts)) walkParts(p.parts);
        }
      };
      walkParts(detail?.payload?.parts || []);

      const candidateMatches = emailMap.get(fromEmail) || [];
      const resolvedMatch = resolveEmailCandidates(candidateMatches);
      const match = resolvedMatch.match;
      if (match) {
        matchedCount += 1;
        if (resolvedMatch.resolution === "npp_parent") nppResolvedCount += 1;
      } else {
        unmatchedCount += 1;
        if (resolvedMatch.resolution === "ambiguous") ambiguousCount += 1;
      }

      if (includeOnlyCrm && !match) {
        skippedNotInCrm += 1;
        if (skippedNotInCrmSamples.length < 5) skippedNotInCrmSamples.push(fromEmail);
        continue;
      }

      const template = match?.customerId ? templateMap.get(match.customerId) : null;

      const isKingfoodSender = fromEmail === KINGFOOD_AUTOMATION.sender;
      const xlsxFile = attachmentParts.find((a) => a.filename === KINGFOOD_AUTOMATION.xlsxName && a.attachmentId);
      const pdfFile = attachmentParts.find((a) => a.filename.toLowerCase().endsWith(".pdf"));
      const isCancelSignal = isKingfoodSender && isKingfoodCancelSubject(subject || "");

      let kingfoodAutomation: any = isKingfoodSender
        ? {
            rule: "kingfood_po_automation",
            sender: KINGFOOD_AUTOMATION.sender,
            automation_status: "needs_manual_review",
            reason: "Kingfood email does not match a supported attachment pattern",
            has_xlsx: Boolean(xlsxFile),
            has_pdf: Boolean(pdfFile),
            source_xlsx: xlsxFile?.filename || null,
            source_pdf: pdfFile?.filename || null,
          }
        : null;
      let parsedItems: any[] | null = null;
      let parsedSubtotal: number | null = null;
      let parsedVat: number | null = null;
      let parsedTotal: number | null = null;

      if (isCancelSignal && kingfoodAutomation) {
        kingfoodAutomation = {
          ...kingfoodAutomation,
          automation_status: "cancel_signal",
          reason: "Kingfood cancellation email; do not create a normal PO/revenue draft",
        };
      } else if (isKingfoodSender && xlsxFile?.attachmentId && kingfoodAutomation) {
        try {
          const attachment = await gmailApi(accessToken, `messages/${m.id}/attachments/${xlsxFile.attachmentId}`);
          const parsed = parseKingfoodXlsx(decodeBase64UrlToBytes(String(attachment?.data || "")));
          parsedItems = parsed.items;
          parsedSubtotal = parsed.subtotal || null;
          parsedVat = parsed.vat || 0;
          parsedTotal = parsed.total || parsed.subtotal || null;
          kingfoodAutomation = {
            ...kingfoodAutomation,
            automation_status: parsed.isValid ? "parsed_valid" : "parsed_needs_review",
            reason: parsed.isValid ? "Kingfood Export-PO-Data.xlsx parsed and totals validated" : "Kingfood XLSX parsed but totals/item count need review",
            source_sheet: parsed.sheetName,
            item_count: parsed.items.length,
            subtotal: parsed.subtotal,
            vat_amount: parsed.vat,
            total_amount: parsed.total,
            item_subtotal: parsed.itemSubtotal,
            item_qty: parsed.itemQty,
            subtotal_diff: parsed.subtotalDiff,
            qty_diff: parsed.qtyDiff,
            item_count_diff: parsed.itemCountDiff,
          };
        } catch (parseError) {
          kingfoodAutomation = {
            ...kingfoodAutomation,
            automation_status: "parse_failed_needs_review",
            reason: parseError instanceof Error ? parseError.message : "Kingfood XLSX parse failed",
          };
        }
      } else if (isKingfoodSender && pdfFile && kingfoodAutomation) {
        kingfoodAutomation = {
          ...kingfoodAutomation,
          automation_status: "pdf_only_needs_review",
          reason: "Kingfood email has PDF but no Export-PO-Data.xlsx; PDF parser/manual review required",
        };
      }

      const payload = {
        gmail_message_id: m.id,
        gmail_thread_id: m.threadId,
        from_email: fromEmail,
        from_name: fromName,
        email_subject: subject || null,
        body_preview: snippet || null,
        has_attachments: attachmentNames.length > 0,
        attachment_names: attachmentNames,
        received_at: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
        matched_customer_id: match?.customerId || null,
        match_status: match ? (kingfoodAutomation?.automation_status === "cancel_signal" ? "error" : "pending_approval") : "unmatched",
        revenue_channel: match?.revenueChannel || null,
        po_number: extractPoNumber(subject || ""),
        delivery_date: extractDeliveryDate(subject || ""),
        production_items: parsedItems,
        subtotal_amount: parsedSubtotal,
        vat_amount: parsedVat,
        total_amount: parsedTotal,
        raw_payload: {
          gmail_id: m.id,
          thread_id: m.threadId,
          snippet,
          subject,
          from,
          template_id: template?.id || null,
          template_name: template?.template_name || null,
          po_automation: kingfoodAutomation,
          parse_meta: kingfoodAutomation?.automation_status === "parsed_valid"
            ? {
                source: "kingfood_gmail_sync_auto",
                parser: "po-gmail-sync:kingfood:v1",
                parsed_at: new Date().toISOString(),
                source_xlsx: xlsxFile?.filename || null,
                source_pdf: pdfFile?.filename || null,
                item_count: parsedItems?.length || 0,
                subtotal: parsedSubtotal,
                vat_amount: parsedVat,
                total_amount: parsedTotal,
                subtotal_source: "kingfood_sheet_subtotal_col_33",
                template_id: template?.id || null,
                template_name: template?.template_name || null,
                parse_mode: "kingfood_sender_rule",
              }
            : null,
          customer_match_resolution: resolvedMatch.resolution,
          customer_match_candidates: resolvedMatch.candidates.map((candidate) => ({
            customer_id: candidate.customerId,
            customer_name: candidate.customerName,
            is_npp: candidate.isNpp,
            supplied_by_npp_customer_id: candidate.suppliedByNppCustomerId,
          })),
        },
      };

      previews.push({
        messageId: m.id,
        threadId: m.threadId,
        fromEmail,
        fromName,
        subject: subject || "(no subject)",
        receivedAt: payload.received_at,
        snippet,
        attachmentNames,
        matchedCustomerId: match?.customerId || null,
        matchStatus: payload.match_status,
        matchResolution: resolvedMatch.resolution,
        matchCandidates: resolvedMatch.candidates.map((candidate) => ({
          customerId: candidate.customerId,
          customerName: candidate.customerName,
          isNpp: candidate.isNpp,
          suppliedByNppCustomerId: candidate.suppliedByNppCustomerId,
        })),
        template: template
          ? {
              id: template.id,
              name: template.template_name,
              fileName: template.file_name,
              parserConfig: template.parser_config,
              samplePreview: template.sample_preview,
              updatedAt: template.updated_at,
            }
          : null,
      });

      const shouldImport = mode === "import" && (importMessageIds.size === 0 || importMessageIds.has(m.id));
      if (!shouldImport) continue;

      const { error } = await supabaseAdmin.from("customer_po_inbox").upsert(payload, { onConflict: "gmail_message_id" });
      if (error) {
        upsertErrorCount += 1;
        if (upsertErrors.length < 5) {
          upsertErrors.push({ messageId: m.id, error: String(error.message || error) });
        }
        continue;
      }
      synced += 1;
    }

    const { count: inboxCount } = await supabaseAdmin
      .from("customer_po_inbox")
      .select("id", { count: "exact", head: true });

    return new Response(JSON.stringify({
      success: true,
      mode,
      includeOnlyCrm,
      synced,
      query,
      mailbox: profile?.emailAddress || null,
      resultSizeEstimate: Number(list?.resultSizeEstimate || 0),
      fetched: messages.length,
      previews,
      debug: {
        matchedCount,
        unmatchedCount,
        ambiguousCount,
        nppResolvedCount,
        skippedInvalidFrom,
        skippedNotInCrm,
        skippedNotInCrmSamples,
        upsertErrorCount,
        upsertErrors,
        inboxCount: Number(inboxCount || 0),
      },
    }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-sync] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
