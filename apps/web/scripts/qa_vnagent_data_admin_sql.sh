#!/usr/bin/env bash
# VNAgent data-assets admin — direct-write denial regression.
#
# Proves that the raw authenticated write path (the exact SQL a REST client could
# issue) is denied by grants/RLS, so no caller can fabricate a stage, version,
# reviewer, evidence row or audit event. Requires an isolated PostgreSQL with the
# bootstrap roles (anon/authenticated/service_role + auth.uid + public.has_role)
# already applied.
#
# Usage:
#   VNAGENT_TEST_DATABASE_URL=postgres://... apps/web/scripts/qa_vnagent_data_admin_sql.sh
set -euo pipefail

: "${VNAGENT_TEST_DATABASE_URL:?set VNAGENT_TEST_DATABASE_URL to an isolated test database}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OWNER="00000000-0000-4000-8000-000000000001"

psql "$VNAGENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$WEB_DIR/supabase/migrations/20260920120000_vnagent_data_assets.sql" >/dev/null
psql "$VNAGENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$WEB_DIR/supabase/migrations/20260920130000_vnagent_data_admin_corrections.sql" >/dev/null
psql "$VNAGENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SCRIPT_DIR/qa_vnagent_data_admin_sql.sql"

deny() {
  local name="$1" statement="$2"
  if psql "$VNAGENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
      -c "set role authenticated; set request.jwt.claim.sub='${OWNER}'; ${statement}" >/dev/null 2>&1; then
    echo "FAIL: ${name} was ALLOWED for authenticated" >&2
    exit 1
  fi
  echo "ok: ${name} denied"
}

deny "direct INSERT into vnagent_data_assets" \
  "insert into public.vnagent_data_assets(source_kind,source_designation,question,dedupe_key) values('contributor','manual','probe','probe-direct')"
deny "direct UPDATE of dataset_stage/version" \
  "update public.vnagent_data_assets set dataset_stage='curated',version=99"
deny "direct INSERT into the audit trail" \
  "insert into public.vnagent_data_asset_events(asset_id,from_stage,to_stage,from_version,to_version) values(gen_random_uuid(),'raw','curated',1,2)"
deny "direct INSERT into vnagent_jev_events" \
  "insert into public.vnagent_jev_events(request_id,metric) values('probe','probe')"
deny "direct INSERT into vnagent_interactions" \
  "insert into public.vnagent_interactions(request_id,question_text,response_status) values('probe','probe','success')"
deny "call of the trusted capture RPC" \
  "select public.vnagent_capture_chat('{\"request_id\":\"probe\"}'::jsonb, null)"

echo "VNAgent data-admin direct-write denial regression: PASSED"
