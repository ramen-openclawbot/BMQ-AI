#!/usr/bin/env python3
from pathlib import Path
import os
import re
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20260903053000_facebook_messenger_inbox.sql"
USER_MGMT = ROOT / "src" / "hooks" / "useUserManagement.ts"
AUTH_CONTEXT = ROOT / "src" / "contexts" / "AuthContext.tsx"

TABLES = [
    "facebook_messenger_settings",
    "facebook_messenger_conversations",
    "facebook_platform_identities",
    "facebook_messenger_messages",
    "facebook_messenger_webhook_events",
    "facebook_messenger_outbox",
    "facebook_messenger_email_outbox",
    "facebook_data_deletion_requests",
]

SECRET_COLUMN_RE = re.compile(
    r"\b(page_access_token|access_token|verify_token|app_secret|client_secret|secret|token|credential|password)\b",
    re.IGNORECASE,
)


def read(path: Path) -> str:
    assert path.exists(), f"missing {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def table_body(sql: str, table: str) -> str:
    match = re.search(
        rf"create table if not exists public\.{table}\s*\((.*?)\n\);",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert match, f"missing create table for public.{table}"
    return match.group(1).lower()


def assert_has_all(text: str, tokens: tuple[str, ...], label: str) -> None:
    lowered = text.lower()
    for token in tokens:
        assert token.lower() in lowered, f"{label} missing: {token}"


def assert_status_check(body: str, constraint: str, statuses: tuple[str, ...]) -> None:
    assert constraint in body, f"missing status constraint {constraint}"
    for status in statuses:
        assert f"'{status}'" in body, f"{constraint} missing status {status}"


def index_statements(sql: str) -> list[str]:
    return [
        normalize(match.group(0))
        for match in re.finditer(
            r"create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+[^;]+;",
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        )
    ]


def require_index(sql: str, index_name: str) -> str:
    for stmt in index_statements(sql):
        if f"create index if not exists {index_name}" in stmt or f"create unique index if not exists {index_name}" in stmt:
            return stmt
    raise AssertionError(f"missing index/idempotency contract: create index if not exists {index_name}")


def assert_composite_conversation_fk(body: str, table: str) -> None:
    expected = (
        f"constraint {table}_conversation_identity_fk foreign key (conversation_id, page_id, psid) "
        "references public.facebook_messenger_conversations(id, page_id, psid) on delete restrict"
    )
    assert expected in normalize(body), f"{table} must bind conversation_id to matching page_id/psid"
    assert "conversation_id uuid not null references public.facebook_messenger_conversations(id)" not in normalize(body), (
        f"{table} must not keep redundant single-column conversation_id FK when composite identity FK covers it"
    )


def smoke_sql(sql: str) -> str:
    return f"""
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$
begin
  create role anon;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role service_role;
exception when duplicate_object then null;
end $$;
create table if not exists auth.users (id uuid primary key);
create table if not exists public.user_roles (user_id uuid not null references auth.users(id), role text not null);
create table if not exists public.user_module_permissions (
  user_id uuid not null references auth.users(id),
  module_key text not null,
  can_view boolean not null,
  can_edit boolean not null,
  primary key (user_id, module_key)
);

{sql}

do $$
declare
  conv_id uuid := '11111111-1111-1111-1111-111111111111'::uuid;
begin
  insert into public.facebook_messenger_conversations (id, page_id, psid)
  values (conv_id, 'page-a', 'psid-a');

  insert into public.facebook_messenger_messages (conversation_id, page_id, psid, direction, fingerprint)
  values (conv_id, 'page-a', 'psid-a', 'inbound', repeat('a', 32));

  begin
    insert into public.facebook_messenger_messages (conversation_id, page_id, psid, direction, fingerprint)
    values (conv_id, 'page-b', 'psid-a', 'inbound', repeat('b', 32));
    raise exception 'message identity mismatch was accepted';
  exception when foreign_key_violation then
    null;
  end;

  insert into public.facebook_messenger_outbox (conversation_id, page_id, psid, idempotency_key, payload)
  values (conv_id, 'page-a', 'psid-a', repeat('c', 32), '{{}}'::jsonb);

  begin
    insert into public.facebook_messenger_outbox (conversation_id, page_id, psid, idempotency_key, payload)
    values (conv_id, 'page-a', 'psid-b', repeat('d', 32), '{{}}'::jsonb);
    raise exception 'outbox identity mismatch was accepted';
  exception when foreign_key_violation then
    null;
  end;

  declare
    conv_a uuid := '22222222-2222-2222-2222-222222222222'::uuid;
    conv_b uuid := '33333333-3333-3333-3333-333333333333'::uuid;
    msg_a uuid;
  begin
    insert into public.facebook_messenger_conversations (id, page_id, psid)
    values (conv_a, 'page-email', 'psid-a'), (conv_b, 'page-email', 'psid-b');

    insert into public.facebook_messenger_messages (conversation_id, page_id, psid, direction, fingerprint)
    values (conv_a, 'page-email', 'psid-a', 'inbound', repeat('e', 32))
    returning id into msg_a;

    insert into public.facebook_messenger_email_outbox (conversation_id, message_id, email_fingerprint, recipient_email, subject)
    values (conv_a, msg_a, repeat('f', 32), 'agent@example.com', 'same conversation ok');

    begin
      insert into public.facebook_messenger_email_outbox (conversation_id, message_id, email_fingerprint, recipient_email, subject)
      values (conv_b, msg_a, repeat('0', 32), 'agent@example.com', 'cross conversation rejected');
      raise exception 'email outbox message/conversation mismatch was accepted';
    exception when foreign_key_violation then
      null;
    end;
  end;
end $$;
"""


def run_disposable_postgres_smoke(sql: str) -> None:
    container = f"fb-messenger-contract-{uuid.uuid4().hex[:12]}"
    script = smoke_sql(sql)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", delete=False) as handle:
        handle.write(script)
        script_path = handle.name
    try:
        subprocess.run(
            ["docker", "run", "--name", container, "--rm", "-e", "POSTGRES_PASSWORD=postgres", "-d", "postgres:16-alpine"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(60):
            ready = subprocess.run(
                ["docker", "exec", container, "pg_isready", "-U", "postgres"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise AssertionError("disposable PostgreSQL did not become ready")
        with open(script_path, "rb") as stdin:
            result = subprocess.run(
                ["docker", "exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
                stdin=stdin,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
            )
        assert result.returncode == 0, (
            "disposable PostgreSQL identity mismatch smoke failed\n"
            f"stdout:\n{result.stdout.decode(errors='replace')}\n"
            f"stderr:\n{result.stderr.decode(errors='replace')}"
        )
        print("PASS disposable PostgreSQL identity mismatch smoke")
    finally:
        Path(script_path).unlink(missing_ok=True)
        subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def assert_no_secret_columns(sql: str) -> None:
    for table in TABLES:
        body = table_body(sql, table)
        for line in body.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith(("constraint", "unique", "primary", "foreign", "check")):
                continue
            first_token = stripped.split()[0].strip('"')
            assert not SECRET_COLUMN_RE.search(first_token), f"secret-like column on {table}: {first_token}"


def main() -> None:
    sql = read(MIGRATION)
    sql_l = sql.lower()
    norm_sql = normalize(sql)

    # Service-authoritative schema: no app/page secrets or tokens in persisted columns.
    assert_no_secret_columns(sql)

    settings = table_body(sql, "facebook_messenger_settings")
    assert_has_all(settings, (
        "id uuid primary key",
        "page_id text not null",
        "page_name text",
        "graph_version text not null default 'v26.0'",
        "enabled boolean not null default false",
        "human_agent_enabled boolean not null default false",
        "agent_email_forward_enabled boolean not null default false",
        "agent_reply_enabled boolean not null default false",
        "created_at timestamptz not null default now()",
        "updated_at timestamptz not null default now()",
        "facebook_messenger_settings_singleton_check",
        "facebook_messenger_settings_page_id_unique",
    ), "settings table")

    conversations = table_body(sql, "facebook_messenger_conversations")
    assert_has_all(conversations, (
        "id uuid primary key default gen_random_uuid()",
        "page_id text not null",
        "psid text not null",
        "last_message_at timestamptz",
        "last_inbound_message_at timestamptz",
        "last_outbound_message_at timestamptz",
        "reply_window_expires_at timestamptz",
        "human_agent_window_expires_at timestamptz",
        "created_at timestamptz not null default now()",
        "updated_at timestamptz not null default now()",
        "facebook_messenger_conversations_page_psid_unique unique (page_id, psid)",
        "facebook_messenger_conversations_id_page_psid_unique unique (id, page_id, psid)",
    ), "conversations table")

    identities = table_body(sql, "facebook_platform_identities")
    assert_has_all(identities, (
        "page_id text not null",
        "psid text not null",
        "app_scoped_user_id text",
        "mapping_source text not null default 'webhook'",
        "verified_at timestamptz",
        "facebook_platform_identities_page_psid_unique unique (page_id, psid)",
        "facebook_platform_identities_mapping_source_check",
        "facebook_platform_identities_app_user_verified_check",
        "check (app_scoped_user_id is null or verified_at is not null)",
    ), "platform identities table")
    for forbidden_link_column in ("profile_id", "bmq_user_id", "auth_user_id", "customer_id"):
        assert forbidden_link_column not in identities, f"identity table must not infer/link BMQ users via {forbidden_link_column}"

    messages = table_body(sql, "facebook_messenger_messages")
    assert_status_check(messages, "facebook_messenger_messages_direction_check", ("inbound", "outbound"))
    assert_status_check(messages, "facebook_messenger_messages_processing_status_check", ("received", "queued", "processed", "failed", "suppressed"))
    assert_has_all(messages, (
        "conversation_id uuid not null",
        "page_id text not null",
        "psid text not null",
        "message_id text",
        "fingerprint text not null",
        "payload jsonb not null default '{}'::jsonb",
        "facebook_messenger_messages_message_id_unique unique (page_id, message_id)",
        "facebook_messenger_messages_fingerprint_unique unique (fingerprint)",
    ), "messages table")
    assert_composite_conversation_fk(messages, "facebook_messenger_messages")

    webhook_events = table_body(sql, "facebook_messenger_webhook_events")
    assert_status_check(webhook_events, "facebook_messenger_webhook_events_status_check", ("received", "processing", "processed", "ignored", "failed"))
    assert_has_all(webhook_events, (
        "event_id uuid primary key default gen_random_uuid()",
        "event_fingerprint text not null",
        "payload jsonb not null default '{}'::jsonb",
        "facebook_messenger_webhook_events_fingerprint_unique unique (event_fingerprint)",
    ), "webhook events table")

    outbox = table_body(sql, "facebook_messenger_outbox")
    assert_status_check(outbox, "facebook_messenger_outbox_status_check", (
        "pending", "processing", "send_committed", "sent", "failed", "manual_reconciliation_required", "suppressed",
    ))
    assert_has_all(outbox, (
        "conversation_id uuid not null",
        "page_id text not null",
        "psid text not null",
        "idempotency_key text not null",
        "payload jsonb not null default '{}'::jsonb",
        "attempt_count integer not null default 0",
        "facebook_messenger_outbox_idempotency_key_unique unique (idempotency_key)",
    ), "outbox table")
    assert_composite_conversation_fk(outbox, "facebook_messenger_outbox")

    email_outbox = table_body(sql, "facebook_messenger_email_outbox")
    assert_status_check(email_outbox, "facebook_messenger_email_outbox_status_check", ("pending", "processing", "sent", "failed", "suppressed"))
    assert_has_all(messages, (
        "facebook_messenger_messages_id_conversation_unique unique (id, conversation_id)",
    ), "messages table composite FK target")

    assert_has_all(email_outbox, (
        "conversation_id uuid references public.facebook_messenger_conversations(id) on delete restrict",
        "message_id uuid",
        "email_fingerprint text not null",
        "facebook_messenger_email_outbox_fingerprint_unique unique (email_fingerprint)",
        "facebook_messenger_email_outbox_message_conversation_fk",
        "foreign key (message_id, conversation_id)",
        "references public.facebook_messenger_messages(id, conversation_id)",
        "on delete restrict",
    ), "email outbox table")
    assert "message_id uuid references public.facebook_messenger_messages(id)" not in normalize(email_outbox), (
        "email outbox must not keep an independent single-column message FK that can drift from conversation_id"
    )

    deletion = table_body(sql, "facebook_data_deletion_requests")
    assert_status_check(deletion, "facebook_data_deletion_requests_status_check", (
        "requested", "processing", "pending_manual_mapping", "completed", "failed",
    ))
    assert_has_all(deletion, (
        "confirmation_code_hash text not null",
        "request_fingerprint text not null",
        "facebook_data_deletion_requests_confirmation_code_hash_unique unique (confirmation_code_hash)",
        "facebook_data_deletion_requests_fingerprint_unique unique (request_fingerprint)",
        "facebook_data_deletion_requests_confirmation_code_hash_check",
    ), "data deletion table")
    assert "confirmation_code text" not in deletion, "data deletion table must not store plaintext confirmation_code"
    assert "confirmation_code_unique unique (confirmation_code)" not in deletion, "confirmation_code uniqueness must be on hash only"
    assert re.search(
        r"confirmation_code_hash\)\s*~\s*'\^\[0-9a-f\]\{64\}\$'|confirmation_code_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'",
        deletion,
    ), "confirmation_code_hash must enforce lowercase 64-char SHA-256 hex"

    # RLS and direct browser writes are fail-closed; only service_role receives table grants.
    for table in TABLES:
        assert f"alter table public.{table} enable row level security;" in sql_l, f"RLS not enabled for {table}"
        assert f"revoke all on table public.{table} from public, anon, authenticated;" in sql_l, f"missing defensive revoke for {table}"
        assert f"grant select, insert, update, delete on table public.{table} to service_role;" in sql_l, f"missing service_role grant for {table}"
        assert f"grant insert on table public.{table} to authenticated" not in sql_l, f"authenticated direct insert granted for {table}"
        assert f"grant update on table public.{table} to authenticated" not in sql_l, f"authenticated direct update granted for {table}"
        assert f"grant delete on table public.{table} to authenticated" not in sql_l, f"authenticated direct delete granted for {table}"

    assert "create policy" not in sql_l, "browser policies must not be opened in Task 1 foundation"
    assert norm_sql.count("facebook_messenger") >= 50, "migration should be the authoritative Facebook Messenger foundation"

    for index_token in (
        "create index if not exists facebook_messenger_messages_conversation_created_idx",
        "create index if not exists facebook_messenger_email_outbox_pending_idx",
        "create index if not exists facebook_data_deletion_requests_status_idx",
        "create index if not exists facebook_platform_identities_app_scoped_user_idx",
    ):
        assert index_token in sql_l, f"missing index/idempotency contract: {index_token}"

    outbox_pending_idx = require_index(sql, "facebook_messenger_outbox_pending_idx")
    assert "where status = 'pending'" in outbox_pending_idx, "outbox claim index must be pending-only"
    assert "status in" not in outbox_pending_idx, "outbox claim index must not include non-pending statuses"
    for stmt in index_statements(sql):
        if any(marker in stmt for marker in ("pending", "retry", "claim")):
            assert "send_committed" not in stmt, f"claim/retry/pending index must not include send_committed: {stmt}"
            assert "manual_reconciliation_required" not in stmt, (
                f"claim/retry/pending index must not include manual reconciliation rows: {stmt}"
            )

    assert "'facebook_messenger'" in sql_l, "migration must seed facebook_messenger module rows"
    assert "false as can_view" in sql_l and "false as can_edit" in sql_l, "seed must be default-deny"
    assert "where ur.role <> 'owner'" in sql_l, "seed must target existing non-owner users only"
    assert "on conflict (user_id, module_key) do nothing" in sql_l, "seed must not overwrite explicit permissions"

    user_mgmt = read(USER_MGMT)
    assert '{ key: "facebook_messenger", labelEn: "Facebook Page Management", labelVi: "Quản lý Facebook Page" }' in user_mgmt
    all_module_keys_match = re.search(r"const ALL_MODULE_KEYS = \[(.*?)\];", user_mgmt, re.DOTALL)
    assert all_module_keys_match, "missing ALL_MODULE_KEYS definition"
    assert '"facebook_messenger"' in all_module_keys_match.group(1)
    for defaults_name in ("DEFAULT_VIEW", "DEFAULT_EDIT"):
        defaults_match = re.search(rf"const {defaults_name}: Record<string, string\[]> = \{{(.*?)\n\}};", user_mgmt, re.DOTALL)
        assert defaults_match, f"missing {defaults_name} definition"
        defaults = defaults_match.group(1)
        assert "facebook_messenger" not in defaults, f"{defaults_name} must not grant facebook_messenger by default"

    auth_context = read(AUTH_CONTEXT)
    fallback_match = re.search(r"const viewerRows = \[(.*?)\]\.map", auth_context, re.DOTALL)
    assert fallback_match, "missing AuthContext fallback viewerRows"
    fallback_list = fallback_match.group(1)
    assert '"facebook_messenger"' in fallback_list, "AuthContext fallback must include facebook_messenger row"
    can_view_match = re.search(r"can_view: \[(.*?)\]\.includes\(moduleKey\)", auth_context, re.DOTALL)
    assert can_view_match, "missing AuthContext fallback can_view expression"
    can_view_expr = can_view_match.group(1)
    assert '"facebook_messenger"' not in can_view_expr, "AuthContext fallback must deny facebook_messenger view"
    assert "can_edit: false" in auth_context, "AuthContext fallback must deny edit"

    if os.environ.get("FB_MESSENGER_POSTGRES_SMOKE") == "1":
        run_disposable_postgres_smoke(sql)

    print("PASS facebook messenger foundation contract")



def test_facebook_messenger_foundation_contract() -> None:
    main()


if __name__ == "__main__":
    main()
