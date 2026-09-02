const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type MessengerLimits = {
  maxBodyBytes: number;
  maxEntries: number;
  maxMessagingEventsPerEntry: number;
  maxTotalMessagingEvents: number;
  maxTextChars: number;
  maxAttachmentsPerMessage: number;
  maxAttachmentPayloadBytes: number;
  maxAttachmentUrlChars: number;
  maxDeliveryMids: number;
  maxPostbackPayloadChars: number;
  maxReferralRefChars: number;
  maxReferralSourceChars: number;
  maxReferralTypeChars: number;
};

export const DEFAULT_MESSENGER_LIMITS: MessengerLimits = {
  maxBodyBytes: 256 * 1024,
  maxEntries: 25,
  maxMessagingEventsPerEntry: 100,
  maxTotalMessagingEvents: 1_000,
  maxTextChars: 20_000,
  maxAttachmentsPerMessage: 10,
  maxAttachmentPayloadBytes: 16 * 1024,
  maxAttachmentUrlChars: 2_048,
  maxDeliveryMids: 100,
  maxPostbackPayloadChars: 10_000,
  maxReferralRefChars: 1_000,
  maxReferralSourceChars: 128,
  maxReferralTypeChars: 128,
};

const DEPRECATED_MESSENGER_TAGS = new Set([
  "CONFIRMED_EVENT_UPDATE",
  "ACCOUNT_UPDATE",
  "POST_PURCHASE_UPDATE",
]);

const STANDARD_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type RawMessengerEvent = Record<string, unknown>;

type NormalizeInput = {
  rawBody: Uint8Array;
  expectedPageId: string;
  limits?: Partial<MessengerLimits>;
};

export type MessengerEventKind =
  | "message"
  | "message_echo"
  | "message_delivery"
  | "message_read"
  | "messaging_referral"
  | "messaging_postback"
  | "messaging_policy_enforcement";

export type NormalizedMessengerEvent = {
  kind: MessengerEventKind;
  pageId: string;
  senderId: string;
  recipientId: string;
  timestampMs: number;
  messengerMessageId: string | null;
  fingerprint: string;
  text: string | null;
  attachments: Array<{ type: string; payload: unknown }>;
  deliveryMessageIds: string[];
  watermarkMs: number | null;
  postbackTitle: string | null;
  postbackPayload: string | null;
  referralRef: string | null;
  referralSource: string | null;
  referralType: string | null;
  policyAction: string | null;
  policyReason: string | null;
};

export type NormalizeResult =
  | { ok: true; object: "page"; events: NormalizedMessengerEvent[] }
  | { ok: false; error: string };

export type SignatureInput = {
  rawBody: Uint8Array;
  signatureHeader: string | null | undefined;
  appSecret: string;
};

export type MessengerSendPolicyInput = {
  requestedTag: string | null | undefined;
  nowMs: number;
  lastUserMessageAtMs: number | null | undefined;
  actorType?: "human" | "ai" | "system" | string;
  actorAuthenticated?: boolean;
  humanAgentFeatureEnabled?: boolean;
  humanAgentApproved?: boolean;
};

export type MessengerSendPolicyDecision =
  | { allowed: true; tag: "RESPONSE" | "HUMAN_AGENT" }
  | { allowed: false; reason: string };

export function constantTimeStringEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (aBytes[index] || 0) ^ (bBytes[index] || 0);
  }
  return diff === 0;
}

export async function verifyMessengerSignature(
  input: SignatureInput,
): Promise<boolean> {
  if (!input.appSecret || !input.signatureHeader) return false;
  const parsed = parseMessengerSignature(input.signatureHeader);
  if (!parsed) return false;
  const expected = await hmacSha256Hex(input.appSecret, input.rawBody);
  return constantTimeStringEqual(expected, parsed);
}

export async function normalizeMessengerWebhook(
  input: NormalizeInput,
): Promise<NormalizeResult> {
  const limits = { ...DEFAULT_MESSENGER_LIMITS, ...input.limits };
  if (!input.expectedPageId) {
    return { ok: false, error: "missing_expected_page_id" };
  }
  if (input.rawBody.byteLength > limits.maxBodyBytes) {
    return { ok: false, error: "body_too_large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(input.rawBody));
  } catch {
    return { ok: false, error: "malformed_json" };
  }

  if (!isRecord(parsed)) return { ok: false, error: "body_not_object" };
  if (parsed.object !== "page") return { ok: false, error: "wrong_object" };
  if (!Array.isArray(parsed.entry)) {
    return { ok: false, error: "missing_entry" };
  }
  if (parsed.entry.length > limits.maxEntries) {
    return { ok: false, error: "too_many_entries" };
  }

  const events: NormalizedMessengerEvent[] = [];
  let totalMessagingEvents = 0;
  for (const entry of parsed.entry) {
    if (!isRecord(entry)) return { ok: false, error: "malformed_entry" };
    if (entry.id !== input.expectedPageId) {
      return { ok: false, error: "wrong_page" };
    }
    if (!Array.isArray(entry.messaging)) {
      return { ok: false, error: "missing_messaging" };
    }
    if (entry.messaging.length > limits.maxMessagingEventsPerEntry) {
      return { ok: false, error: "too_many_messaging_events" };
    }
    totalMessagingEvents += entry.messaging.length;
    if (totalMessagingEvents > limits.maxTotalMessagingEvents) {
      return { ok: false, error: "too_many_messaging_events" };
    }

    for (const rawEvent of entry.messaging) {
      if (!isRecord(rawEvent)) return { ok: false, error: "malformed_event" };
      const normalized = await normalizeEvent(
        rawEvent,
        input.expectedPageId,
        limits,
      );
      if (normalized.ok === false) {
        return { ok: false, error: normalized.error };
      }
      events.push(normalized.event);
    }
  }

  return { ok: true, object: "page", events };
}

export function canApplyMessengerEventUpdate(input: {
  incomingTimestampMs: number;
  currentTimestampMs: number | null | undefined;
}): boolean {
  if (!isNonNegativeSafeInteger(input.incomingTimestampMs)) return false;
  if (
    input.currentTimestampMs === null || input.currentTimestampMs === undefined
  ) return true;
  if (!isNonNegativeSafeInteger(input.currentTimestampMs)) return true;
  return input.incomingTimestampMs >= input.currentTimestampMs;
}

export function evaluateMessengerSendPolicy(
  input: MessengerSendPolicyInput,
): MessengerSendPolicyDecision {
  const requestedTag = input.requestedTag || "RESPONSE";
  if (DEPRECATED_MESSENGER_TAGS.has(requestedTag)) {
    return { allowed: false, reason: "deprecated_tag_denied" };
  }
  if (!isNonNegativeSafeInteger(input.nowMs)) {
    return { allowed: false, reason: "invalid_now" };
  }
  if (!isNonNegativeSafeInteger(input.lastUserMessageAtMs)) {
    return { allowed: false, reason: "missing_last_user_message" };
  }

  const elapsedMs = input.nowMs - Number(input.lastUserMessageAtMs);
  if (elapsedMs < 0) {
    return { allowed: false, reason: "last_user_message_in_future" };
  }

  if (requestedTag === "RESPONSE") {
    return elapsedMs <= STANDARD_REPLY_WINDOW_MS
      ? { allowed: true, tag: "RESPONSE" }
      : { allowed: false, reason: "outside_standard_messaging_window" };
  }

  if (requestedTag === "HUMAN_AGENT") {
    if (!input.humanAgentFeatureEnabled) {
      return { allowed: false, reason: "human_agent_feature_disabled" };
    }
    if (!input.humanAgentApproved) {
      return { allowed: false, reason: "human_agent_not_approved" };
    }
    if (input.actorType !== "human" || input.actorAuthenticated !== true) {
      return {
        allowed: false,
        reason: "human_agent_requires_authenticated_human",
      };
    }
    return elapsedMs <= HUMAN_AGENT_WINDOW_MS
      ? { allowed: true, tag: "HUMAN_AGENT" }
      : { allowed: false, reason: "outside_human_agent_window" };
  }

  return { allowed: false, reason: "unsupported_tag" };
}

function parseMessengerSignature(header: string): string | null {
  const match = /^sha256=([a-f0-9]{64})$/.exec(header);
  return match ? match[1] : null;
}

async function hmacSha256Hex(
  secret: string,
  rawBody: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(rawBody),
  );
  return bytesToHex(new Uint8Array(signature));
}

async function normalizeEvent(
  rawEvent: RawMessengerEvent,
  pageId: string,
  limits: MessengerLimits,
): Promise<
  { ok: true; event: NormalizedMessengerEvent } | { ok: false; error: string }
> {
  const senderId = nestedString(rawEvent, "sender", "id");
  const recipientId = nestedString(rawEvent, "recipient", "id");
  const timestampMs = rawEvent.timestamp;
  if (!senderId || !recipientId || !isNonNegativeSafeInteger(timestampMs)) {
    return { ok: false, error: "missing_event_identity" };
  }
  const hasMessage = isRecord(rawEvent.message);
  const hasReferral = Object.hasOwn(rawEvent, "referral");
  if (
    !hasMessage && !hasReferral && senderId !== pageId && recipientId !== pageId
  ) {
    return { ok: false, error: "event_not_for_page" };
  }

  const base = {
    pageId,
    senderId,
    recipientId,
    timestampMs: Number(timestampMs),
    messengerMessageId: null,
    text: null,
    attachments: [],
    deliveryMessageIds: [],
    watermarkMs: null,
    postbackTitle: null,
    postbackPayload: null,
    referralRef: null,
    referralSource: null,
    referralType: null,
    policyAction: null,
    policyReason: null,
  } satisfies Omit<NormalizedMessengerEvent, "kind" | "fingerprint">;

  if (isRecord(rawEvent.message)) {
    const message = rawEvent.message;
    const text = optionalString(message.text);
    if (text !== null && text.length > limits.maxTextChars) {
      return { ok: false, error: "text_too_large" };
    }
    const attachments = normalizeAttachments(message.attachments, limits);
    if (attachments.ok === false) {
      return { ok: false, error: attachments.error };
    }
    const messengerMessageId = optionalString(message.mid);
    const kind: MessengerEventKind = message.is_echo === true
      ? "message_echo"
      : "message";
    if (!hasValidMessageDirection(kind, pageId, senderId, recipientId)) {
      return { ok: false, error: "invalid_message_direction" };
    }
    const eventForFingerprint = {
      ...base,
      kind,
      messengerMessageId,
      text,
      attachments: attachments.attachments,
    };
    return {
      ok: true,
      event: {
        ...eventForFingerprint,
        fingerprint: await buildFingerprint(
          kind,
          pageId,
          senderId,
          recipientId,
          Number(timestampMs),
          messengerMessageId,
          text,
          attachments.attachments,
        ),
      },
    };
  }

  if (isRecord(rawEvent.delivery)) {
    const delivery = rawEvent.delivery;
    const mids = Array.isArray(delivery.mids) ? delivery.mids : [];
    if (
      mids.length > limits.maxDeliveryMids ||
      !mids.every((mid) => typeof mid === "string")
    ) {
      return { ok: false, error: "invalid_delivery_mids" };
    }
    const watermarkMs = Number.isFinite(delivery.watermark)
      ? normalizeWatermark(delivery.watermark)
      : null;
    if (watermarkMs === false) return { ok: false, error: "invalid_watermark" };
    return completeEvent({
      ...base,
      kind: "message_delivery",
      deliveryMessageIds: mids,
      watermarkMs,
    });
  }

  if (isRecord(rawEvent.read)) {
    const watermarkMs = Number.isFinite(rawEvent.read.watermark)
      ? normalizeWatermark(rawEvent.read.watermark)
      : null;
    if (watermarkMs === false) return { ok: false, error: "invalid_watermark" };
    return completeEvent({ ...base, kind: "message_read", watermarkMs });
  }

  if (isRecord(rawEvent.postback)) {
    const title = optionalString(rawEvent.postback.title);
    const payload = optionalString(rawEvent.postback.payload);
    if (payload !== null && payload.length > limits.maxPostbackPayloadChars) {
      return { ok: false, error: "postback_payload_too_large" };
    }
    return completeEvent({
      ...base,
      kind: "messaging_postback",
      postbackTitle: title,
      postbackPayload: payload,
    });
  }

  if (Object.hasOwn(rawEvent, "referral")) {
    if (!hasValidReferralDirection(pageId, senderId, recipientId)) {
      return { ok: false, error: "invalid_referral_direction" };
    }
    const referral = normalizeReferral(rawEvent.referral, limits);
    if (referral.ok === false) return referral;
    return completeEvent({
      ...base,
      kind: "messaging_referral",
      referralRef: referral.ref,
      referralSource: referral.source,
      referralType: referral.type,
    });
  }

  if (isRecord(rawEvent.policy_enforcement)) {
    return completeEvent({
      ...base,
      kind: "messaging_policy_enforcement",
      policyAction: optionalString(rawEvent.policy_enforcement.action),
      policyReason: optionalString(rawEvent.policy_enforcement.reason),
    });
  }

  return { ok: false, error: "unsupported_event" };
}

async function completeEvent(
  event: Omit<NormalizedMessengerEvent, "fingerprint">,
): Promise<{ ok: true; event: NormalizedMessengerEvent }> {
  return {
    ok: true,
    event: {
      ...event,
      fingerprint: await buildFingerprint(
        event.kind,
        event.pageId,
        event.senderId,
        event.recipientId,
        event.timestampMs,
        event.messengerMessageId,
        event.text,
        event.attachments,
        event.deliveryMessageIds,
        event.watermarkMs,
        event.postbackPayload,
        event.referralRef,
        event.referralSource,
        event.referralType,
        event.policyAction,
        event.policyReason,
      ),
    },
  };
}

function normalizeReferral(
  value: unknown,
  limits: MessengerLimits,
):
  | { ok: true; ref: string | null; source: string | null; type: string | null }
  | {
    ok: false;
    error: string;
  } {
  if (!isRecord(value)) return { ok: false, error: "invalid_referral" };

  const ref = boundedOptionalString(value.ref, limits.maxReferralRefChars);
  const source = boundedOptionalString(
    value.source,
    limits.maxReferralSourceChars,
  );
  const type = boundedOptionalString(value.type, limits.maxReferralTypeChars);
  if (ref === false || source === false || type === false) {
    return { ok: false, error: "invalid_referral" };
  }
  if (ref === "too_large" || source === "too_large" || type === "too_large") {
    return { ok: false, error: "referral_field_too_large" };
  }

  return { ok: true, ref, source, type };
}

function normalizeAttachments(
  value: unknown,
  limits: MessengerLimits,
): { ok: true; attachments: Array<{ type: string; payload: unknown }> } | {
  ok: false;
  error: string;
} {
  if (value === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, error: "invalid_attachments" };
  if (value.length > limits.maxAttachmentsPerMessage) {
    return { ok: false, error: "too_many_attachments" };
  }
  const attachments: Array<{ type: string; payload: unknown }> = [];
  for (const attachment of value) {
    if (!isRecord(attachment) || typeof attachment.type !== "string") {
      return { ok: false, error: "invalid_attachment" };
    }
    const payload = normalizeAttachmentPayload(attachment.payload, limits);
    if (payload.ok === false) return payload;
    attachments.push({ type: attachment.type, payload: payload.payload });
  }
  return { ok: true, attachments };
}

function normalizeAttachmentPayload(
  value: unknown,
  limits: MessengerLimits,
): { ok: true; payload: Record<string, unknown> } | {
  ok: false;
  error: string;
} {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_attachment_payload" };
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return { ok: false, error: "invalid_attachment_payload" };
  }
  if (
    encoder.encode(serialized).byteLength > limits.maxAttachmentPayloadBytes
  ) {
    return { ok: false, error: "attachment_payload_too_large" };
  }

  if (Object.hasOwn(value, "url")) {
    if (!isValidAttachmentUrl(value.url, limits.maxAttachmentUrlChars)) {
      return { ok: false, error: "invalid_attachment_url" };
    }
  }

  return { ok: true, payload: value };
}

function isValidAttachmentUrl(value: unknown, maxChars: number): boolean {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maxChars
  ) return false;
  if (!value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.href === value;
  } catch {
    return false;
  }
}

async function buildFingerprint(
  kind: MessengerEventKind,
  pageId: string,
  senderId: string,
  recipientId: string,
  timestampMs: number,
  messengerMessageId: string | null,
  text: string | null,
  attachments: unknown,
  ...rest: unknown[]
): Promise<string> {
  const canonical = JSON.stringify({
    domain: "facebook-messenger-event-fingerprint-v1",
    kind,
    pageId,
    senderId,
    recipientId,
    timestampMs,
    messengerMessageId,
    text,
    attachments,
    rest,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonical),
  );
  return `fbmsg_${bytesToHex(new Uint8Array(digest))}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nestedString(
  value: Record<string, unknown>,
  key: string,
  nestedKey: string,
): string | null {
  const nested = value[key];
  return isRecord(nested) && typeof nested[nestedKey] === "string" &&
      nested[nestedKey]
    ? nested[nestedKey]
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedOptionalString(
  value: unknown,
  maxChars: number,
): string | null | false | "too_large" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  if (value.length > maxChars) return "too_large";
  return value;
}

function hasValidMessageDirection(
  kind: MessengerEventKind,
  pageId: string,
  senderId: string,
  recipientId: string,
): boolean {
  if (kind === "message") return senderId !== pageId && recipientId === pageId;
  if (kind === "message_echo") {
    return senderId === pageId && recipientId !== pageId;
  }
  return true;
}

function hasValidReferralDirection(
  pageId: string,
  senderId: string,
  recipientId: string,
): boolean {
  return senderId !== pageId && recipientId === pageId;
}

function normalizeWatermark(value: unknown): number | false {
  return isNonNegativeSafeInteger(value) ? value : false;
}
