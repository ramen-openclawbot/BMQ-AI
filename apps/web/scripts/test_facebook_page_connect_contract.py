#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20260904090000_facebook_page_connect_oauth.sql"
CONNECT_FN = ROOT / "supabase" / "functions" / "facebook-page-connect" / "index.ts"
CONNECT_TEST = ROOT / "supabase" / "functions" / "facebook-page-connect" / "connect.test.ts"
WORKER_FN = ROOT / "supabase" / "functions" / "facebook-messenger-worker" / "index.ts"
HEALTH_FN = ROOT / "supabase" / "functions" / "facebook-messenger-health" / "index.ts"
CONFIG = ROOT / "supabase" / "config.toml"
HOOK = ROOT / "src" / "hooks" / "useFacebookPageConnection.ts"
PAGE = ROOT / "src" / "pages" / "FacebookMessengerInbox.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"{label} missing {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"{label} must not contain {needle!r}"


def test_edge_function_contract() -> None:
    source = read(CONNECT_FN)
    low = source.lower()
    for token in (
        "export async function handleFacebookPageConnect",
        "type FacebookPageConnectDeps",
        "META_APP_ID",
        "META_APP_SECRET",
        "META_LOGIN_CONFIG_ID",
        "FACEBOOK_OAUTH_STATE_SECRET",
        "https://www.facebook.com",
        "/dialog/oauth",
        "config_id",
        "override_default_response_type",
        "response_type",
        "auth_type",
        "rerequest",
        "facebook_begin_page_oauth_state",
        "facebook_consume_page_oauth_state",
        "storePageSelectionCandidates",
        "listPendingPageSelection",
        "consumePageSelectionCandidate",
        "subscribePageWebhooks",
        "subscribed_apps",
        "subscribed_fields",
        "commitPageConnection",
        "facebook_commit_page_oauth_connection",
        "facebook_page_connection_status",
        "facebook_messenger",
        '"edit"',
        "isOwner",
        "stateHash",
    ):
        assert_contains(source, token, "facebook-page-connect/index.ts")
    assert_not_contains(source, 'authUrl.searchParams.set("scope"', "facebook-page-connect/index.ts")
    assert_contains(source, '"service_not_configured"', "facebook-page-connect/index.ts")
    assert_contains(source, '"token_exchange_failed"', "facebook-page-connect/index.ts")
    assert_contains(source, '"subscription_failed"', "facebook-page-connect/index.ts")
    assert "supabase.functions.invoke" not in source, "Edge Function must not call browser invoke API"
    assert ".from(\"app_settings\")" not in source and ".from('app_settings')" not in source, "Facebook token must not be stored in readable app_settings"
    assert "console.log" not in source, "Edge Function must avoid accidental token logging"
    assert "pageAccessToken" in source, "server-side Page auth material must be handled explicitly"
    assert "{ authUrl: authUrl.toString(), expiresAt }" in source, "start response should only return authUrl metadata"
    assert "storePageAccessAuth" not in source, "Edge finalization must not split final token storage into a separate RPC"
    assert "markConnectedPage" not in source, "Edge finalization must not split Page binding into a separate RPC"
    for unsafe in ("page-token-secret", "meta-app-secret", "state-secret-at-least"):
        assert unsafe not in low, f"fixture secret leaked into production source: {unsafe}"


def test_edge_unit_test_exists_and_is_mocked() -> None:
    test = read(CONNECT_TEST)
    assert_contains(test, "handleFacebookPageConnect", "connect.test.ts")
    assert_contains(test, "commitConnection", "connect.test.ts")
    assert_contains(test, "storePageSelectionCandidates", "connect.test.ts")
    assert_contains(test, "finalize_candidate", "connect.test.ts")
    assert_contains(test, "owner-or-edit", "connect.test.ts")
    assert_contains(test, "callback consumes state before Graph", "connect.test.ts")
    assert_contains(test, "fails closed unless Page tasks/perms explicitly prove MESSAGING and MANAGE", "connect.test.ts")
    assert_not_contains(test, "fetch(\"https://graph.facebook.com", "connect.test.ts")


def test_sql_contract_uses_service_role_state_and_vault_not_browser_tables() -> None:
    sql = read(MIGRATION)
    sql_l = sql.lower()
    normalized = norm(sql)
    for token in (
        "alter table public.facebook_messenger_settings",
        "alter column page_id drop not null",
        "connection_status text not null default 'not_connected'",
        "connected_at timestamptz",
        "connected_by uuid references auth.users(id) on delete set null",
        "oauth_permissions text[] not null default '{}'",
        "create table if not exists public.facebook_page_oauth_states",
        "state_hash text not null",
        "actor_id uuid not null references auth.users(id) on delete cascade",
        "expected_page_id text",
        "redirect_url text not null",
        "expires_at timestamptz not null",
        "consumed_at timestamptz",
        "create table if not exists public.facebook_page_oauth_candidates",
        "candidate_id text not null",
        "page_id_suffix text not null",
        "auth_secret_name text not null",
        "facebook_page_oauth_states_state_hash_unique unique (state_hash)",
        "alter table public.facebook_page_oauth_states enable row level security",
        "alter table public.facebook_page_oauth_candidates enable row level security",
        "revoke all on table public.facebook_page_oauth_states from public, anon, authenticated",
        "revoke all on table public.facebook_page_oauth_candidates from public, anon, authenticated",
        "grant select, insert, update, delete on table public.facebook_page_oauth_states to service_role",
        "grant select, insert, update, delete on table public.facebook_page_oauth_candidates to service_role",
        "facebook_begin_page_oauth_state",
        "facebook_consume_page_oauth_state",
        "facebook_store_page_oauth_candidates",
        "facebook_list_page_oauth_candidates",
        "facebook_consume_page_oauth_candidate",
        "facebook_cleanup_page_oauth_candidates",
        "facebook_delete_page_oauth_candidate_secret",
        "facebook_commit_page_oauth_connection",
        "facebook_get_page_access_auth",
        "facebook_page_connection_status",
        "facebook_messenger_health_status",
        "vault.decrypted_secrets",
        "vault.create_secret",
        "vault.update_secret",
        "vault.delete_secret",
    ):
        assert token in sql_l, f"migration missing {token}"
    assert "app_settings" not in sql_l, "Facebook OAuth must not store auth material in app_settings"
    assert "grant execute on function public.facebook_commit_page_oauth_connection" in sql_l and "to service_role" in sql_l
    assert "grant execute on function public.facebook_get_page_access_auth" in sql_l and "to service_role" in sql_l
    assert "grant execute on function public.facebook_cleanup_page_oauth_candidates" in sql_l and "to service_role" in sql_l
    assert "create or replace function public.facebook_store_page_access_auth" not in sql_l, "final token storage must be atomic with Page binding"
    assert "create or replace function public.facebook_mark_page_oauth_connected" not in sql_l, "Page binding must be atomic with final token storage"
    assert "grant execute on function public.facebook_store_page_access_auth" not in sql_l, "legacy split token RPC must not be executable"
    assert "grant execute on function public.facebook_mark_page_oauth_connected" not in sql_l, "legacy split binding RPC must not be executable"
    assert "p_page_id text" in sql_l and "p_auth_material text" in sql_l and "p_page_name text" in sql_l, "atomic commit RPC must receive token and exact Page binding together"
    assert "'messaging' = any" in sql_l and "'manage' = any" in sql_l, "SQL commit must require explicit Page permission proof"
    assert "perform public.facebook_cleanup_page_oauth_candidates(p_actor_id)" in normalized, "candidate replacement must clean expired candidate Vault secrets first"
    assert "perform public.facebook_delete_page_oauth_candidate_secret" in normalized, "candidate replacement/consumption/cleanup must delete Vault secrets"
    assert "expires_at <= now()" in normalized, "expiry cleanup must target expired candidate secrets"
    assert "where c.actor_id = p_actor_id and c.consumed_at is null" in normalized, "candidate replacement/finalization must retire active actor candidates"
    assert re.search(r"state_hash\s+text\s+not\s+null[\s\S]*check\s*\(\s*state_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'", sql_l), "state hash must be bounded sha256 hex"
    assert "for update skip locked" in normalized or "for update" in normalized, "state consume must be atomic"
    assert "expires_at > now()" in normalized, "expired states must fail closed"
    assert "consumed_at is null" in normalized, "used states must not replay"
    assert "enabled = true" not in normalized, "OAuth connection must not enable Messenger messaging/send/forward/AI"
    assert "coalesce(v_settings.enabled, false)" in normalized, "health/status must keep feature enabled separate from connected"
    assert "create or replace function public.facebook_list_messenger_conversations()" in sql_l, "new migration must rebind list RPC to the connected Page"
    assert "create or replace function public.facebook_read_messenger_conversation(p_conversation_id uuid)" in sql_l, "new migration must rebind read RPC to the connected Page"
    assert normalized.count("c.page_id = v_connected_page_id") >= 2, "list and read RPCs must filter to the exact connected Page"
    assert "create or replace function public.facebook_reconcile_messenger_outbox(" in sql_l, "new migration must align reconciliation SQL authorization"
    assert "not public.facebook_messenger_has_permission(v_actor, 'edit') and not public.facebook_messenger_is_owner(v_actor)" in normalized, (
        "reconciliation must allow owner OR edit-capable actors"
    )
    assert "facebook_mark_messenger_outbox_send_committed(p_outbox_id uuid, p_lease_token uuid, p_expected_page_id text)" in normalized, (
        "send commit must atomically validate the Page binding used by the worker"
    )
    assert "s.page_id = p_expected_page_id" in normalized and "o.page_id = p_expected_page_id" in normalized, (
        "send commit must bind both singleton settings and outbox row to the expected Page"
    )
    assert "revoke all on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid) from public, anon, authenticated, service_role" in normalized, (
        "unsafe two-argument send-commit RPC must be retired"
    )
    for direct_grant in (
        "grant insert on table public.facebook_page_oauth_states to authenticated",
        "grant update on table public.facebook_page_oauth_states to authenticated",
        "grant delete on table public.facebook_page_oauth_states to authenticated",
    ):
        assert direct_grant not in sql_l, f"browser must not mutate OAuth state table: {direct_grant}"


def test_config_registers_public_callback_with_in_code_auth() -> None:
    config = read(CONFIG)
    assert re.search(r"\[functions\.facebook-page-connect\][\s\S]*?verify_jwt\s*=\s*false", config), "facebook-page-connect must be configured for OAuth callback with in-code auth"


def test_worker_and_health_use_stored_oauth_auth_material_without_exposing_it() -> None:
    worker = read(WORKER_FN)
    health = read(HEALTH_FN)
    assert_contains(worker, "resolvePageAccessAuth", "facebook-messenger-worker/index.ts")
    assert_contains(worker, "facebook_get_page_access_auth", "facebook-messenger-worker/index.ts")
    assert_contains(worker, "type PageAccessAuth = { pageId: string; pageAccessToken: string }", "facebook-messenger-worker/index.ts")
    assert_contains(worker, "row.page_id !== pageAccessAuth.pageId", "facebook-messenger-worker/index.ts")
    assert_contains(worker, "page_binding_mismatch", "facebook-messenger-worker/index.ts")
    assert_contains(worker, "markSendCommitted(row.id, row.lease_token, pageAccessAuth.pageId)", "facebook-messenger-worker/index.ts")
    assert_not_contains(worker, "env.META_PAGE_ACCESS_TOKEN ||", "facebook-messenger-worker/index.ts")
    assert_contains(health, "page_auth_present", "facebook-messenger-health/index.ts")
    assert_contains(health, "token_present", "facebook-messenger-health/index.ts")
    assert_not_contains(worker, "console.log", "facebook-messenger-worker/index.ts")
    assert_not_contains(health, "decrypted_secret", "facebook-messenger-health/index.ts")


def test_candidate_id_uses_schema_qualified_pgcrypto_random_bytes() -> None:
    sql = read(MIGRATION)
    assert_contains(sql, "extensions.gen_random_bytes(18)", "facebook_page_connect_oauth.sql")
    assert_not_contains(sql, "encode(gen_random_bytes(18)", "facebook_page_connect_oauth.sql")


def test_frontend_connect_panel_is_edit_gated_no_page_id_textbox_and_uses_edge_function_only() -> None:
    hook = read(HOOK)
    page = read(PAGE)
    for token in (
        'facebook-page-connect',
        'await getFreshAccessToken()',
        'Authorization',
        'action: "status"',
        'action: "start"',
        'action: "finalize_candidate"',
        'candidate_id',
    ):
        assert_contains(hook, token, "useFacebookPageConnection.ts")
    assert_not_contains(hook, "expected_page_id", "useFacebookPageConnection.ts")
    assert_not_contains(hook, "graph.facebook", "useFacebookPageConnection.ts")
    assert_not_contains(hook, ".from(\"facebook_messenger_settings\")", "useFacebookPageConnection.ts")
    assert_not_contains(hook, ".from('facebook_messenger_settings')", "useFacebookPageConnection.ts")
    for token in (
        "useFacebookPageConnectionStatus",
        "useFacebookPageConnect",
        "useFacebookPageCandidateFinalize",
        "facebook-connect-panel",
        "canEdit",
        "handleConnectPage",
        "connectLockRef.current",
        "finalizeLockRef.current",
        "window.location.href = data.authUrl",
        "facebook_connect",
        "select_page",
        'success === "success"',
        "facebook_connect_error",
        "Không lưu token trong trình duyệt",
        "Chưa kết nối Facebook Page",
        "Kết nối Facebook Page",
        "min-h-11",
    ):
        assert_contains(page, token, "FacebookMessengerInbox.tsx")
    assert_not_contains(page, "isOwner", "FacebookMessengerInbox.tsx")
    assert_not_contains(page, "expectedPageId", "FacebookMessengerInbox.tsx")
    assert_not_contains(page, "Page ID nếu tài khoản có nhiều Page", "FacebookMessengerInbox.tsx")
    assert_not_contains(page, "aria-label=\"Facebook Page ID cần kết nối\"", "FacebookMessengerInbox.tsx")
    assert_contains(page, "useFacebookMessengerInbox(selectedId, { enabled: inboxEnabled })", "FacebookMessengerInbox.tsx")
    assert_contains(page, "const inboxEnabled = connectionReady && pendingCandidates.length === 0", "FacebookMessengerInbox.tsx")
    assert_contains(hook, 'queryClient.removeQueries({ queryKey: ["facebook-messenger-inbox"] })', "useFacebookPageConnection.ts")
    assert_not_contains(page, "graph.facebook", "FacebookMessengerInbox.tsx")
    assert_not_contains(page, "page-token-secret", "FacebookMessengerInbox.tsx")
    assert page.index("if (pendingCandidates.length > 0)") < page.index("if (!connectionReady)"), (
        "authorized Page selection must take precedence over an existing connected Page"
    )


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("facebook page connect contract passed")
