// Persistent client device id for payroll attendance binding.
//
// The raw id is a random UUID created once per browser. The server stores only
// its SHA-256 (payroll_bn_payslip_sessions.device_hash); sending the raw id on
// every attendance call lets the Edge Function prove the session belongs to the
// same device. When localStorage is unavailable the id lives in memory for the
// page lifetime.

export const PAYSLIP_DEVICE_ID_STORAGE_KEY = "bmq_payslip_device_id";

export interface DeviceIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memoryStorage(): DeviceIdStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function defaultStorage(): DeviceIdStorage {
  try {
    const candidate = (globalThis as { localStorage?: DeviceIdStorage }).localStorage;
    if (candidate && typeof candidate.getItem === "function") return candidate;
  } catch {
    // Access can throw in hardened/private contexts; fall through to memory.
  }
  return memoryStorage();
}

export function isPayslipDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value.trim());
}

/** Random RFC-4122 v4 UUID with a getRandomValues fallback. */
export function createDeviceId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Trình duyệt không hỗ trợ tạo mã thiết bị.");
  }
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Read the stored id, create and persist one when missing/corrupt. */
export function getOrCreateDeviceId(storage: DeviceIdStorage = defaultStorage()): string {
  const existing = storage.getItem(PAYSLIP_DEVICE_ID_STORAGE_KEY);
  if (isPayslipDeviceId(existing)) return existing.trim().toLowerCase();

  const created = createDeviceId();
  storage.setItem(PAYSLIP_DEVICE_ID_STORAGE_KEY, created);
  return created;
}

export function clearDeviceId(storage: DeviceIdStorage = defaultStorage()): void {
  storage.removeItem?.(PAYSLIP_DEVICE_ID_STORAGE_KEY);
}
