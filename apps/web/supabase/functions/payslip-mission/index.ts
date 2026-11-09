import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  hashReportSessionToken,
  jsonResponse,
  readJsonBody,
} from "../_shared/report.ts";
import {
  hashPayslipDeviceId,
  normalizePayslipDeviceId,
  PAYSLIP_SESSION_TOKEN_PREFIX,
} from "../_shared/payslip-portal.ts";

// Employee-facing monthly mission + surprise gift endpoint.
//
// The employee is authenticated exactly like payslip-attendance-today: a live
// psp_ session bound to the x-payslip-device hash. Every read is scoped to the
// session employee. Content comes from data (campaign items/rules/draw); this
// function never hard-codes a mission title, item, amount or rule.

interface DbOffer {
  id: string;
  campaign_id: string;
  employee_code: string;
  gift_enabled: boolean;
  status: string;
  shift_start: string | null;
  offered_at: string;
  responded_at: string | null;
}

interface DbCampaign {
  id: string;
  code: string;
  title: string;
  summary: string | null;
  starts_on: string;
  ends_on: string;
  eligible_groups: string[] | null;
  items: unknown;
  rules: unknown;
  draw: unknown;
  status: string;
}

interface DbReview {
  earned: unknown;
  disqualified: boolean;
}

interface DbTicket {
  quarter: string;
  issued_at: string;
  void_reason: string | null;
}

interface SessionRow {
  id: string;
  employee_code: string;
  device_hash: string | null;
}

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.session_token || body.payslip_token || req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function extractDeviceId(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.device_id ?? req.headers.get("x-payslip-device");
  return normalizePayslipDeviceId(raw);
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function publicItems(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      key: typeof item.key === "string" ? item.key : "",
      label: typeof item.label === "string" ? item.label : "",
      detail: typeof item.detail === "string" ? item.detail : null,
      kind: typeof item.kind === "string" ? item.kind : "manual",
      amount_vnd: asNumber(item.amount_vnd),
    }))
    .filter((item) => item.key !== "");
}

function publicRules(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((rule): rule is string => typeof rule === "string")
    : [];
}

function publicDraw(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function publicCampaign(campaign: DbCampaign) {
  return {
    title: campaign.title,
    summary: campaign.summary,
    starts_on: campaign.starts_on,
    ends_on: campaign.ends_on,
    items: publicItems(campaign.items),
    rules: publicRules(campaign.rules),
    draw: publicDraw(campaign.draw),
  };
}

async function buildOfferPayload(
  supabase: ReturnType<typeof createServiceClient>,
  offer: DbOffer,
  campaign: DbCampaign,
) {
  const [progressResult, reviewResult, ticketResult] = await Promise.all([
    supabase.rpc("payroll_mission_progress", { p_offer_id: offer.id }),
    supabase
      .from("payroll_mission_reviews")
      .select("earned, disqualified")
      .eq("offer_id", offer.id)
      .maybeSingle(),
    supabase
      .from("payroll_mission_draw_tickets")
      .select("quarter, issued_at, void_reason")
      .eq("campaign_id", offer.campaign_id)
      .eq("employee_code", offer.employee_code)
      .maybeSingle(),
  ]);

  if (progressResult.error) throw progressResult.error;
  if (reviewResult.error) throw reviewResult.error;
  if (ticketResult.error) throw ticketResult.error;

  const review = reviewResult.data as DbReview | null;
  const ticket = ticketResult.data as DbTicket | null;

  return {
    id: offer.id,
    status: offer.status,
    campaign: publicCampaign(campaign),
    progress: Array.isArray(progressResult.data) ? progressResult.data : [],
    review: review
      ? {
        earned: Array.isArray(review.earned) ? review.earned : [],
        disqualified: review.disqualified === true,
      }
      : null,
    ticket: ticket
      ? {
        quarter: ticket.quarter,
        issued_at: ticket.issued_at,
        void_reason: ticket.void_reason,
      }
      : null,
  };
}

async function authenticate(
  req: Request,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; supabase: ReturnType<typeof createServiceClient>; session: SessionRow }
  | { ok: false; response: Response }
> {
  const token = extractSessionToken(body, req);
  const deviceId = extractDeviceId(body, req);
  if (!token) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required"),
    };
  }
  if (!deviceId) {
    return {
      ok: false,
      response: errorResponse(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required"),
    };
  }

  const supabase = createServiceClient();
  const tokenHash = await hashReportSessionToken(token);
  const deviceHash = await hashPayslipDeviceId(deviceId);
  const now = new Date().toISOString();

  const sessionResult = await supabase
    .from("payroll_bn_payslip_sessions")
    .select("id, employee_code, device_hash, expires_at")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();
  if (sessionResult.error) throw sessionResult.error;

  const session = sessionResult.data as SessionRow | null;
  if (!session) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid"),
    };
  }
  if (!session.device_hash) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên này chưa gắn thiết bị. Vui lòng đăng nhập lại.", 401, "device_not_bound"),
    };
  }
  if (!deviceHash || session.device_hash !== deviceHash) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập không khớp thiết bị. Vui lòng đăng nhập lại.", 401, "device_mismatch"),
    };
  }

  // Turning a phone off in the Nhân viên tab cuts access immediately.
  const contactResult = await supabase
    .from("payroll_bn_employee_contacts")
    .select("employee_code")
    .eq("employee_code", session.employee_code)
    .eq("active", true)
    .maybeSingle();
  if (contactResult.error) throw contactResult.error;
  if (!contactResult.data) {
    await supabase
      .from("payroll_bn_payslip_sessions")
      .update({ revoked_at: now })
      .eq("id", session.id);
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid"),
    };
  }

  await supabase
    .from("payroll_bn_payslip_sessions")
    .update({ last_seen_at: now })
    .eq("id", session.id);

  return { ok: true, supabase, session };
}

async function findOpenOffer(
  supabase: ReturnType<typeof createServiceClient>,
  employeeCode: string,
): Promise<{ offer: DbOffer; campaign: DbCampaign } | null> {
  const offersResult = await supabase
    .from("payroll_mission_offers")
    .select("id, campaign_id, employee_code, gift_enabled, status, shift_start, offered_at, responded_at")
    .eq("employee_code", employeeCode)
    .eq("gift_enabled", true)
    .order("offered_at", { ascending: false });
  if (offersResult.error) throw offersResult.error;

  const offers = (offersResult.data ?? []) as DbOffer[];
  const campaignIds = [...new Set(offers.map((offer) => offer.campaign_id))];
  if (campaignIds.length === 0) return null;

  const campaignsResult = await supabase
    .from("payroll_mission_campaigns")
    .select("id, code, title, summary, starts_on, ends_on, eligible_groups, items, rules, draw, status")
    .in("id", campaignIds)
    .eq("status", "active");
  if (campaignsResult.error) throw campaignsResult.error;

  const campaigns = new Map<string, DbCampaign>();
  for (const campaign of (campaignsResult.data ?? []) as DbCampaign[]) {
    campaigns.set(campaign.id, campaign);
  }

  const eligible = offers.filter((offer) => campaigns.has(offer.campaign_id));
  if (eligible.length === 0) return null;

  eligible.sort((left, right) => {
    const leftPending = left.status === "pending" ? 1 : 0;
    const rightPending = right.status === "pending" ? 1 : 0;
    if (leftPending !== rightPending) return rightPending - leftPending;

    const leftCampaign = campaigns.get(left.campaign_id)!;
    const rightCampaign = campaigns.get(right.campaign_id)!;
    const byStart = rightCampaign.starts_on.localeCompare(leftCampaign.starts_on);
    if (byStart !== 0) return byStart;
    return String(right.offered_at).localeCompare(String(left.offered_at));
  });

  return { offer: eligible[0], campaign: campaigns.get(eligible[0].campaign_id)! };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch {
      return errorResponse(req, "Dữ liệu nhiệm vụ không hợp lệ.", 400, "invalid_json");
    }

    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
    if (action !== "get" && action !== "respond") {
      return errorResponse(req, "Thao tác nhiệm vụ không hợp lệ.", 400, "invalid_action");
    }

    const authenticated = await authenticate(req, body);
    if (!authenticated.ok) return authenticated.response;
    const { supabase, session } = authenticated;

    if (action === "get") {
      const open = await findOpenOffer(supabase, session.employee_code);
      if (!open) {
        return jsonResponse(req, { success: true, offer: null });
      }
      const offer = await buildOfferPayload(supabase, open.offer, open.campaign);
      return jsonResponse(req, { success: true, offer });
    }

    const offerId = typeof body.offer_id === "string" ? body.offer_id.trim() : "";
    if (!/^[0-9a-fA-F-]{36}$/.test(offerId)) {
      return errorResponse(req, "Nhiệm vụ không hợp lệ.", 400, "offer_id_required");
    }

    const decision = typeof body.decision === "string" ? body.decision.trim().toLowerCase() : "";
    if (decision !== "accept" && decision !== "decline") {
      return errorResponse(req, "Lựa chọn nhiệm vụ không hợp lệ.", 400, "invalid_decision");
    }

    // The employee can only ever see/respond to their own offer.
    const offerResult = await supabase
      .from("payroll_mission_offers")
      .select("id, campaign_id, employee_code, gift_enabled, status, shift_start, offered_at, responded_at")
      .eq("id", offerId)
      .eq("employee_code", session.employee_code)
      .maybeSingle();
    if (offerResult.error) throw offerResult.error;

    const offer = offerResult.data as DbOffer | null;
    if (!offer || offer.gift_enabled !== true) {
      return errorResponse(req, "Nhiệm vụ không còn mở.", 404, "offer_not_found");
    }

    const campaignResult = await supabase
      .from("payroll_mission_campaigns")
      .select("id, code, title, summary, starts_on, ends_on, eligible_groups, items, rules, draw, status")
      .eq("id", offer.campaign_id)
      .eq("status", "active")
      .maybeSingle();
    if (campaignResult.error) throw campaignResult.error;

    const campaign = campaignResult.data as DbCampaign | null;
    if (!campaign) {
      return errorResponse(req, "Nhiệm vụ không còn mở.", 404, "offer_not_found");
    }

    const desired = decision === "accept" ? "accepted" : "declined";
    if (offer.status !== "pending") {
      if (offer.status === desired) {
        const payload = await buildOfferPayload(supabase, offer, campaign);
        return jsonResponse(req, { success: true, offer: payload });
      }
      return errorResponse(req, "Nhiệm vụ đã được phản hồi.", 409, "offer_already_responded");
    }

    const now = new Date().toISOString();
    const updateResult = await supabase
      .from("payroll_mission_offers")
      .update({ status: desired, responded_at: now })
      .eq("id", offer.id)
      .eq("employee_code", session.employee_code)
      .eq("status", "pending")
      .select("id");
    if (updateResult.error) throw updateResult.error;

    const updatedResult = await supabase
      .from("payroll_mission_offers")
      .select("id, campaign_id, employee_code, gift_enabled, status, shift_start, offered_at, responded_at")
      .eq("id", offer.id)
      .eq("employee_code", session.employee_code)
      .maybeSingle();
    if (updatedResult.error) throw updatedResult.error;

    const updated = updatedResult.data as DbOffer | null;
    if (!updated) {
      return errorResponse(req, "Nhiệm vụ không còn mở.", 404, "offer_not_found");
    }
    if (updated.status !== desired) {
      return errorResponse(req, "Nhiệm vụ đã được phản hồi.", 409, "offer_already_responded");
    }

    const payload = await buildOfferPayload(supabase, updated, campaign);
    return jsonResponse(req, { success: true, offer: payload });
  } catch (error) {
    console.error("[payslip-mission] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể tải nhiệm vụ. Vui lòng thử lại sau.",
      500,
      "payslip_mission_failed",
    );
  }
});
