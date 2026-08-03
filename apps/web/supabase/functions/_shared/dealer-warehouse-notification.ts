export type WarehouseOrderLine = {
  productName: string;
  unit: string | null;
  orderedQuantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  physicalQuantity: number;
  routeCustomerName: string | null;
  routeNote: string | null;
};

export type WarehouseOrderMessageInput = {
  orderNumber: string;
  customerName: string;
  submittedAt: string;
  requestedDeliveryDate: string | null;
  deliveryNote: string | null;
  customerNote: string | null;
  lines: WarehouseOrderLine[];
};

type ZaloGmfResponse = {
  data?: {
    message_id?: string;
    group_id?: string;
  };
  error?: number;
  message?: string;
};

const ZALO_GMF_TEXT_ENDPOINT = "https://openapi.zalo.me/v3.0/oa/group/message";

const formatQuantity = (value: number) => new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 3,
}).format(value);

const formatDeliveryDate = (value: string | null) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "⚠️ Chưa xác định";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
};

const formatSubmittedAt = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Chưa xác định";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "--";
  const day = valueOf("day");
  const month = valueOf("month");
  const year = valueOf("year");
  const hour = valueOf("hour");
  const minute = valueOf("minute");
  return `${day}/${month}/${year} ${hour}:${minute}`;
};

export function formatWarehouseOrderMessage(input: WarehouseOrderMessageInput): string {
  const grouped = new Map<string, WarehouseOrderLine[]>();
  input.lines.forEach((line) => {
    const routeName = line.routeCustomerName?.trim() || "Giao trực tiếp";
    const current = grouped.get(routeName) || [];
    current.push(line);
    grouped.set(routeName, current);
  });

  const sections: string[] = [];
  grouped.forEach((lines, routeName) => {
    const content = [`🚚 Điểm giao: ${routeName}`];
    lines.forEach((line) => {
      const unit = line.unit?.trim() || "đơn vị";
      content.push(
        `• ${line.productName}`,
        `  Đặt ${formatQuantity(line.orderedQuantity)} | `
          + `Đổi ${formatQuantity(line.exchangeQuantity)} | `
          + `Bù ${formatQuantity(line.makeupQuantity)}`,
        `  ➜ Kho cần giao: ${formatQuantity(line.physicalQuantity)} ${unit}`,
      );
      if (line.routeNote?.trim()) content.push(`  📝 Ghi chú: ${line.routeNote.trim()}`);
    });
    sections.push(content.join("\n"));
  });

  const totals = input.lines.reduce(
    (sum, line) => ({
      ordered: sum.ordered + line.orderedQuantity,
      exchange: sum.exchange + line.exchangeQuantity,
      makeup: sum.makeup + line.makeupQuantity,
      physical: sum.physical + line.physicalQuantity,
    }),
    { ordered: 0, exchange: 0, makeup: 0, physical: 0 },
  );
  const units = new Set(input.lines.map((line) => line.unit?.trim()).filter(Boolean));
  const totalUnit = units.size === 1 ? Array.from(units)[0] : "đơn vị";

  const message = [
    "📦 ĐƠN HÀNG MỚI TỪ DATHANG.BANHMIQUE.VN",
    "",
    `Mã đơn: ${input.orderNumber}`,
    `Khách đặt: ${input.customerName}`,
    `Thời gian đặt: ${formatSubmittedAt(input.submittedAt)}`,
    `Ngày giao: ${formatDeliveryDate(input.requestedDeliveryDate)}`,
    "",
    sections.join("\n\n"),
  ];

  if (input.deliveryNote?.trim()) message.push(`Ghi chú giao hàng: ${input.deliveryNote.trim()}`);
  if (input.customerNote?.trim()) message.push(`Ghi chú khách hàng: ${input.customerNote.trim()}`);
  message.push(
    "",
    "━━━━━━━━━━━━━━",
    "📊 TỔNG ĐƠN",
    `• Đặt mới: ${formatQuantity(totals.ordered)} ${totalUnit}`,
    `• Đổi: ${formatQuantity(totals.exchange)} ${totalUnit}`,
    `• Bù: ${formatQuantity(totals.makeup)} ${totalUnit}`,
    `✅ TỔNG KHO CẦN GIAO: ${formatQuantity(totals.physical)} ${totalUnit}`,
    "",
    "Nguồn: dathang.banhmique.vn",
  );
  return message.join("\n");
}

export async function refreshZaloOaAccessToken({
  appId,
  appSecret,
  refreshToken,
  fetchImpl = fetch,
}: {
  appId: string;
  appSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresInSeconds: number }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    app_id: appId,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl("https://oauth.zaloapp.com/v4/oa/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      secret_key: appSecret,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const nextAccessToken = String(payload.access_token || "").trim();
  const nextRefreshToken = String(payload.refresh_token || "").trim();
  const expiresInSeconds = Number(payload.expires_in);
  if (!response.ok || !nextAccessToken || !nextRefreshToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    const detail = String(payload.error_name || payload.error_reason || payload.message || response.statusText || "unknown_error");
    throw new Error(`Zalo OA token refresh failed: ${detail}`);
  }
  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    expiresInSeconds,
  };
}

export async function sendZaloGmfText(params: {
  accessToken: string;
  groupId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<{ messageId: string; groupId: string; providerResponse: ZaloGmfResponse }> {
  const request = params.fetchImpl || fetch;
  const response = await request(ZALO_GMF_TEXT_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      access_token: params.accessToken,
    },
    body: JSON.stringify({
      recipient: { group_id: params.groupId },
      message: { text: params.text },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  let payload: ZaloGmfResponse = {};
  try {
    payload = await response.json() as ZaloGmfResponse;
  } catch {
    throw new Error(`Zalo GMF returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || payload.error !== 0) {
    const reason = String(payload.message || `HTTP ${response.status}`).slice(0, 300);
    throw new Error(`Zalo GMF send failed: ${reason}`);
  }

  const messageId = String(payload.data?.message_id || "").trim();
  const groupId = String(payload.data?.group_id || params.groupId).trim();
  if (!messageId) throw new Error("Zalo GMF send succeeded without message_id");

  return { messageId, groupId, providerResponse: payload };
}
