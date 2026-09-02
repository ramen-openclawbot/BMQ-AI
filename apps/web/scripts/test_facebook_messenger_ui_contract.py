#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, where: str) -> None:
    assert needle in text, f"missing {needle!r} in {where}"


def assert_not_contains(text: str, needle: str, where: str) -> None:
    assert needle not in text, f"forbidden {needle!r} in {where}"


def test_sidebar_marketing_sales_parent_and_child_contract():
    sidebar = read("src/components/layout/Sidebar.tsx")
    assert_contains(sidebar, 'section: "marketingSales"', "Sidebar.tsx")
    assert_contains(sidebar, 'sectionMarketingSales', "Sidebar.tsx")
    assert re.search(r'labelKey:\s*"sectionMarketingSales"[\s\S]*?children:', sidebar), "Marketing&Sale parent must be represented by an i18n label and children"
    assert_contains(sidebar, 'labelKey: "facebookPageManagement"', "Sidebar.tsx")
    assert_contains(sidebar, 'path: "/marketing-sales/facebook-page"', "Sidebar.tsx")
    assert_contains(sidebar, 'moduleKey: "facebook_messenger"', "Sidebar.tsx")
    assert_contains(sidebar, 'const activeNavItemClass', "Sidebar.tsx")
    assert_contains(sidebar, 'data-sidebar-active={childActive ? "true" : undefined}', "Sidebar.tsx")
    assert_contains(sidebar, 'setCollapsed(true)', "Sidebar.tsx")
    assert_contains(sidebar, 'SIDEBAR_SCROLL_STORAGE_KEY', "Sidebar.tsx")
    assert_contains(sidebar, 'children: item.children.filter(canViewItem)', "Sidebar.tsx")
    assert re.search(r'\.filter\(\(item\) => \(item\.children \? item\.children\.length > 0 : canViewItem\(item\)\)\)', sidebar), "parents must render only when at least one permitted child remains"
    assert_not_contains(sidebar, 'path: "/marketing-sales"', "Sidebar.tsx")


def test_route_guard_contract():
    routes = read("src/components/AppRoutes.tsx")
    assert_contains(routes, 'FacebookMessengerInbox', "AppRoutes.tsx")
    assert_contains(routes, 'path="/marketing-sales/facebook-page"', "AppRoutes.tsx")
    assert_contains(routes, 'ModuleRoute moduleKey="facebook_messenger"', "AppRoutes.tsx")


def test_i18n_keys_exist_in_vi_and_en():
    lang = read("src/contexts/LanguageContext.tsx")
    for key in ("sectionMarketingSales", "facebookPageManagement"):
        assert_contains(lang, f"{key}: string;", "Translations interface")
    assert_contains(lang, 'sectionMarketingSales: "Marketing&Sale"', "English translations")
    assert_contains(lang, 'facebookPageManagement: "Facebook Page Management"', "English translations")
    assert_contains(lang, 'sectionMarketingSales: "Marketing&Sale"', "Vietnamese translations")
    assert_contains(lang, 'facebookPageManagement: "Quản lý Facebook Page"', "Vietnamese translations")


def test_hook_uses_authenticated_edge_functions_only():
    hook_path = ROOT / "src/hooks/useFacebookMessenger.ts"
    assert hook_path.exists(), "useFacebookMessenger.ts must exist"
    hook = hook_path.read_text(encoding="utf-8")
    assert_contains(hook, 'getSession()', "useFacebookMessenger.ts")
    assert_contains(hook, 'Authorization', "useFacebookMessenger.ts")
    assert_contains(hook, 'Bearer ${session.access_token}', "useFacebookMessenger.ts")
    assert_contains(hook, 'facebook-messenger-inbox', "useFacebookMessenger.ts")
    assert_contains(hook, 'facebook-messenger-send', "useFacebookMessenger.ts")
    forbidden = [
        '.from("facebook_messenger_', ".from('facebook_messenger_", "graph.facebook", "facebook.com/", "page_id", "psid", "recipient", "messaging_type", "tag",
    ]
    for token in forbidden:
        assert_not_contains(hook, token, "useFacebookMessenger.ts")
    assert re.search(r'text\.trim\(\)\.slice\(0,\s*2000\)', hook), "send text must be bounded"
    assert re.search(r'idempotencyKey:\s*attemptId', hook), "send payload must include generated per-attempt idempotency key"


def test_duplicate_submit_pending_guard_and_responsive_contract():
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(page, 'Quản lý Facebook Page', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'data-facebook-messenger-responsive="320-390-1440"', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'overflow-x-hidden', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'min-w-0', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'md:hidden', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'disabled={composerDisabled}', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'isSending', "FacebookMessengerInbox.tsx")
    assert re.search(r'if\s*\(isSending\)\s*return;', page), "submit handler must synchronously block duplicates"
    assert_contains(page, 'Không tải URL đính kèm từ Facebook', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, '<img', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, 'attachment.url', "FacebookMessengerInbox.tsx")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("facebook messenger UI contract passed")
