// Browser-side delivery (Giao hàng) client for the luong.banhmique.vn portal.
//
// Talks only to payslip-delivery-today and payslip-delivery-complete. The
// server owns task generation, assignment, units and location attachment; this
// module maps the transport payload to camelCase and keeps the psp_ session +
// device headers consistent with attendance-api.ts.

import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { getOrCreateDeviceId } from "./device-id.ts";

export interface DeliveryItem {
  skuCode: string | null;
  productName: string;
  unit: string | null;
  quantity: number;
}

export type DeliveryTaskStatus = "pending" | "completed" | "cancelled";

export interface DeliveryTask {
  id: string;
  deliveryDate: string;
  destinationName: string;
  address: string;
  mapsLink: string;
  hasLocation: boolean;
  units: number;
  sortOrder: number;
  quantity: number;
  items: DeliveryItem[];
  dealerNote: string | null;
  status: DeliveryTaskStatus;
  completedAt: string | null;
  locationAttached: boolean;
}

export interface DeliveryToday {
  isDriver: boolean;
  deliveryDate: string;
  consentAccepted: boolean;
  consentRequiredVersion: string;
  consentAcceptedAt: string | null;
  baseUnitsPerDay: number;
  totalPoints: number;
  completedPoints: number;
  previousPendingPoints: number;
  deliveredQuantity: number;
  deliveryUnits: number;
  tasks: DeliveryTask[];
}

export interface DeliveryCompleteInput {
  taskId: string;
  photo: Blob;
  photoFileName?: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
}

export interface DeliveryCompleteResult {
  completedAt: string | null;
  locationAttached: boolean;
}

export interface PayrollDeliverySource {
  getToday(): Promise<DeliveryToday>;
  complete(input: DeliveryCompleteInput): Promise<DeliveryCompleteResult>;
}

export interface PayrollDeliveryApiOptions {
  baseUrl?: string;
  anonKey?: string;
  fetch?: typeof fetch;
  storage?: PayslipStorage;
  sessionKey?: string;
}

interface FunctionResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

function readEnv(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

function defaultBaseUrl(): string {
  const url = readEnv().VITE_SUPABASE_URL ?? "";
  return url ? `${url.replace(/\/+$/, "")}/functions/v1` : "";
}

function defaultStorage(): PayslipStorage {
  const candidate = (globalThis as { localStorage?: PayslipStorage }).localStorage;
  if (candidate && typeof candidate.getItem === "function") return candidate;
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

const DELIVERY_ERRORS: Record<string, string> = {
  consent_required: "Bạn cần đồng ý điều khoản chấm công (ảnh và vị trí) ở phần Chấm công trước.",
  delivery_photo_required: "Cần chụp ảnh bánh giao trước khi hoàn thành.",
  delivery_task_not_found: "Không tìm thấy điểm giao này. Vui lòng tải lại.",
  delivery_not_assigned: "Điểm giao này không còn giao cho bạn. Vui lòng tải lại.",
  delivery_already_completed: "Điểm này đã được hoàn thành.",
  delivery_task_not_pending: "Điểm này đã hoàn thành hoặc đã huỷ. Vui lòng tải lại.",
  delivery_date_closed: "Đã quá giờ hoàn thành điểm giao của ngày này.",
  payroll_bn_period_locked: "Tháng lương này đã chốt, không hoàn thành được nữa.",
};

const LOAD_ERROR = "Không tải được việc giao hàng. Vui lòng thử lại.";
const COMPLETE_ERROR = "Không hoàn thành được. Vui lòng thử lại.";

function messageFor(data: Record<string, unknown> | null, fallback: string): string {
  const code = typeof data?.code === "string" ? data.code : "";
  if (code && DELIVERY_ERRORS[code]) return DELIVERY_ERRORS[code];
  if (typeof data?.error === "string" && data.error.trim() !== "") return data.error;
  if (typeof data?.message === "string" && data.message.trim() !== "") return data.message;
  return fallback;
}

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function normalizeDeliveryTask(raw: Record<string, unknown>): DeliveryTask {
  const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  const status = raw.status === "completed" || raw.status === "cancelled" ? raw.status : "pending";
  return {
    id: str(raw.id),
    deliveryDate: str(raw.delivery_date),
    destinationName: str(raw.destination_name),
    address: str(raw.address),
    mapsLink: str(raw.maps_link),
    hasLocation: raw.has_location === true,
    units: num(raw.units),
    sortOrder: num(raw.sort_order),
    quantity: num(raw.quantity),
    items: items.map((item) => ({
      skuCode: strOrNull(item.sku_code),
      productName: str(item.product_name) || "Sản phẩm",
      unit: strOrNull(item.unit),
      quantity: num(item.quantity),
    })),
    dealerNote: strOrNull(raw.dealer_note),
    status,
    completedAt: strOrNull(raw.completed_at),
    locationAttached: raw.location_attached === true,
  };
}

export function normalizeDeliveryToday(data: Record<string, unknown> | null): DeliveryToday {
  const today = (data?.today ?? {}) as Record<string, unknown>;
  const consent = (data?.consent ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(today.tasks) ? (today.tasks as Record<string, unknown>[]) : [];
  return {
    isDriver: data?.is_driver === true || tasks.length > 0,
    deliveryDate: str(today.delivery_date ?? data?.delivery_date),
    consentAccepted: consent.accepted === true,
    consentRequiredVersion: str(consent.required_version),
    consentAcceptedAt: strOrNull(consent.accepted_at),
    baseUnitsPerDay: num(data?.base_units_per_day),
    totalPoints: num(today.total_points),
    completedPoints: num(today.completed_points),
    previousPendingPoints: num(today.previous_pending_points),
    deliveredQuantity: num(today.delivered_quantity),
    deliveryUnits: num(today.delivery_units),
    tasks: tasks.map(normalizeDeliveryTask).filter((task) => task.id !== ""),
  };
}

export function createPayrollDeliveryApi(options: PayrollDeliveryApiOptions = {}): PayrollDeliverySource {
  const env = readEnv();
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
  const anonKey = options.anonKey ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const storage = options.storage ?? defaultStorage();
  const sessionKey = options.sessionKey ?? PAYSLIP_SESSION_STORAGE_KEY;

  const headers = (): Record<string, string> => {
    const token = storage.getItem(sessionKey);
    if (!token) throw new PayslipSessionExpiredError();
    const result: Record<string, string> = {
      "x-payslip-session": token,
      "x-payslip-device": getOrCreateDeviceId(storage),
    };
    if (anonKey) {
      result.apikey = anonKey;
      result.Authorization = `Bearer ${anonKey}`;
    }
    return result;
  };

  const call = async (path: string, init: RequestInit): Promise<FunctionResult> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/${path}`, init);
    } catch {
      throw new Error("Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.");
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    return { ok: response.ok, status: response.status, data };
  };

  return {
    async getToday() {
      const result = await call("payslip-delivery-today", { method: "GET", headers: headers() });
      if (!result.ok) throw new Error(messageFor(result.data, LOAD_ERROR));
      return normalizeDeliveryToday(result.data);
    },

    async complete(input) {
      const form = new FormData();
      form.append("task_id", input.taskId);
      form.append("latitude", String(input.latitude));
      form.append("longitude", String(input.longitude));
      form.append("accuracy_m", String(input.accuracyM));
      form.append("device_captured_at", input.capturedAt);
      form.append(
        "photo",
        input.photo,
        input.photoFileName ?? (input.photo.type === "image/webp" ? "delivery.webp" : "delivery.jpg"),
      );
      const result = await call("payslip-delivery-complete", { method: "POST", headers: headers(), body: form });
      if (!result.ok) throw new Error(messageFor(result.data, COMPLETE_ERROR));
      return {
        completedAt: strOrNull(result.data?.completed_at),
        locationAttached: result.data?.location_attached === true,
      };
    },
  };
}
