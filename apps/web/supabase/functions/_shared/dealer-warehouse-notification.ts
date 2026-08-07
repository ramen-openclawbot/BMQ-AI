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

export type WarehouseDailyDigestInput = {
  digestDate: string;
  generatedAt: string;
  orders: WarehouseOrderMessageInput[];
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

export const defaultDeliveryDateTPlusOne = (submittedAt: string): string | null => {
  const submittedDate = new Date(submittedAt);
  if (Number.isNaN(submittedDate.getTime())) return null;
  const nextDay = new Date(submittedDate.getTime() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nextDay);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = valueOf("year");
  const month = valueOf("month");
  const day = valueOf("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
};

export const isValidDeliveryDate = (value: string | null): value is string => {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day);
};

const formatDeliveryDate = (value: string | null, submittedAt: string) => {
  const deliveryDate = isValidDeliveryDate(value)
    ? value
    : defaultDeliveryDateTPlusOne(submittedAt);
  if (!deliveryDate) return "⚠️ Chưa xác định";
  const [year, month, day] = deliveryDate.split("-");
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

const formatDateKey = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "Chưa xác định";
};

type PointProduct = WarehouseOrderLine & { notes: string[] };
type WarehousePoint = { name: string; products: PointProduct[] };

const groupWarehousePoints = (orders: WarehouseOrderMessageInput[]): WarehousePoint[] => {
  const points = new Map<string, Map<string, PointProduct>>();
  orders.forEach((order) => {
    order.lines.forEach((line) => {
      const pointName = line.routeCustomerName?.trim() || order.customerName.trim() || "Giao trực tiếp";
      const productName = line.productName.trim() || "Sản phẩm BMQ";
      const unit = line.unit?.trim() || "đơn vị";
      const products = points.get(pointName) || new Map<string, PointProduct>();
      const key = `${productName}\u0000${unit}`;
      const current = products.get(key);
      const note = line.routeNote?.trim();
      products.set(key, {
        ...line,
        productName,
        unit,
        orderedQuantity: (current?.orderedQuantity || 0) + line.orderedQuantity,
        exchangeQuantity: (current?.exchangeQuantity || 0) + line.exchangeQuantity,
        makeupQuantity: (current?.makeupQuantity || 0) + line.makeupQuantity,
        physicalQuantity: (current?.physicalQuantity || 0) + line.physicalQuantity,
        notes: Array.from(new Set([...(current?.notes || []), ...(note ? [note] : [])])),
      });
      points.set(pointName, products);
    });
  });
  return Array.from(points, ([name, products]) => ({ name, products: Array.from(products.values()) }));
};

const groupWarehouseDealers = (orders: WarehouseOrderMessageInput[]): WarehousePoint[] => {
  const dealers = new Map<string, Map<string, PointProduct>>();
  orders.forEach((order) => {
    const dealerName = order.customerName.trim() || order.orderNumber;
    const products = dealers.get(dealerName) || new Map<string, PointProduct>();
    order.lines.forEach((line) => {
      const productName = line.productName.trim() || "Sản phẩm BMQ";
      const unit = line.unit?.trim() || "đơn vị";
      const key = `${productName}\u0000${unit}`;
      const current = products.get(key);
      products.set(key, {
        ...line,
        productName,
        unit,
        orderedQuantity: (current?.orderedQuantity || 0) + line.orderedQuantity,
        exchangeQuantity: (current?.exchangeQuantity || 0) + line.exchangeQuantity,
        makeupQuantity: (current?.makeupQuantity || 0) + line.makeupQuantity,
        physicalQuantity: (current?.physicalQuantity || 0) + line.physicalQuantity,
        notes: [],
      });
    });
    dealers.set(dealerName, products);
  });
  return Array.from(dealers, ([name, products]) => ({ name, products: Array.from(products.values()) }));
};

const quantitySummary = (line: WarehouseOrderLine) => {
  const parts: string[] = [];
  if (line.orderedQuantity > 0) parts.push(`Đặt ${formatQuantity(line.orderedQuantity)}`);
  if (line.exchangeQuantity > 0) parts.push(`Đổi ${formatQuantity(line.exchangeQuantity)}`);
  if (line.makeupQuantity > 0) parts.push(`Bù ${formatQuantity(line.makeupQuantity)}`);
  return parts.join(" + ") || "Không có số lượng";
};

const pointSections = (points: WarehousePoint[]) => points.map((point, index) => {
  const content = [`${String(index + 1).padStart(2, "0")}. ${point.name}`];
  point.products.forEach((line) => {
    const unit = line.unit?.trim() || "đơn vị";
    content.push(
      `    ${line.productName}: ${quantitySummary(line)}`,
      `    → GIAO ${formatQuantity(line.physicalQuantity)} ${unit}`,
    );
    line.notes.forEach((note) => content.push(`    📝 Ghi chú: ${note}`));
  });
  return content.join("\n");
});

const warehouseTotals = (points: WarehousePoint[]) => points.flatMap((point) => point.products).reduce(
  (sum, line) => ({
    ordered: sum.ordered + line.orderedQuantity,
    exchange: sum.exchange + line.exchangeQuantity,
    makeup: sum.makeup + line.makeupQuantity,
    physical: sum.physical + line.physicalQuantity,
  }),
  { ordered: 0, exchange: 0, makeup: 0, physical: 0 },
);

const totalUnitFor = (points: WarehousePoint[]) => {
  const units = new Set(points.flatMap((point) => point.products)
    .map((line) => line.unit?.trim()).filter(Boolean));
  return units.size === 1 ? Array.from(units)[0] as string : "đơn vị";
};

const totalsSection = (points: WarehousePoint[]) => {
  const totals = warehouseTotals(points);
  const totalUnit = totalUnitFor(points);
  return [
    "━━━━━━━━━━━━━━━━",
    "📊 TỔNG KHO",
    "",
    `Đặt mới: ${formatQuantity(totals.ordered)} ${totalUnit}`,
    `Đổi: ${formatQuantity(totals.exchange)} ${totalUnit}`,
    `Bù: ${formatQuantity(totals.makeup)} ${totalUnit}`,
    "",
    `✅ KHO CẦN GIAO: ${formatQuantity(totals.physical)} ${totalUnit.toUpperCase()}`,
  ];
};

export function formatWarehouseOrderMessage(input: WarehouseOrderMessageInput): string {
  const points = groupWarehousePoints([input]);
  const submitted = formatSubmittedAt(input.submittedAt);
  const [submittedDate, submittedTime] = submitted.split(" ");

  const message = [
    "📦 ĐƠN BÁNH ĐẠI LÝ MỚI",
    "",
    `Ngày giao: ${formatDeliveryDate(input.requestedDeliveryDate, input.submittedAt)}`,
    `Mã đơn: ${input.orderNumber}`,
    `Đơn vị đặt: ${input.customerName}`,
    `${points.length} điểm bán • Đặt lúc ${submittedTime || "--:--"} ${submittedDate?.slice(0, 5) || "--/--"}`,
    "",
    "━━ CHI TIẾT ĐIỂM GIAO ━━",
    "",
    pointSections(points).join("\n\n"),
  ];

  if (input.deliveryNote?.trim()) message.push(`Ghi chú giao hàng: ${input.deliveryNote.trim()}`);
  if (input.customerNote?.trim()) message.push(`Ghi chú khách hàng: ${input.customerNote.trim()}`);
  message.push(
    "",
    ...totalsSection(points),
    "",
    "Nguồn: dathang.banhmique.vn",
  );
  return message.join("\n");
}

const formatWarehouseDailyDigest = (
  input: WarehouseDailyDigestInput,
  entities: WarehousePoint[],
  title: string,
  entityLabel: "đại lý" | "điểm bán",
) => {
  const generated = formatSubmittedAt(input.generatedAt);
  const generatedTime = generated.split(" ")[1] || "--:--";
  const header = [
    title,
    "",
    `Ngày: ${formatDateKey(input.digestDate)}`,
    `${input.orders.length} đơn • ${entities.length} ${entityLabel}`,
    `Chốt lúc: ${generatedTime}`,
    "",
    `━━ CHI TIẾT ${entityLabel.toUpperCase()} ━━`,
    "",
  ];
  const footer = ["", ...totalsSection(entities), "", "Nguồn: dathang.banhmique.vn"];
  const sections = pointSections(entities);
  const included: string[] = [];
  const maxLength = 9_500;
  const omissionReserve = 80;
  const fixedLength = [...header, ...footer].join("\n").length;
  let detailLength = 0;
  for (const section of sections) {
    const addedLength = section.length + (included.length > 0 ? 2 : 0);
    if (fixedLength + detailLength + addedLength + omissionReserve > maxLength) break;
    included.push(section);
    detailLength += addedLength;
  }
  const omitted = sections.length - included.length;
  if (omitted > 0) included.push(`… Còn ${omitted} ${entityLabel}; xem chi tiết ở các tin đơn phía trên.`);

  return [...header, included.join("\n\n"), ...footer].join("\n");
};

export function formatWarehouseDealerDailyDigest(input: WarehouseDailyDigestInput): string {
  return formatWarehouseDailyDigest(
    input,
    groupWarehouseDealers(input.orders),
    "📦 TỔNG KẾT THEO ĐẠI LÝ — CUỐI NGÀY",
    "đại lý",
  );
}

export function formatWarehousePointDailyDigest(input: WarehouseDailyDigestInput): string {
  return formatWarehouseDailyDigest(
    input,
    groupWarehousePoints(input.orders),
    "📍 TỔNG KẾT THEO ĐIỂM BÁN — CUỐI NGÀY",
    "điểm bán",
  );
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
