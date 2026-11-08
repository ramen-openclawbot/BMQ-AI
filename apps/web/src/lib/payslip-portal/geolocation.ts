// Thin, testable wrapper around navigator.geolocation for the attendance UI.
//
// The precision contract is fixed: high accuracy, a 15-second timeout and
// maximumAge 0 (never reuse a stale fix). Browser errors become stable reason
// codes and actionable Vietnamese guidance for Chrome desktop/Android.

export const GEOLOCATION_TIMEOUT_MS = 15_000;

export type GeolocationReasonCode =
  | "insecure_context"
  | "geolocation_unsupported"
  | "permission_denied"
  | "position_unavailable"
  | "timeout";

export interface GeolocationPoint {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

export type GeolocationResult =
  | { ok: true; point: GeolocationPoint }
  | { ok: false; reasonCode: GeolocationReasonCode; message: string; guidance: string };

interface BrowserPosition {
  coords: { latitude: number; longitude: number; accuracy: number };
}

interface BrowserPositionError {
  code: number;
}

export interface GeolocationDeps {
  geolocation?: {
    getCurrentPosition(
      success: (position: BrowserPosition) => void,
      error: (error: BrowserPositionError) => void,
      options?: PositionOptions,
    ): void;
  } | null;
  isSecureContext?: boolean;
  protocol?: string;
  hostname?: string;
  userAgent?: string;
}

function defaultDeps(): GeolocationDeps {
  const navigatorLike = (globalThis as {
    navigator?: { geolocation?: GeolocationDeps["geolocation"]; userAgent?: string };
  }).navigator;
  const locationLike = (globalThis as { location?: { protocol?: string; hostname?: string } }).location;
  return {
    geolocation: navigatorLike?.geolocation ?? null,
    isSecureContext: (globalThis as { isSecureContext?: boolean }).isSecureContext,
    protocol: locationLike?.protocol,
    hostname: locationLike?.hostname,
    userAgent: navigatorLike?.userAgent,
  };
}

/**
 * Geolocation only works over HTTPS (localhost is the development exception).
 * When the API is unavailable we fail closed with an explicit reason.
 */
export function isSecureGeolocationContext(deps: GeolocationDeps = defaultDeps()): boolean {
  if (deps.isSecureContext === false) return false;
  const protocol = deps.protocol ?? "";
  const hostname = deps.hostname ?? "";
  if (protocol === "https:") return true;
  if (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")) return true;
  return deps.isSecureContext === true;
}

/** Actionable Chrome guidance, tailored to Android vs desktop. */
export function getGeolocationGuidance(userAgent: string): string {
  const ua = String(userAgent || "");
  if (/Android/i.test(ua) && /Chrome|CriOS/i.test(ua)) {
    return "Trên Chrome Android: bấm ⋮ → Cài đặt trang → Quyền → Vị trí → Cho phép, rồi tải lại trang.";
  }
  if (/Chrome|CriOS|Edg/i.test(ua)) {
    return "Trên Chrome máy tính: bấm biểu tượng ổ khóa cạnh địa chỉ → Quyền vị trí → Cho phép, rồi tải lại trang.";
  }
  return "Vui lòng bật quyền vị trí cho trang này trong cài đặt trình duyệt rồi thử lại.";
}

function failure(
  reasonCode: GeolocationReasonCode,
  message: string,
  userAgent: string,
): GeolocationResult {
  return { ok: false, reasonCode, message, guidance: getGeolocationGuidance(userAgent) };
}

export function mapGeolocationErrorCode(errorCode: number): GeolocationReasonCode {
  if (errorCode === 1) return "permission_denied";
  if (errorCode === 3) return "timeout";
  return "position_unavailable";
}

const ERROR_MESSAGES: Record<GeolocationReasonCode, string> = {
  insecure_context: "Trình duyệt không cho phép lấy vị trí trên kết nối không bảo mật (HTTPS).",
  geolocation_unsupported: "Trình duyệt không hỗ trợ lấy vị trí GPS.",
  permission_denied: "Bạn chưa cho phép truy cập vị trí.",
  position_unavailable: "Không lấy được vị trí hiện tại. Vui lòng thử lại ở nơi thoáng hơn.",
  timeout: "Lấy vị trí quá lâu. Vui lòng thử lại.",
};

export function getCurrentLocation(deps: GeolocationDeps = defaultDeps()): Promise<GeolocationResult> {
  const userAgent = deps.userAgent ?? "";

  if (!isSecureGeolocationContext(deps)) {
    return Promise.resolve(failure("insecure_context", ERROR_MESSAGES.insecure_context, userAgent));
  }

  if (!deps.geolocation || typeof deps.geolocation.getCurrentPosition !== "function") {
    return Promise.resolve(failure("geolocation_unsupported", ERROR_MESSAGES.geolocation_unsupported, userAgent));
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GeolocationResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      deps.geolocation!.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (![latitude, longitude, accuracy].every((value) => Number.isFinite(value))) {
            finish(failure("position_unavailable", ERROR_MESSAGES.position_unavailable, userAgent));
            return;
          }
          finish({ ok: true, point: { latitude, longitude, accuracyM: accuracy } });
        },
        (error) => {
          const reasonCode = mapGeolocationErrorCode(Number(error?.code));
          finish(failure(reasonCode, ERROR_MESSAGES[reasonCode], userAgent));
        },
        { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 0 },
      );
    } catch {
      finish(failure("position_unavailable", ERROR_MESSAGES.position_unavailable, userAgent));
    }
  });
}
