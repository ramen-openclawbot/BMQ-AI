#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260903061500_facebook_messenger_agent_bridge.sql"
REPLY = ROOT / "supabase/functions/facebook-messenger-agent-reply/index.ts"
WORKER = ROOT / "supabase/functions/facebook-messenger-email-worker/index.ts"
CONFIG = ROOT / "supabase/config.toml"

def text(path: Path) -> str:
    assert path.exists(), f"missing {path}"
    return path.read_text()

def test_contract_markers_and_default_off_flags():
    sql = text(MIGRATION).lower()
    for marker in ["duplicate_inbound_one_email", "destination_allowlisted", "raw_psid_not_emailed", "same_idempotency_one_outbox", "ai_cannot_use_human_agent"]:
        assert marker in sql or marker in text(REPLY).lower() or marker in text(WORKER).lower(), marker
    assert "agent_email_forward_enabled boolean not null default false" in sql
    assert "agent_reply_enabled boolean not null default false" in sql
    assert "agent_email_processor_approved boolean not null default false" in sql

def function_body(sql: str, name: str) -> str:
    m = re.search(rf"create\s+or\s+replace\s+function\s+public\.{name}[\s\S]*?\n\$\$;", sql, re.I)
    assert m, f"missing function {name}"
    return m.group(0)

def test_email_payload_minimizes_data_and_uses_thread_uuid():
    sql = text(MIGRATION)
    assert "'thread_id', v_conversation_id" in sql
    assert "'notification_id'" in sql
    assert "'inboxoggxdk@agent.instinct.co'" in sql
    claim_body = function_body(sql, "facebook_claim_messenger_email_notifications")
    returned_projection = claim_body[claim_body.lower().rfind("returning"):]
    forbidden = ["psid", "page_id", "message_id", "messenger_message_id", "platform_message_id", "attachment", "token", "secret"]
    for bad in forbidden:
        assert bad not in returned_projection.lower(), f"email claim must not expose {bad}"

def test_security_definer_acl_and_service_role_null_safe():
    sql = text(MIGRATION).lower()
    assert "security definer" in sql
    assert "set search_path = public, extensions" in sql or "set search_path = public" in sql
    assert "auth.role() is distinct from 'service_role'" in sql
    assert "revoke all on function public.facebook_enqueue_instinct_messenger_reply" in sql
    assert "from public, anon, authenticated" in sql
    assert "grant execute on function public.facebook_enqueue_instinct_messenger_reply" in sql and "to service_role" in sql

def test_reply_hmac_nonce_rate_limit_and_no_graph():
    src = text(REPLY).lower()
    for marker in ["x-instinct-timestamp", "x-instinct-nonce", "x-instinct-signature", "hmac", "sha-256", "recordnonce", "meta_instinct_reply_secret_previous"]:
        assert marker in src, marker
    assert "graph.facebook.com" not in src
    assert "human_agent" not in src.replace("ai_cannot_use_human_agent", "")
    assert re.search(r"Object\.keys\(body\).*thread_id.*text.*idempotency_key", text(REPLY), re.S)

def test_worker_claims_with_skip_locked_and_no_live_graph():
    sql = text(MIGRATION).lower()
    src = text(WORKER).lower()
    assert "for update" in sql and "skip locked" in sql
    assert "inboxoggxdk@agent.instinct.co" in src
    assert "graph.facebook.com" not in src
    assert "api.resend.com/emails" in src
    assert "if (error) throw error" in src
    for rpc in ["facebook_mark_messenger_email_sent", "facebook_mark_messenger_email_failed", "facebook_mark_messenger_email_manual_reconciliation"]:
        assert rpc in src


def test_pending_instinct_email_claim_rechecks_conversation_suppression():
    sql = text(MIGRATION).lower()
    claim_body = function_body(sql, "facebook_claim_messenger_email_notifications")
    assert "facebook_messenger_metadata_flag" in sql, "claim must use throw-safe metadata boolean parsing"
    assert "facebook_suppress_pending_instinct_emails_for_conversation" in sql
    assert "facebook_messenger_conversation_suppress_instinct_email_trigger" in sql
    assert "suppressed_by_conversation_state" in sql
    assert "join public.facebook_messenger_conversations c on c.id = eo.conversation_id" in claim_body
    assert "for update of eo skip locked" in claim_body
    for flag in ["deleted", "opted_out", "quarantined", "policy_blocked"]:
        assert flag in claim_body


def test_disabling_instinct_email_bridge_suppresses_existing_backlog():
    sql = text(MIGRATION).lower()
    claim_body = function_body(sql, "facebook_claim_messenger_email_notifications")
    assert "facebook_suppress_pending_instinct_emails_for_settings" in sql
    assert "facebook_messenger_settings_suppress_instinct_email_trigger" in sql
    assert "suppressed_by_email_bridge_disabled" in sql
    assert "old.agent_email_forward_enabled is distinct from false" in sql
    assert "old.agent_email_processor_approved is distinct from false" in sql
    assert "eo.recipient_email = 'inboxoggxdk@agent.instinct.co'" in claim_body
    assert "eo.payload->>'source' = 'facebook_messenger'" in claim_body

def test_config_verify_jwt_false_for_dedicated_auth_endpoints():
    cfg = text(CONFIG)
    assert "[functions.facebook-messenger-agent-reply]" in cfg and "verify_jwt = false" in cfg
    assert "[functions.facebook-messenger-email-worker]" in cfg and "verify_jwt = false" in cfg


def test_send_commit_authorizes_exact_email_before_resend():
    sql = text(MIGRATION).lower()
    src = text(WORKER).lower()
    body = function_body(sql, "facebook_commit_messenger_email_send")
    assert "status = 'send_committed'" in body
    assert "send_committed_at" in body
    assert "where eo.id = p_email_id" in body
    assert "eo.status = 'processing'" in body
    assert "eo.recipient_email = 'inboxoggxdk@agent.instinct.co'" in body
    assert "eo.payload->>'source' = 'facebook_messenger'" in body
    assert "agent_email_forward_enabled" in body and "agent_email_processor_approved" in body
    assert "facebook_messenger_conversation_is_suppressed" in body
    assert "facebook_commit_messenger_email_send" in src
    assert src.index("sendcommit") < src.index("sendemail"), "worker must commit before provider send"
    assert "status = 'send_committed'" in function_body(sql, "facebook_mark_messenger_email_sent").lower()
    assert "status = 'send_committed'" in function_body(sql, "facebook_mark_messenger_email_manual_reconciliation").lower()
    failed_body = function_body(sql, "facebook_mark_messenger_email_failed").lower()
    assert "send_committed" in failed_body and "status in" in failed_body


def test_atomic_enqueue_rate_limit_inside_transaction():
    sql = text(MIGRATION).lower()
    src = text(REPLY).lower()
    body = function_body(sql, "facebook_enqueue_instinct_messenger_reply")
    assert "pg_advisory_xact_lock" in body
    assert "facebook_instinct_reply_audit" in body
    assert "status = 'accepted'" in body
    assert "rate_limited" in body
    assert "on conflict (idempotency_key) do nothing" in body
    assert "facebook_check_instinct_reply_rate_limit" not in src, "edge must not rely on racy rate preflight"
    assert "checkratelimit" not in src


def test_public_reply_body_read_is_bounded_streaming():
    src = text(REPLY)
    assert "request.arrayBuffer()" not in src
    assert "content-length" in src.lower()
    assert "getReader()" in src
    assert "reader.cancel()" in src
    assert "MAX_BODY_BYTES" in src

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("facebook_messenger_agent_bridge_contract: ok")
