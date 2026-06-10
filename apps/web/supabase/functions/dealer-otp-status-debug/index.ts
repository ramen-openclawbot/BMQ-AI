import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const encoder = new TextEncoder();

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safePreview(value: unknown) {
  return JSON.stringify(value)
    .replace(/(\b84\d{2})\d{3,5}(\d{3}\b)/g, "$1***$2")
    .replace(/(\b0\d{2})\d{3,5}(\d{3}\b)/g, "$1***$2")
    .replace(
      /("(?:access[_-]?token|token|secret|signature)"\s*:\s*")[^"]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4000);
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
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
    encoder.encode(input),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method !== "POST")
    return jsonResponse(405, { error: "method_not_allowed" });

  const debugSecret = Deno.env.get("DEALER_OTP_STATUS_DEBUG_SECRET") || "";
  const relayUrl = Deno.env.get("DEALER_OTP_RELAY_URL") || "";
  const relaySecret = Deno.env.get("DEALER_OTP_RELAY_SECRET") || "";
  const accessToken = Deno.env.get("DEALER_VIETGUYS_ACCESS_TOKEN") || "";
  const username = Deno.env.get("DEALER_VIETGUYS_USERNAME") || "";
  const oaId = Deno.env.get("DEALER_VIETGUYS_OA_ID") || "";

  if (
    !debugSecret ||
    !relayUrl ||
    !relaySecret ||
    !accessToken ||
    !username ||
    !oaId
  ) {
    return jsonResponse(503, { error: "debug_status_not_configured" });
  }

  let body: { secret?: unknown; transaction_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  if (String(body.secret || "") !== debugSecret) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const transactionIds = Array.isArray(body.transaction_ids)
    ? body.transaction_ids
        .map((item) => String(item))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  if (!transactionIds.length)
    return jsonResponse(400, { error: "missing_transaction_ids" });

  const relayBody = JSON.stringify({
    endpoint: "https://api.vietguys.biz:4438/zalo/v1/status",
    accessToken,
    payload: {
      username,
      oa_id: oaId,
      transaction_id: transactionIds,
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacSha256Hex(
    relaySecret,
    `${timestamp}.${relayBody}`,
  );

  const response = await fetch(relayUrl.replace(/\/send$/, "/status"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BMQ-Relay-Timestamp": timestamp,
      "X-BMQ-Relay-Signature": signature,
    },
    body: relayBody,
  });

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // keep text
  }

  return jsonResponse(response.ok ? 200 : 502, {
    ok: response.ok,
    status: response.status,
    provider_response:
      typeof payload === "string"
        ? safePreview(payload)
        : JSON.parse(safePreview(payload)),
  });
});
