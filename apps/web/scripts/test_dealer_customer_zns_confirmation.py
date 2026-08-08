#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260808093000_dealer_customer_zns_order_confirmations.sql"
WORKER = ROOT / "supabase/functions/dealer-order-confirm-notify/index.ts"
SHARED = ROOT / "supabase/functions/_shared/dealer-order-confirmation.ts"
CONFIG = ROOT / "supabase/config.toml"

migration = MIGRATION.read_text(encoding="utf-8")
worker = WORKER.read_text(encoding="utf-8")
shared = SHARED.read_text(encoding="utf-8")
config = CONFIG.read_text(encoding="utf-8")

required_migration = [
    "dealer_customer_order_confirmations",
    "dealer_order_confirmation_enabled",
    "values ('dealer_order_confirmation_enabled', 'false')",
    "claim_dealer_customer_order_confirmations",
    "commit_dealer_customer_order_confirmation_send",
    "send_committed",
    "for update of n skip locked",
    "auth.role() is distinct from 'service_role'",
    "revoke all on function public.claim_dealer_customer_order_confirmations",
    "enable row level security",
    "revoke all on table public.dealer_customer_order_confirmations from public, anon, authenticated",
    "dealer-order-confirm-notify",
    "dealer-order-confirm-notify-every-minute",
]
for marker in required_migration:
    assert marker in migration, marker
assert "n.status = 'processing' and n.locked_at" not in migration

# Privacy contract: outbox references a contact; it must not duplicate a phone number.
table_ddl = migration.split("create table if not exists public.dealer_customer_order_confirmations", 1)[1].split(");", 1)[0]
assert "contact_id" in table_ddl
assert "phone" not in table_ddl.lower()

required_worker = [
    'DEALER_VIETGUYS_ORDER_CONFIRM_TEMPLATE_ID',
    'dealer_order_confirmation_enabled',
    'claim_dealer_customer_order_confirmations',
    'sendDealerOrderConfirmationZns',
    '.eq("is_active", true)',
    'status: "suppressed"',
    'status: "failed"',
    'dealerOrderConfirmationFailureTransition',
    'order_not_submitted_before_send',
]
for marker in required_worker:
    assert marker in worker, marker

for marker in ['manual_reconciliation_required', 'pre_send_validation_failed']:
    assert marker in shared, marker

assert "DEALER_VIETGUYS_TEMPLATE_ID" not in worker
assert "otp" not in shared.lower()
assert "sms" not in shared.lower()
config_block = config.split("[functions.dealer-order-confirm-notify]", 1)[1].split("[functions.", 1)[0]
assert "verify_jwt = false" in config_block
print("dealer customer ZNS confirmation static contract passed")
