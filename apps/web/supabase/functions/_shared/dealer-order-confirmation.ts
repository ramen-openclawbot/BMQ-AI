export type DealerOrderConfirmationTemplateData = {
  ten_khach_hang: string;
  ma_don_hang: string;
  ngay_dat: string;
  ngay_giao: string;
  tong_so_luong: string;
  tong_tien: string;
};

export type DealerOrderConfirmationInput = {
  customerName: string;
  orderNumber: string;
  submittedAt: string;
  requestedDeliveryDate: string;
  orderedQuantity: number;
  exchangeQuantity?: number;
  makeupQuantity?: number;
  physicalQuantity?: number;
  totalAmountVnd: number;
};

type VietGuysOrderConfirmationRequestInput = {
  username: string;
  phoneNormalized: string;
  trackingId: string;
  oaId: string;
  templateId: string;
  templateData: DealerOrderConfirmationTemplateData;
};

type SendOrderConfirmationInput = VietGuysOrderConfirmationRequestInput & {
  endpoint: string;
  accessToken: string;
  relayUrl?: string | null;
  relaySecret?: string | null;
  fetchImpl?: typeof fetch;
};

const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const encoder = new TextEncoder();

const requireText = (value: string, label: string, maxLength: number) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
};

const requireNonNegativeFinite = (value: number, label: string) => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
};

const formatNumberVi = (value: number, maximumFractionDigits = 3) =>
  new Intl.NumberFormat("vi-VN", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);

const formatVietnamDateFromTimestamp = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid submittedAt");
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VIETNAM_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
};

const formatIsoDate = (value: string) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Invalid requestedDeliveryDate");
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error("Invalid requestedDeliveryDate");
  }
  return `${day}/${month}/${year}`;
};

export function buildDealerOrderConfirmationTemplateData(
  input: DealerOrderConfirmationInput,
): DealerOrderConfirmationTemplateData {
  const orderedQuantity = requireNonNegativeFinite(input.orderedQuantity, "orderedQuantity");
  const totalAmountVnd = requireNonNegativeFinite(input.totalAmountVnd, "totalAmountVnd");

  return {
    ten_khach_hang: requireText(input.customerName, "customerName", 120),
    ma_don_hang: requireText(input.orderNumber, "orderNumber", 80),
    ngay_dat: formatVietnamDateFromTimestamp(input.submittedAt),
    ngay_giao: formatIsoDate(input.requestedDeliveryDate),
    tong_so_luong: formatNumberVi(orderedQuantity),
    tong_tien: `${formatNumberVi(Math.round(totalAmountVnd), 0)} đ`,
  };
}

export function dealerOrderConfirmationFailureTransition(sendLeaseCommitted: boolean, error: unknown) {
  const safeError = String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 430);
  const errorPrefix = sendLeaseCommitted
    ? "manual_reconciliation_required"
    : "pre_send_validation_failed";
  return {
    expectedStatus: sendLeaseCommitted ? "send_committed" : "processing",
    nextStatus: sendLeaseCommitted ? "send_committed" : "failed",
    lastError: `${errorPrefix}: ${safeError}`,
  } as const;
}

export function buildVietGuysOrderConfirmationRequest(input: VietGuysOrderConfirmationRequestInput) {
  return {
    username: requireText(input.username, "username", 200),
    mobile: requireText(input.phoneNormalized, "phoneNormalized", 20),
    tracking_id: requireText(input.trackingId, "trackingId", 200),
    zns: {
      oa_id: requireText(input.oaId, "oaId", 200),
      template_id: requireText(input.templateId, "templateId", 200),
      template_data: input.templateData,
    },
  };
}

const hmacSha256Hex = async (secret: string, input: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const sendViaRelay = async (params: {
  relayUrl: string;
  relaySecret: string;
  endpoint: string;
  accessToken: string;
  providerRequestBody: Record<string, unknown>;
  fetchImpl: typeof fetch;
}) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    endpoint: params.endpoint,
    accessToken: params.accessToken,
    payload: params.providerRequestBody,
  });
  const signature = await hmacSha256Hex(params.relaySecret, `${timestamp}.${body}`);
  return params.fetchImpl(params.relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BMQ-Relay-Timestamp": timestamp,
      "X-BMQ-Relay-Signature": signature,
    },
    body,
  });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const providerErrorCode = (payload: unknown) => {
  const row = asRecord(payload);
  if ("error" in row) return Number(row.error);
  if ("resultCode" in row) return Number(row.resultCode);
  return 0;
};

const providerMessageId = (payload: unknown) => {
  const row = asRecord(payload);
  const data = asRecord(row.data);
  for (const value of [data.message_id, data.msg_id, row.message_id, row.msg_id, row.requestId]) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized.slice(0, 250);
  }
  return null;
};

const safeProviderFailure = (payload: unknown) => {
  const row = asRecord(payload);
  const code = row.error_code ?? row.resultCode ?? row.error ?? "unknown";
  const message = String(row.message ?? row.error_message ?? "provider rejected request")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  return `code=${String(code).slice(0, 80)} ${message}`;
};

export async function sendDealerOrderConfirmationZns(input: SendOrderConfirmationInput): Promise<{
  provider: "vietguys_zbs_order_confirmation";
  messageId: string | null;
  response: unknown;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const providerRequestBody = buildVietGuysOrderConfirmationRequest(input);
  const relayUrl = String(input.relayUrl || "").trim();
  const relaySecret = String(input.relaySecret || "").trim();
  const response = relayUrl && relaySecret
    ? await sendViaRelay({
      relayUrl,
      relaySecret,
      endpoint: requireText(input.endpoint, "endpoint", 500),
      accessToken: requireText(input.accessToken, "accessToken", 1000),
      providerRequestBody,
      fetchImpl,
    })
    : await fetchImpl(requireText(input.endpoint, "endpoint", 500), {
      method: "POST",
      headers: {
        "Access-Token": requireText(input.accessToken, "accessToken", 1000),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(providerRequestBody),
    });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("VietGuys order confirmation send failed: provider returned a non-JSON response");
  }

  if (!response.ok || providerErrorCode(payload) !== 0) {
    throw new Error(`VietGuys order confirmation send failed: ${safeProviderFailure(payload)}`);
  }

  return {
    provider: "vietguys_zbs_order_confirmation",
    messageId: providerMessageId(payload),
    response: payload,
  };
}
