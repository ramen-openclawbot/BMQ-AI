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
    for marker in ["x-instinct-timestamp", "x-instinct-nonce", "x-instinct-signature", "hmac", "sha-256", "recordnonce", "checkratelimit", "meta_instinct_reply_secret_previous"]:
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

def test_config_verify_jwt_false_for_dedicated_auth_endpoints():
    cfg = text(CONFIG)
    assert "[functions.facebook-messenger-agent-reply]" in cfg and "verify_jwt = false" in cfg
    assert "[functions.facebook-messenger-email-worker]" in cfg and "verify_jwt = false" in cfg

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("facebook_messenger_agent_bridge_contract: ok")
