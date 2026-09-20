/**
 * Language surface for the VNAgent data admin.
 *
 * The owner-only dataset admin is exposed only on `admin.banhmique.vn` (primary,
 * approved 2026-09-20) and, kept as a supported alias for existing links and
 * bookmarks, on `admin.vnagent.ai`. The legacy `/data-admin` route on other BMQ
 * hosts was removed (2026-09-21): admin is host-only, and that path is now an
 * ordinary not-found on non-admin hosts. On the admin surface the shared auth,
 * auth-timeout and session-recovery chrome must read as natural English. Every
 * other BMQ host keeps the exact existing Vietnamese copy.
 *
 * This module is intentionally dependency-free (no React, no Supabase) so it can
 * run before React mounts and stay trivially unit-testable.
 */

/** Primary owner-only admin host. */
export const ADMIN_PRIMARY_HOST = "admin.banhmique.vn";
/** Supported alias for the owner-only admin host (pre-existing links/bookmarks). */
export const VNAGENT_ADMIN_HOST = "admin.vnagent.ai";

/** Exact allow-list. Never a suffix/prefix match, so lookalike hosts stay out. */
export const ADMIN_HOSTS: readonly string[] = [ADMIN_PRIMARY_HOST, VNAGENT_ADMIN_HOST];

export type AdminSurfaceLanguage = "en" | "vi";

export function isVnagentAdminHostname(hostname: string): boolean {
  return ADMIN_HOSTS.includes(hostname);
}

/**
 * True when the current surface must render English host chrome. Admin is
 * host-only: the removed `/data-admin` path no longer selects English chrome.
 */
export function isEnglishAdminSurface(hostname?: string): boolean {
  const host = hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  return isVnagentAdminHostname(host);
}

export interface AdminHostCopy {
  auth: {
    /** Login page heading: admin surface reads "BMQ Administration". */
    title: string;
    oauthNotAuthorized: string;
    oauthExpired: string;
    loginFailed: string;
    signInError: string;
    signInSubtitle: string;
    signInButton: string;
    emailNote: string;
  };
  authTimeout: {
    title: string;
    body: string;
    refreshSession: string;
    retry: string;
    accessing: (path: string) => string;
  };
  recovery: {
    title: string;
    subtitle: string;
    alert: string;
    clearAndReload: string;
    plainReload: string;
    footerLine1: string;
    footerLine2: string;
  };
}

/**
 * Exact existing Vietnamese copy. Do not reword: every non-admin BMQ host must
 * keep the current strings byte-for-byte.
 */
const VIETNAMESE_COPY: AdminHostCopy = {
  auth: {
    title: "BMQ Procurement",
    oauthNotAuthorized:
      "Tài khoản Google chưa được cấp quyền truy cập hệ thống. Vui lòng liên hệ quản trị để được cấp quyền.",
    oauthExpired:
      "Phiên đăng nhập Google đã hết hạn hoặc bị xử lý trùng. Vui lòng bấm Đăng nhập bằng Google và thử lại.",
    loginFailed: "Đăng nhập thất bại. Vui lòng thử lại.",
    signInError: "Đã xảy ra lỗi. Vui lòng thử lại.",
    signInSubtitle: "Đăng nhập bằng tài khoản Google @bmq.vn",
    signInButton: "Đăng nhập bằng Google",
    emailNote: "Chỉ hỗ trợ email @bmq.vn",
  },
  authTimeout: {
    title: "Đang gặp sự cố kết nối",
    body: "Không thể xác thực phiên đăng nhập. Điều này thường xảy ra trên Safari.",
    refreshSession: "Làm mới phiên",
    retry: "Thử lại",
    accessing: (path) => `Đang cố truy cập: ${path}`,
  },
  recovery: {
    title: "Khôi phục phiên đăng nhập",
    subtitle: "Sử dụng trang này khi app bị kẹt không vào được",
    alert:
      'Nếu bạn đang thấy spinner quay mãi, hãy bấm "Xóa phiên & tải lại" để reset trạng thái đăng nhập.',
    clearAndReload: "Xóa phiên đăng nhập & tải lại",
    plainReload: "Thử tải lại bình thường",
    footerLine1: "Sau khi xóa phiên, bạn sẽ cần đăng nhập lại.",
    footerLine2: "Cài đặt ngôn ngữ và giao diện sẽ được giữ lại.",
  },
};

const ENGLISH_COPY: AdminHostCopy = {
  auth: {
    title: "BMQ Administration",
    oauthNotAuthorized:
      "This Google account has not been granted access. Please contact an administrator to request access.",
    oauthExpired:
      "Your Google sign-in session expired or was already used. Please click Sign in with Google and try again.",
    loginFailed: "Sign-in failed. Please try again.",
    signInError: "Something went wrong. Please try again.",
    signInSubtitle: "Sign in with your Google @bmq.vn account",
    signInButton: "Sign in with Google",
    emailNote: "@bmq.vn email accounts only",
  },
  authTimeout: {
    title: "Connection problem",
    body: "We couldn't verify your sign-in session. This usually happens on Safari.",
    refreshSession: "Refresh session",
    retry: "Try again",
    accessing: (path) => `Trying to access: ${path}`,
  },
  recovery: {
    title: "Recover your session",
    subtitle: "Use this page when the app is stuck and won't load",
    alert:
      'If you see a spinner that never stops, click "Clear session & reload" to reset the sign-in state.',
    clearAndReload: "Clear session & reload",
    plainReload: "Try a normal reload",
    footerLine1: "After clearing the session you will need to sign in again.",
    footerLine2: "Language and appearance settings will be kept.",
  },
};

export function adminHostCopyFor(isEnglish: boolean): AdminHostCopy {
  return isEnglish ? ENGLISH_COPY : VIETNAMESE_COPY;
}

/** Copy for the current document, chosen from the hostname/route surface. */
export function adminHostCopy(): AdminHostCopy {
  return adminHostCopyFor(isEnglishAdminSurface());
}
