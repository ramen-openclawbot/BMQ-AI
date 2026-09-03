#!/usr/bin/env python3
"""Disposable PostgreSQL smoke for Messenger receipt chronology.

Runs the actual inbox + webhook ingest migrations in a temporary Postgres
container, then exercises public.facebook_ingest_messenger_webhook_event.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "migrations"
INBOX_SQL = MIGRATIONS / "20260903053000_facebook_messenger_inbox.sql"
INGEST_SQL = MIGRATIONS / "20260903054500_facebook_messenger_webhook_ingest.sql"

IMAGE = os.environ.get("POSTGRES_IMAGE", "postgres:16-alpine")
CONTAINER = f"messenger-receipt-smoke-{os.getpid()}"
PASSWORD = "postgres"


def run(cmd: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, input=input_text, text=True, capture_output=True, check=check)


def psql(sql: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-h",
            "127.0.0.1",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
        ],
        input_text=sql,
        check=check,
    )


def wait_for_postgres() -> None:
    deadline = time.time() + 45
    last = ""
    while time.time() < deadline:
        proc = run(["docker", "exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False)
        if proc.returncode == 0:
            return
        last = proc.stdout + proc.stderr
        time.sleep(0.5)
    raise RuntimeError(f"postgres did not become ready: {last}")


def assertion_sql() -> str:
    return r"""
set client_min_messages = warning;
select set_config('request.jwt.claim.role', 'service_role', false);

insert into public.facebook_messenger_settings (page_id)
values ('page-chronology')
on conflict (id) do update set page_id = excluded.page_id;

-- Same persisted inbound Messenger MID with altered event/email fingerprints
-- must reuse one message row and enqueue exactly one email notification.
select public.facebook_ingest_messenger_webhook_event(
  repeat('1', 32),
  'page-chronology',
  'psid-email-dedupe',
  'message',
  '2026-09-03T09:00:00Z'::timestamptz,
  'mid-email-dedupe',
  'inbound',
  'first inbound body',
  '{"conversation_ref":"email-dedupe","message_preview":"first inbound body"}'::jsonb,
  '[]',
  '2026-09-04T09:00:00Z'::timestamptz,
  '2026-09-10T09:00:00Z'::timestamptz,
  true,
  'inboxoggxdk@agent.instinct.co',
  repeat('2', 32),
  '{"conversation_ref":"email-dedupe","sender_display":"Facebook sender","message_preview":"first inbound body"}'::jsonb,
  null
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('3', 32),
  'page-chronology',
  'psid-email-dedupe',
  'message',
  '2026-09-03T09:01:00Z'::timestamptz,
  'mid-email-dedupe',
  'inbound',
  'altered duplicate body',
  '{"conversation_ref":"email-dedupe","message_preview":"altered duplicate body"}'::jsonb,
  '[]',
  '2026-09-04T09:01:00Z'::timestamptz,
  '2026-09-10T09:01:00Z'::timestamptz,
  true,
  'inboxoggxdk@agent.instinct.co',
  repeat('4', 32),
  '{"conversation_ref":"email-dedupe","sender_display":"Facebook sender","message_preview":"altered duplicate body"}'::jsonb,
  null
);
do $$
begin
  if (
    select count(*)
    from public.facebook_messenger_messages
    where page_id = 'page-chronology' and message_id = 'mid-email-dedupe'
  ) <> 1 then
    raise exception 'same_mid_did_not_reuse_one_message_row';
  end if;

  if (
    select count(*)
    from public.facebook_messenger_email_outbox eo
    join public.facebook_messenger_messages msg on msg.id = eo.message_id
    where msg.page_id = 'page-chronology' and msg.message_id = 'mid-email-dedupe'
  ) <> 1 then
    raise exception 'same_mid_duplicate_enqueued_second_email';
  end if;
end $$;

-- Seed an outbound Messenger message that delivery/read receipts can target.
select public.facebook_ingest_messenger_webhook_event(
  repeat('a', 32),
  'page-chronology',
  'psid-chronology',
  'message_echo',
  '2026-09-03T10:00:00Z'::timestamptz,
  'mid-chronology',
  'outbound',
  'sent message',
  '{"conversation_ref":"chronology"}'::jsonb
);

-- Delivery: a stale later-arriving event must not replace the newer timestamp.
select public.facebook_ingest_messenger_webhook_event(
  repeat('b', 32), 'page-chronology', 'psid-chronology', 'message_delivery',
  '2026-09-03T10:10:00Z'::timestamptz, null, null, null,
  '{"kind":"delivery-new"}'::jsonb, '["mid-chronology"]'
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('c', 32), 'page-chronology', 'psid-chronology', 'message_delivery',
  '2026-09-03T10:05:00Z'::timestamptz, null, null, null,
  '{"kind":"delivery-stale"}'::jsonb, '["mid-chronology"]'
);
do $$
begin
  if (
    select (payload->>'last_delivery_at')::timestamptz
    from public.facebook_messenger_messages
    where page_id = 'page-chronology' and message_id = 'mid-chronology'
  ) is distinct from '2026-09-03T10:10:00Z'::timestamptz then
    raise exception 'stale_delivery_overwrote_newer_timestamp';
  end if;
end $$;

-- Missing/invalid existing delivery timestamp must be safely replaced.
update public.facebook_messenger_messages
set payload = jsonb_set(payload, '{last_delivery_at}', '"not-a-timestamp"'::jsonb, true)
where page_id = 'page-chronology' and message_id = 'mid-chronology';
select public.facebook_ingest_messenger_webhook_event(
  repeat('d', 32), 'page-chronology', 'psid-chronology', 'message_delivery',
  '2026-09-03T10:12:00Z'::timestamptz, null, null, null,
  '{"kind":"delivery-invalid-existing"}'::jsonb, '["mid-chronology"]'
);
do $$
begin
  if (
    select (payload->>'last_delivery_at')::timestamptz
    from public.facebook_messenger_messages
    where page_id = 'page-chronology' and message_id = 'mid-chronology'
  ) is distinct from '2026-09-03T10:12:00Z'::timestamptz then
    raise exception 'invalid_delivery_timestamp_was_not_replaced';
  end if;
end $$;

-- A delivery receipt must not mark an inbound message even when the MID matches.
select public.facebook_ingest_messenger_webhook_event(
  repeat('5', 32), 'page-chronology', 'psid-chronology', 'message',
  '2026-09-03T10:13:00Z'::timestamptz, 'mid-inbound-delivery-target', 'inbound', 'inbound should not be delivered',
  '{"conversation_ref":"chronology"}'::jsonb, '[]', null, null, false, null, null, null, null
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('6', 32), 'page-chronology', 'psid-chronology', 'message_delivery',
  '2026-09-03T10:14:00Z'::timestamptz, null, null, null,
  '{"kind":"delivery-inbound-target"}'::jsonb, '["mid-inbound-delivery-target"]'
);
do $$
begin
  if exists (
    select 1
    from public.facebook_messenger_messages
    where page_id = 'page-chronology'
      and message_id = 'mid-inbound-delivery-target'
      and coalesce(payload, '{}'::jsonb) ? 'last_delivery_at'
  ) then
    raise exception 'delivery_receipt_marked_inbound_message';
  end if;
end $$;

-- Read watermarks have no MIDs in production. Seed before/equal/after outbound messages.
select public.facebook_ingest_messenger_webhook_event(
  repeat('e', 32), 'page-chronology', 'psid-chronology', 'message_echo',
  '2026-09-03T10:18:00Z'::timestamptz, 'mid-before', 'outbound', 'before watermark',
  '{"conversation_ref":"chronology"}'::jsonb, '[]', null, null, false, null, null, null, null
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('f', 32), 'page-chronology', 'psid-chronology', 'message_echo',
  '2026-09-03T10:20:00Z'::timestamptz, 'mid-equal', 'outbound', 'equal watermark',
  '{"conversation_ref":"chronology"}'::jsonb, '[]', null, null, false, null, null, null, null
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('g', 32), 'page-chronology', 'psid-chronology', 'message_echo',
  '2026-09-03T10:21:00Z'::timestamptz, 'mid-after', 'outbound', 'after watermark',
  '{"conversation_ref":"chronology"}'::jsonb, '[]', null, null, false, null, null, null, null
);
select public.facebook_ingest_messenger_webhook_event(
  repeat('h', 32), 'page-chronology', 'psid-chronology', 'message_read',
  '2026-09-03T10:30:00Z'::timestamptz, null, null, null,
  '{"kind":"read-watermark"}'::jsonb, '[]', null, null, false, null, null, null,
  '2026-09-03T10:20:00Z'::timestamptz
);
do $$
begin
  if (
    select count(*)
    from public.facebook_messenger_messages
    where page_id = 'page-chronology'
      and psid = 'psid-chronology'
      and direction = 'outbound'
      and message_id in ('mid-chronology', 'mid-before', 'mid-equal')
      and (payload->>'last_read_at')::timestamptz = '2026-09-03T10:30:00Z'::timestamptz
  ) <> 3 then
    raise exception 'watermark_did_not_mark_all_eligible_outbound_messages';
  end if;

  if exists (
    select 1
    from public.facebook_messenger_messages
    where page_id = 'page-chronology'
      and psid = 'psid-chronology'
      and message_id = 'mid-after'
      and coalesce(payload, '{}'::jsonb) ? 'last_read_at'
  ) then
    raise exception 'watermark_marked_later_outbound_message';
  end if;

  if (
    select (payload->>'last_delivery_at')::timestamptz
    from public.facebook_messenger_messages
    where page_id = 'page-chronology' and message_id = 'mid-chronology'
  ) is distinct from '2026-09-03T10:12:00Z'::timestamptz then
    raise exception 'read_receipt_clobbered_delivery_timestamp';
  end if;
end $$;

-- Stale repeat cannot overwrite newer read timestamp.
select public.facebook_ingest_messenger_webhook_event(
  repeat('i', 32), 'page-chronology', 'psid-chronology', 'message_read',
  '2026-09-03T10:25:00Z'::timestamptz, null, null, null,
  '{"kind":"read-stale-watermark"}'::jsonb, '[]', null, null, false, null, null, null,
  '2026-09-03T10:20:00Z'::timestamptz
);
do $$
begin
  if (
    select (payload->>'last_read_at')::timestamptz
    from public.facebook_messenger_messages
    where page_id = 'page-chronology' and message_id = 'mid-before'
  ) is distinct from '2026-09-03T10:30:00Z'::timestamptz then
    raise exception 'stale_watermark_read_overwrote_newer_timestamp';
  end if;
end $$;

-- Missing/invalid read watermark fails closed and marks no new messages.
do $$
begin
  begin
    perform public.facebook_ingest_messenger_webhook_event(
      repeat('j', 32), 'page-chronology', 'psid-chronology', 'message_read',
      '2026-09-03T10:35:00Z'::timestamptz, null, null, null,
      '{"kind":"read-missing-watermark"}'::jsonb, '[]', null, null, false, null, null, null, null
    );
    raise exception 'missing_read_watermark_was_accepted';
  exception when invalid_parameter_value then
    null;
  end;

  begin
    perform public.facebook_ingest_messenger_webhook_event(
      repeat('k', 32), 'page-chronology', 'psid-chronology', 'message_read',
      '2026-09-03T10:36:00Z'::timestamptz, null, null, null,
      '{"kind":"read-invalid-watermark"}'::jsonb, '[]', null, null, false, null, null, null, 'not-a-timestamp'
    );
    raise exception 'invalid_read_watermark_was_accepted';
  exception when invalid_datetime_format then
    null;
  end;

  if exists (
    select 1
    from public.facebook_messenger_messages
    where page_id = 'page-chronology'
      and psid = 'psid-chronology'
      and message_id = 'mid-after'
      and coalesce(payload, '{}'::jsonb) ? 'last_read_at'
  ) then
    raise exception 'invalid_or_missing_watermark_marked_later_message';
  end if;
end $$;

select 'receipt_chronology_smoke_passed' as result;
"""


def main() -> int:
    for path in (INBOX_SQL, INGEST_SQL):
        if not path.exists():
            print(f"missing migration: {path}", file=sys.stderr)
            return 2

    run(["docker", "rm", "-f", CONTAINER], check=False)
    try:
        run([
            "docker",
            "run",
            "--name",
            CONTAINER,
            "-e",
            f"POSTGRES_PASSWORD={PASSWORD}",
            "-d",
            IMAGE,
        ])
        wait_for_postgres()
        bootstrap = """
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create table if not exists public.user_roles (user_id uuid primary key references auth.users(id), role text not null);
create table if not exists public.user_module_permissions (
  user_id uuid not null references auth.users(id),
  module_key text not null,
  can_view boolean not null default false,
  can_edit boolean not null default false,
  primary key (user_id, module_key)
);
create or replace function auth.role() returns text
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
"""
        psql(bootstrap)
        psql(INBOX_SQL.read_text())
        psql(INGEST_SQL.read_text())
        proc = psql(assertion_sql(), check=False)
        if proc.returncode != 0:
            sys.stdout.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            return proc.returncode
        sys.stdout.write(proc.stdout)
        return 0
    finally:
        run(["docker", "rm", "-f", CONTAINER], check=False)


if __name__ == "__main__":
    raise SystemExit(main())
