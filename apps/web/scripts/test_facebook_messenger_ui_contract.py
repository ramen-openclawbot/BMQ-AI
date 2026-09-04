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


def test_hook_uses_fresh_authenticated_edge_functions_only():
    hook_path = ROOT / "src/hooks/useFacebookMessenger.ts"
    assert hook_path.exists(), "useFacebookMessenger.ts must exist"
    hook = hook_path.read_text(encoding="utf-8")
    assert_contains(hook, 'import { getFreshAccessToken } from "@/lib/supabase-helpers";', "useFacebookMessenger.ts")
    assert_contains(hook, 'await getFreshAccessToken()', "useFacebookMessenger.ts")
    assert_contains(hook, 'Authorization', "useFacebookMessenger.ts")
    assert re.search(r'Bearer \$\{accessToken\}', hook), "edge functions must receive fresh Bearer token"
    assert_contains(hook, 'facebook-messenger-inbox', "useFacebookMessenger.ts")
    assert_contains(hook, 'facebook-messenger-send', "useFacebookMessenger.ts")
    forbidden = [
        'getSession()', 'session.access_token',
        '.from("facebook_messenger_', ".from('facebook_messenger_", "graph.facebook", "facebook.com/", "page_id", "psid", "recipient", "messaging_type", "tag",
    ]
    for token in forbidden:
        assert_not_contains(hook, token, "useFacebookMessenger.ts")
    assert re.search(r'text\.trim\(\)\.slice\(0,\s*2000\)', hook), "send text must be bounded"


def test_send_contract_uses_explicit_retry_stable_idempotency_key():
    hook = read("src/hooks/useFacebookMessenger.ts")
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert re.search(r'mutationFn:\s*async\s*\(\{\s*conversationId,\s*text,\s*idempotencyKey\s*\}:\s*\{\s*conversationId:\s*string;\s*text:\s*string;\s*idempotencyKey:\s*string\s*\}', hook), "send mutation must accept explicit idempotencyKey"
    assert_contains(hook, 'conversation_id: conversationId', "useFacebookMessenger.ts")
    assert_contains(hook, 'idempotency_key: idempotencyKey', "useFacebookMessenger.ts")
    assert_contains(hook, 'export function buildMessengerIdempotencyKey()', "useFacebookMessenger.ts")
    assert_contains(hook, 'export function getMessengerComposeIdempotencyKey(', "useFacebookMessenger.ts")
    assert_contains(page, 'getMessengerComposeIdempotencyKey(composeIdempotencyRef.current, conversationId, normalizedDraft)', "FacebookMessengerInbox.tsx")
    assert_not_contains(hook, 'buildMessengerIdempotencyKey(conversationId, boundedText)', "useFacebookMessenger.ts")
    assert_contains(page, 'const composeIdempotencyRef = useRef<{ conversationId: string; draft: string; key: string } | null>(null);', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'getComposeIdempotencyKey(selectedConversation.id, messageText)', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'idempotencyKey', "FacebookMessengerInbox.tsx")
    assert re.search(r'setMessageText\(""\);[\s\S]*?composeIdempotencyRef\.current\s*=\s*null;', page), "key rotates only after confirmed success"
    assert re.search(r'onChange=\{\(event\) => \{[\s\S]*?composeIdempotencyRef\.current\s*=\s*null;[\s\S]*?setMessageText', page), "intentional draft change rotates key"
    for token in ('threadId', 'attemptId', 'page_id', 'psid'):
        assert_not_contains(hook, token, "useFacebookMessenger.ts")
    assert_not_contains(page, 'threadId:', "FacebookMessengerInbox.tsx")


def test_inbox_contract_uses_post_action_body_supported_by_edge():
    hook = read("src/hooks/useFacebookMessenger.ts")
    edge = read("supabase/functions/facebook-messenger-inbox/index.ts")
    assert_contains(hook, 'action: selectedConversationId ? "read" : "list"', "useFacebookMessenger.ts")
    assert_contains(hook, 'conversation_id: selectedConversationId || undefined', "useFacebookMessenger.ts")
    assert_not_contains(hook, 'conversationId: selectedConversationId', "useFacebookMessenger.ts")
    assert_contains(edge, 'body.action === "list"', "facebook-messenger-inbox/index.ts")
    assert_contains(edge, 'body.action === "read"', "facebook-messenger-inbox/index.ts")
    assert_contains(edge, 'body.conversation_id', "facebook-messenger-inbox/index.ts")


def test_duplicate_submit_ref_lock_and_responsive_contract():
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(page, 'data-facebook-messenger-responsive="320-390-1440"', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'overflow-x-hidden', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'min-w-0', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'md:hidden', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'disabled={composerDisabled}', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'isSending', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'const submitLockRef = useRef(false);', "FacebookMessengerInbox.tsx")
    assert re.search(r'if\s*\(submitLockRef\.current\s*\|\|\s*isSending\)\s*return;', page), "submit handler must synchronously block duplicates before mutateAsync"
    assert re.search(r'submitLockRef\.current\s*=\s*true;[\s\S]*?await sendMessage\.mutateAsync', page), "submit lock must be set before awaiting mutateAsync"
    assert re.search(r'finally\s*\{\s*submitLockRef\.current\s*=\s*false;\s*\}', page), "submit lock must be cleared in finally"
    assert_contains(page, 'const finalizeLockRef = useRef(false);', "FacebookMessengerInbox.tsx")
    assert re.search(r'if\s*\(!canEdit\s*\|\|\s*finalizeLockRef\.current\s*\|\|\s*finalizeCandidate\.isPending\)\s*return;', page), "finalize handler must synchronously block duplicate candidate clicks before mutateAsync"
    assert re.search(r'finalizeLockRef\.current\s*=\s*true;[\s\S]*?await finalizeCandidate\.mutateAsync', page), "finalize lock must be set before awaiting mutateAsync"
    assert re.search(r'finally\s*\{\s*finalizeLockRef\.current\s*=\s*false;\s*\}', page), "finalize lock must be cleared in finally"
    assert_contains(page, 'Không tải URL đính kèm từ Facebook', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, '<img', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, 'attachment.url', "FacebookMessengerInbox.tsx")


def test_safe_error_mapping_forbids_raw_backend_messages():
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(page, 'function mapMessengerErrorMessage(error: unknown)', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'MESSENGER_ERROR_MESSAGES', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'Không thể hoàn tất thao tác Facebook Messenger. Vui lòng thử lại hoặc báo quản trị viên.', "FacebookMessengerInbox.tsx")
    forbidden = ['error.message', 'inbox.error.message', 'safeError || (inbox.error instanceof Error ? inbox.error.message']
    for token in forbidden:
        assert_not_contains(page, token, "FacebookMessengerInbox.tsx")


def test_page_heading_uses_i18n_translation_key():
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(page, 'import { useLanguage } from "@/contexts/LanguageContext";', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'const { t } = useLanguage();', "FacebookMessengerInbox.tsx")
    assert_contains(page, '{t.facebookPageManagement}', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, '<h1 className="min-w-0 break-words text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Quản lý Facebook Page</h1>', "FacebookMessengerInbox.tsx")


def test_composer_blocks_reconciliation_pending_or_ambiguous_states():
    hook = read("src/hooks/useFacebookMessenger.ts")
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(hook, 'replyBlocked?: boolean;', "FacebookMessengerConversation type")
    assert_contains(hook, 'reconciliationStatus?: string | null;', "FacebookMessengerConversation type")
    for token in ('send_committed', 'manual_reconciliation_required'):
        assert_contains(page, token, "FacebookMessengerInbox.tsx")
    assert re.search(r'RECONCILIATION_BLOCKING_STATUSES\s*=\s*new Set\(\[\s*"send_committed",\s*"manual_reconciliation_required"\s*\]\)', page), "blocking statuses must be explicit and bounded"
    assert_contains(page, 'selectedConversation.replyBlocked', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'reconciliationBlocked', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'Trạng thái đối soát chưa an toàn để gửi trả lời. Vui lòng chờ server xác nhận hoặc xử lý đối soát thủ công.', "FacebookMessengerInbox.tsx")


def test_default_off_feature_is_highest_priority_composer_blocker():
    hook = read("src/hooks/useFacebookMessenger.ts")
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(hook, 'enabled: boolean;', "InboxResponse type")
    assert_contains(page, 'const featureDisabled = inbox.data?.enabled === false;', "FacebookMessengerInbox.tsx")
    assert re.search(
        r'const\s+composerDisabled\s*=\s*featureDisabled\s*\|\|\s*!canEdit\s*\|\|\s*!selectedConversation\s*\|\|\s*selectedConversation\.replyWindowExpired\s*\|\|\s*reconciliationBlocked\s*\|\|\s*isSending;',
        page,
    ), "featureDisabled must be the explicit highest-priority composer disable condition"
    assert re.search(r'if\s*\(composerDisabled\s*\|\|\s*!selectedConversation\)\s*return;', page), "submit handler must return before mutation whenever composer is disabled"
    mutation_guard = re.search(r'if\s*\(composerDisabled\s*\|\|\s*!selectedConversation\)\s*return;[\s\S]*?await sendMessage\.mutateAsync', page)
    assert mutation_guard, "disabled submit guard must appear before send mutation"
    disabled_reason = re.search(r'const\s+disabledReason\s*=([\s\S]*?);\n\n\s*const handleSelect', page)
    assert disabled_reason, "disabled reason must stay near composer state"
    reason_expr = disabled_reason.group(1)
    assert reason_expr.find('!selectedConversation') < reason_expr.find('featureDisabled') < reason_expr.find('!canEdit'), "disabled reason should prefer no selected conversation, then default-off feature setup, then permission/window states"
    assert_contains(page, 'Tính năng Facebook Messenger chưa được bật. Vui lòng hoàn tất thiết lập server trước khi trả lời khách.', "FacebookMessengerInbox.tsx")


def test_inbox_thread_count_shows_loading_copy_until_query_settles():
    page = read("src/pages/FacebookMessengerInbox.tsx")
    assert_contains(page, 'const inboxListSettling = inbox.isLoading || (inbox.isFetching && !inbox.data);', "FacebookMessengerInbox.tsx")
    assert_contains(page, 'inboxListSettling ? "Đang tải luồng hội thoại" : `${conversations.length} luồng đang hiển thị`', "FacebookMessengerInbox.tsx")
    assert_not_contains(page, '<p className="text-xs text-muted-foreground">{conversations.length} luồng đang hiển thị</p>', "FacebookMessengerInbox.tsx")



def test_compose_idempotency_behavior_reuses_after_failure_and_rotates_after_success_or_new_draft():
    # Executable model for the required state/ref contract; source assertions above bind UI to this contract.
    generated = iter(["ui:first-key-000000000000000", "ui:second-key-00000000000000", "ui:third-key-000000000000000"])
    state = None

    def get_key(conversation_id: str, draft: str):
        nonlocal state
        normalized = draft.strip()[:2000]
        if state and state["conversationId"] == conversation_id and state["draft"] == normalized:
            return state["key"]
        key = next(generated)
        state = {"conversationId": conversation_id, "draft": normalized, "key": key}
        return key

    first_attempt = get_key("conv-1", " hello ")
    retry_after_client_visible_failure = get_key("conv-1", "hello")
    assert first_attempt == retry_after_client_visible_failure
    state = None  # confirmed success clears/rotates
    after_success = get_key("conv-1", "hello")
    assert after_success != first_attempt
    new_draft = get_key("conv-1", "hello again")
    assert new_draft != after_success

def test_inbox_edge_returns_camelcase_dto_and_blocks_sensitive_fields():
    edge = read("supabase/functions/facebook-messenger-inbox/index.ts")
    for token in ("customerDisplayName", "lastMessageAt", "lastMessagePreview", "replyWindowExpired", "replyBlocked", "manualReconciliationStatus", "reconciliationStatus", "createdAt", "text"):
        assert_contains(edge, token, "facebook-messenger-inbox/index.ts")
    for token in ("display_name", "message_text:", "received_at:", "page_id", "psid", "raw_payload", "providerEvidence"):
        assert_not_contains(edge, token, "facebook-messenger-inbox/index.ts")

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("facebook messenger UI contract passed")
