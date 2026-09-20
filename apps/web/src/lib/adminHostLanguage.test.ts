// Offline tests for the isolated English-host language surface.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_HOSTS,
  ADMIN_PRIMARY_HOST,
  VNAGENT_ADMIN_HOST,
  adminHostCopyFor,
  isEnglishAdminSurface,
  isVnagentAdminHostname,
} from "./adminHostLanguage.ts";

test("admin hostname detection is exact", () => {
  assert.equal(ADMIN_PRIMARY_HOST, "admin.banhmique.vn");
  assert.equal(VNAGENT_ADMIN_HOST, "admin.vnagent.ai");
  assert.deepEqual(ADMIN_HOSTS, ["admin.banhmique.vn", "admin.vnagent.ai"]);
  assert.equal(isVnagentAdminHostname("admin.banhmique.vn"), true);
  assert.equal(isVnagentAdminHostname("admin.vnagent.ai"), true);
  assert.equal(isVnagentAdminHostname("ai.banhmique.vn"), false);
  assert.equal(isVnagentAdminHostname("admin.vnagent.ai.evil.test"), false);
  assert.equal(isVnagentAdminHostname("admin.vnagent.ai:443"), false);
});

test("admin hostname detection rejects suffix and lookalike hosts", () => {
  for (const host of [
    "admin.banhmique.vn.evil.test",
    "admin.banhmique.vn:443",
    "sub.admin.banhmique.vn",
    "evil-admin.banhmique.vn",
    "admin.banhmique.com",
    "admin-banhmique.vn",
    "banhmique.vn",
  ]) {
    assert.equal(isVnagentAdminHostname(host), false, `lookalike allowed: ${host}`);
  }
});

test("the removed /data-admin route no longer selects the English admin surface", () => {
  // Admin is host-only (2026-09-21). The legacy /data-admin path on a non-admin
  // host must not pick English admin chrome; it is now an ordinary not-found.
  assert.equal(isEnglishAdminSurface("admin.banhmique.vn"), true);
  assert.equal(isEnglishAdminSurface("admin.vnagent.ai"), true);
  assert.equal(isEnglishAdminSurface("ai.banhmique.vn"), false);
  assert.equal(isEnglishAdminSurface("localhost"), false);
  assert.equal(isEnglishAdminSurface("admin.banhmique.vn.evil.test"), false);
  assert.equal(isEnglishAdminSurface("dathang.banhmique.vn"), false);
  assert.equal(isEnglishAdminSurface("baocao.banhmique.vn"), false);
  // No window in node: falls back to Vietnamese.
  assert.equal(isEnglishAdminSurface(), false);
  // The surface no longer takes a path: a stale /data-admin link on a lookalike
  // host can never select admin chrome.
  assert.equal(isEnglishAdminSurface("ai.banhmique.vn"), false);
});

test("Vietnamese copy keeps the exact existing strings", () => {
  const vi = adminHostCopyFor(false);
  assert.equal(vi.auth.title, "BMQ Procurement");
  assert.equal(
    vi.auth.oauthNotAuthorized,
    "Tài khoản Google chưa được cấp quyền truy cập hệ thống. Vui lòng liên hệ quản trị để được cấp quyền.",
  );
  assert.equal(
    vi.auth.oauthExpired,
    "Phiên đăng nhập Google đã hết hạn hoặc bị xử lý trùng. Vui lòng bấm Đăng nhập bằng Google và thử lại.",
  );
  assert.equal(vi.auth.loginFailed, "Đăng nhập thất bại. Vui lòng thử lại.");
  assert.equal(vi.auth.signInError, "Đã xảy ra lỗi. Vui lòng thử lại.");
  assert.equal(vi.auth.signInSubtitle, "Đăng nhập bằng tài khoản Google @bmq.vn");
  assert.equal(vi.auth.signInButton, "Đăng nhập bằng Google");
  assert.equal(vi.auth.emailNote, "Chỉ hỗ trợ email @bmq.vn");
  assert.equal(vi.authTimeout.title, "Đang gặp sự cố kết nối");
  assert.equal(
    vi.authTimeout.body,
    "Không thể xác thực phiên đăng nhập. Điều này thường xảy ra trên Safari.",
  );
  assert.equal(vi.authTimeout.refreshSession, "Làm mới phiên");
  assert.equal(vi.authTimeout.retry, "Thử lại");
  assert.equal(vi.authTimeout.accessing("/data-admin"), "Đang cố truy cập: /data-admin");
  assert.equal(vi.recovery.title, "Khôi phục phiên đăng nhập");
  assert.equal(vi.recovery.subtitle, "Sử dụng trang này khi app bị kẹt không vào được");
  assert.equal(
    vi.recovery.alert,
    'Nếu bạn đang thấy spinner quay mãi, hãy bấm "Xóa phiên & tải lại" để reset trạng thái đăng nhập.',
  );
  assert.equal(vi.recovery.clearAndReload, "Xóa phiên đăng nhập & tải lại");
  assert.equal(vi.recovery.plainReload, "Thử tải lại bình thường");
  assert.equal(vi.recovery.footerLine1, "Sau khi xóa phiên, bạn sẽ cần đăng nhập lại.");
  assert.equal(vi.recovery.footerLine2, "Cài đặt ngôn ngữ và giao diện sẽ được giữ lại.");
});

test("English copy is natural English with no Vietnamese diacritics", () => {
  const en = adminHostCopyFor(true);
  assert.equal(en.auth.title, "BMQ Administration");
  assert.equal(en.auth.loginFailed, "Sign-in failed. Please try again.");
  assert.equal(en.auth.signInButton, "Sign in with Google");
  assert.equal(en.authTimeout.title, "Connection problem");
  assert.equal(en.authTimeout.accessing("/data-admin/review"), "Trying to access: /data-admin/review");
  assert.equal(en.recovery.clearAndReload, "Clear session & reload");

  const strings: string[] = [
    ...Object.values(en.auth),
    en.authTimeout.title,
    en.authTimeout.body,
    en.authTimeout.refreshSession,
    en.authTimeout.retry,
    en.authTimeout.accessing("/x"),
    ...Object.values(en.recovery),
  ];
  const vietnameseDiacritics =
    /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;
  for (const value of strings) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0, "English copy must not be empty");
    assert.equal(vietnameseDiacritics.test(value), false, `Vietnamese left in: ${value}`);
    assert.equal(value.includes("@bmq.vn") && value.includes("Chỉ"), false, `Vietnamese note left in: ${value}`);
  }
});
