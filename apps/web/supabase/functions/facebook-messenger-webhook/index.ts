import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  constantTimeStringEqual,
  DEFAULT_MESSENGER_LIMITS,
  normalizeMessengerWebhook,
  type NormalizedMessengerEvent,
  verifyMessengerSignature,
} from "../_shared/facebook-messenger.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type MessengerWebhookEnv = {
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_APP_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export type MessengerSettings = {
  page_id: string;
  agent_email_forward_enabled: boolean;
};

export type IngestEventParams = {
  p_event_fingerprint: string;
  p_page_id: string;
  p_psid: string;
  p_event_type: string;
  p_event_timestamp: string;
  p_messenger_message_id: string | null;
  p_direction: "inbound" | "outbound" | null;
  p_message_text: string | null;
  p_event_payload: JsonValue;
  p_delivery_message_ids: string;
  p_reply_window_expires_at: string | null;
  p_human_agent_window_expires_at: string | null;
  p_email_forward_enabled: boolean;
  p_email_recipient: string | null;
  p_email_fingerprint: string | null;
  p_email_payload: JsonValue | null;
};

export type MessengerWebhookDeps = {
  fetchSettings: () => Promise<MessengerSettings>;
  ingestEvent: (event: IngestEventParams) => Promise<unknown>;
  requestId?: () => string;
};

const AGENT_EMAIL_RECIPIENT = "inboxoggxdk@agent.instinct.co";
const MAX_CHALLENGE_CHARS = 256;
const STANDARD_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function handleMessengerWebhook(
  request: Request,
  env: MessengerWebhookEnv = Deno.env.toObject(),
  deps?: MessengerWebhookDeps,
): Promise<Response> {
  const requestId = deps?.requestId?.() ?? crypto.randomUUID();

  if (request.method === "GET") {
    return handleVerify(request, env);
  }

  if (request.method !== "POST") {
    return textResponse("METHOD_NOT_ALLOWED", 405);
  }

  if (!env.META_APP_SECRET) {
    console.warn("facebook_messenger_webhook_missing_app_secret", { requestId });
    return textResponse("SERVICE_UNAVAILABLE", 503);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return textResponse("PAYLOAD_TOO_LARGE", 413);
    if (Number(declaredLength) > DEFAULT_MESSENGER_LIMITS.maxBodyBytes) {
      return textResponse("PAYLOAD_TOO_LARGE", 413);
    }
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > DEFAULT_MESSENGER_LIMITS.maxBodyBytes) {
    return textResponse("PAYLOAD_TOO_LARGE", 413);
  }

  const signatureOk = await verifyMessengerSignature({
    rawBody,
    signatureHeader: request.headers.get("x-hub-signature-256"),
    appSecret: env.META_APP_SECRET,
  });
  if (!signatureOk) {
    console.warn("facebook_messenger_webhook_wrong_signature_rejected", { requestId });
    return textResponse("wrong_signature_rejected", 403);
  }

  let activeDeps: MessengerWebhookDeps;
  try {
    activeDeps = deps ?? createSupabaseDeps(env);
  } catch {
    console.warn("facebook_messenger_webhook_supabase_config_unavailable", { requestId });
    return textResponse("SERVICE_UNAVAILABLE", 503);
  }
  let settings: MessengerSettings;
  try {
    settings = await activeDeps.fetchSettings();
  } catch {
    console.warn("facebook_messenger_webhook_settings_unavailable", { requestId });
    return textResponse("SERVICE_UNAVAILABLE", 503);
  }

  if (!settings?.page_id) {
    console.warn("facebook_messenger_webhook_settings_missing_page", { requestId });
    return textResponse("SERVICE_UNAVAILABLE", 503);
  }

  const normalized = await normalizeMessengerWebhook({ rawBody, expectedPageId: settings.page_id });
  if (!normalized.ok) {
    if (normalized.error === "wrong_page" || normalized.error === "event_not_for_page") {
      console.warn("facebook_messenger_webhook_wrong_page_rejected", { requestId });
      return textResponse("wrong_page_rejected", 403);
    }
    console.warn("facebook_messenger_webhook_bad_payload", { requestId, error: normalized.error });
    return textResponse("BAD_REQUEST", 400);
  }

  try {
    for (const event of normalized.events) {
      await activeDeps.ingestEvent(await buildIngestParams(event, settings));
    }
  } catch {
    console.warn("facebook_messenger_webhook_ingest_failed", { requestId, eventCount: normalized.events.length });
    return textResponse("INGEST_FAILED", 500);
  }

  console.info("facebook_messenger_webhook_events_received", { requestId, eventCount: normalized.events.length });
  return textResponse("EVENT_RECEIVED", 200);
}

function handleVerify(request: Request, env: MessengerWebhookEnv): Response {
  const expected = env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return textResponse("SERVICE_UNAVAILABLE", 503);

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode") ?? "";
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (
    mode !== "subscribe" ||
    challenge.length === 0 ||
    challenge.length > MAX_CHALLENGE_CHARS ||
    !constantTimeStringEqual(token, expected)
  ) {
    return textResponse("FORBIDDEN", 403);
  }

  return textResponse(challenge, 200);
}

function createSupabaseDeps(env: MessengerWebhookEnv): MessengerWebhookDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("missing_supabase_config");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    fetchSettings: async () => {
      const { data, error } = await client
        .from("facebook_messenger_settings")
        .select("page_id,agent_email_forward_enabled")
        .eq("id", "00000000-0000-0000-0000-000000000001")
        .single();
      if (error) throw error;
      return data as MessengerSettings;
    },
    ingestEvent: async (event) => {
      const { data, error } = await client.rpc("facebook_ingest_messenger_webhook_event", event);
      if (error) throw error;
      return data;
    },
  };
}

async function buildIngestParams(
  event: NormalizedMessengerEvent,
  settings: MessengerSettings,
): Promise<IngestEventParams> {
  const psid = event.senderId === event.pageId ? event.recipientId : event.senderId;
  const direction = event.kind === "message" ? "inbound" : event.kind === "message_echo" ? "outbound" : null;
  const eventDate = new Date(event.timestampMs);
  const inbound = direction === "inbound";
  const conversationRef = await opaqueRef("fbconv", `${event.pageId}:${psid}`);
  const messagePreview = boundedText(event.text, 1_000);
  const emailForwardEnabled = Boolean(settings.agent_email_forward_enabled && inbound && messagePreview);

  const emailPayload = emailForwardEnabled
    ? {
      conversation_ref: conversationRef,
      sender_display: "Facebook sender",
      message_preview: messagePreview,
      received_at: eventDate.toISOString(),
      source: "facebook_messenger",
    }
    : null;

  return {
    p_event_fingerprint: event.fingerprint,
    p_page_id: event.pageId,
    p_psid: psid,
    p_event_type: event.kind,
    p_event_timestamp: eventDate.toISOString(),
    p_messenger_message_id: event.messengerMessageId,
    p_direction: direction,
    p_message_text: direction === null ? null : messagePreview,
    p_event_payload: sanitizedEventPayload(event, conversationRef),
    p_delivery_message_ids: JSON.stringify(event.deliveryMessageIds),
    p_reply_window_expires_at: inbound ? new Date(event.timestampMs + STANDARD_REPLY_WINDOW_MS).toISOString() : null,
    p_human_agent_window_expires_at: inbound ? new Date(event.timestampMs + HUMAN_AGENT_WINDOW_MS).toISOString() : null,
    p_email_forward_enabled: emailForwardEnabled,
    p_email_recipient: emailForwardEnabled ? AGENT_EMAIL_RECIPIENT : null,
    p_email_fingerprint: emailForwardEnabled ? await opaqueRef("fbemail", event.fingerprint) : null,
    p_email_payload: emailPayload,
  };
}

function sanitizedEventPayload(event: NormalizedMessengerEvent, conversationRef: string): JsonValue {
  return {
    event_type: event.kind,
    conversation_ref: conversationRef,
    messenger_message_id: boundedText(event.messengerMessageId, 512),
    message_preview: event.kind === "message" || event.kind === "message_echo" ? boundedText(event.text, 1_000) : null,
    attachments: event.attachments.slice(0, DEFAULT_MESSENGER_LIMITS.maxAttachmentsPerMessage) as JsonValue,
    delivery_message_ids: event.deliveryMessageIds.slice(0, DEFAULT_MESSENGER_LIMITS.maxDeliveryMids),
    watermark_ms: event.watermarkMs,
    postback_title: boundedText(event.postbackTitle, 512),
    postback_payload: boundedText(event.postbackPayload, 1_000),
    policy_action: boundedText(event.policyAction, 128),
    policy_reason: boundedText(event.policyReason, 512),
    occurred_at: new Date(event.timestampMs).toISOString(),
  };
}

function boundedText(value: string | null, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

async function opaqueRef(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

if (import.meta.main) {
  Deno.serve((request) => handleMessengerWebhook(request));
}
