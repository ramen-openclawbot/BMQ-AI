/**
 * Shared Gmail send helper for Supabase Edge Functions.
 *
 * Only the OAuth refresh token is read from app_settings; the access token and
 * refresh token never appear in logs or thrown errors.
 */

export class GmailSendError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = "GmailSendError";
    this.code = code;
  }
}

type SettingsDb = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{
          data: { value?: string | null } | null;
          error: unknown;
        }>;
      };
    };
  };
};

export type GmailFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SendGmailInput = {
  accessToken: string;
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  fetcher?: GmailFetcher;
};

export type SendGmailResult = {
  id: string;
  threadId: string;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function toBase64Url(value: string): string {
  return utf8ToBase64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trim();
}

/** RFC 2047 encoded-word for a UTF-8 header value. */
export function encodeHeaderValue(value: string): string {
  return `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

function encodeFromHeader(from: string): string {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return from;
  const displayName = match[1].trim();
  const address = match[2].trim();
  if (!displayName) return address;
  // Keep an ASCII display name readable; encode anything non-ASCII.
  if (/^[\x20-\x7E]+$/.test(displayName) && !/[\\"]/.test(displayName)) {
    return `${displayName} <${address}>`;
  }
  return `${encodeHeaderValue(displayName)} <${address}>`;
}

/** Build the RFC 2822 multipart/alternative message sent to Gmail. */
export function buildGmailRawMessage(input: {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}): string {
  const boundary = `bmq_order_${crypto.randomUUID()}`;
  const headers = [
    `From: ${encodeFromHeader(input.from)}`,
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const parts = [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(utf8ToBase64(input.text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(utf8ToBase64(input.html)),
    `--${boundary}--`,
    "",
  ];

  return parts.join("\r\n");
}

function errorCodeForStatus(status: number): string {
  if (status === 401) return "gmail_unauthorized";
  if (status === 403) return "gmail_forbidden";
  if (status === 429) return "gmail_rate_limited";
  return "gmail_send_failed";
}

/**
 * Exchange the stored refresh token for a short-lived Gmail access token.
 * Errors intentionally carry a stable code only.
 */
export async function getGmailAccessToken(
  db: SettingsDb,
  refreshTokenKey: string,
): Promise<string> {
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", refreshTokenKey)
    .maybeSingle();

  if (error || !data?.value) {
    throw new GmailSendError("gmail_refresh_token_missing");
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new GmailSendError("gmail_oauth_not_configured");
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: String(data.value),
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    throw new GmailSendError("gmail_token_refresh_failed");
  }

  if (!response.ok) {
    throw new GmailSendError("gmail_token_refresh_failed");
  }

  let tokens: { access_token?: string } | null = null;
  try {
    tokens = await response.json();
  } catch {
    tokens = null;
  }
  if (!tokens?.access_token) {
    throw new GmailSendError("gmail_access_token_missing");
  }
  return tokens.access_token;
}

/** Send one message through the Gmail API. */
export async function sendGmail(input: SendGmailInput): Promise<SendGmailResult> {
  const fetcher = input.fetcher ?? fetch;
  const raw = toBase64Url(buildGmailRawMessage(input));

  let response: Response;
  try {
    response = await fetcher(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
  } catch {
    // Never surface the fetch error: it may contain the request with the token.
    throw new GmailSendError("gmail_network_error");
  }

  if (!response.ok) {
    throw new GmailSendError(errorCodeForStatus(response.status));
  }

  let payload: { id?: string; threadId?: string } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!payload?.id) {
    throw new GmailSendError("gmail_response_invalid");
  }

  return { id: payload.id, threadId: payload.threadId ?? "" };
}
