#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SQL_PATH = ROOT / "migrations" / "20260903054500_facebook_messenger_webhook_ingest.sql"
CONFIG_PATH = ROOT / "config.toml"


def read(path: Path) -> str:
    if not path.exists():
        raise AssertionError(f"missing required file: {path.relative_to(ROOT)}")
    return path.read_text()


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower())


def test_messenger_webhook_rpc_contract():
    sql = read(SQL_PATH)
    low = compact(sql)

    assert re.search(r"create\s+or\s+replace\s+function\s+public\.facebook_ingest_messenger_webhook_event\s*\(", sql, re.I), "missing RPC"
    assert "security definer" in low, "RPC must be SECURITY DEFINER"
    assert re.search(r"set\s+search_path\s*=\s*public\s*,\s*extensions", sql, re.I), "RPC must set search_path"
    assert "auth.role() is distinct from 'service_role'" in low, "RPC must enforce service_role with NULL-safe auth.role check"
    assert "revoke all on function public.facebook_ingest_messenger_webhook_event" in low, "must revoke RPC execute broadly"
    assert "from public, anon, authenticated" in low, "must revoke browser roles"
    assert "grant execute on function public.facebook_ingest_messenger_webhook_event" in low and "to service_role" in low, "must grant service_role only"
    assert "on conflict (event_fingerprint) do nothing" in low, "must dedupe event before side effects"
    assert "duplicate_event_idempotent" in sql, "expected marker duplicate_event_idempotent"
    assert "wrong_page_rejected" in sql, "expected marker wrong_page_rejected"
    assert "p_page_id <> v_settings.page_id" in low or "p_page_id is distinct from v_settings.page_id" in low, "must validate page against singleton settings"
    assert "facebook_messenger_conversations" in low and "on conflict (page_id, psid)" in low, "must upsert exact page+psid conversation"
    assert "where facebook_messenger_conversations.last_message_at is null" in low or "excluded.last_message_at >= facebook_messenger_conversations.last_message_at" in low, "must guard stale conversation chronology"
    assert "facebook_messenger_messages" in low and "on conflict" in low, "must idempotently insert messages"
    assert "p_watermark_at timestamptz default null" in low, "RPC must accept explicit nullable read watermark timestamp"
    assert "messaging_referral" in low, "RPC must accept normalized referral events"
    assert "last_delivery_at" in low and "last_read_at" in low, "must persist Messenger delivery/read receipt chronology"
    assert "p_event_timestamp >" in low, "receipt timestamps must be monotonic and reject stale overwrites"
    assert "p_watermark_at is null" in low and "missing_read_watermark" in low, "read receipts must fail closed without watermark"
    assert "sent_at <= p_watermark_at" in low or "coalesce(sent_at" in low and "<= p_watermark_at" in low, "read receipts must use watermark to update only eligible outbound messages"
    assert "not-a-timestamp" not in low and "~" in low, "receipt timestamp parsing must guard invalid existing JSON values before casting"
    assert "facebook_messenger_email_outbox" in low and "p_email_forward_enabled" in low, "must conditionally enqueue email outbox"
    assert "facebook_messenger_email_outbox_message_id_unique" in low, "must name the one-email-per-message invariant"
    assert re.search(r"create\s+unique\s+index\s+if\s+not\s+exists\s+facebook_messenger_email_outbox_message_id_unique\s+on\s+public\.facebook_messenger_email_outbox\s*\(\s*message_id\s*\)\s*where\s+message_id\s+is\s+not\s+null", sql, re.I), "must enforce one email outbox row per persisted Messenger message while allowing null message_id jobs"
    assert "on conflict (message_id) where message_id is not null do nothing" in low, "email insert must conflict on persisted message_id, not only email fingerprint"
    assert re.search(r"message_id\s*=\s*v_mid[\s\S]{0,220}?direction\s*=\s*'outbound'", sql, re.I), "delivery receipts must only update outbound messages"
    assert "inboxoggxdk@agent.instinct.co" in sql, "must pin exact agent email recipient"
    assert "jsonb_strip_nulls" in low and "conversation_ref" in low and "sender_display" in low, "must store sanitized bounded payloads"
    assert "format(" not in low, "no dynamic SQL formatting"
    assert not re.search(r"\bexecute\s+[^;]*(format|\|\|)", low), "no dynamic SQL execution"


def test_messenger_webhook_config_contract():
    config = read(CONFIG_PATH)
    assert re.search(r"\[functions\.facebook-messenger-webhook\][\s\S]*?verify_jwt\s*=\s*false", config, re.I), "function must be public with verify_jwt=false"


if __name__ == "__main__":
    test_messenger_webhook_rpc_contract()
    test_messenger_webhook_config_contract()
    print("sql_contract_passed")
