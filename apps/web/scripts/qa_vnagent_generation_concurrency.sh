#!/usr/bin/env bash
# VNAgent generation — PostgreSQL concurrency + authorization proof.
#
# Proves the durable job RPC is atomically owner-scoped:
#   * concurrent distinct keys -> EXACTLY ONE accepted, the other generation_busy;
#   * concurrent SAME key      -> one dispatch, one resume (same job id);
#   * same key + different payload -> idempotency_conflict (409 semantics);
#   * non-owner and anon are denied.
#
# Runs against an isolated PostgreSQL (never the real DB). Either:
#   VNAGENT_TEST_DATABASE_URL=postgres://... apps/web/scripts/qa_vnagent_generation_concurrency.sh
# or an existing isolated container:
#   VNAGENT_TEST_CONTAINER=bmq-generation-qa-20260921 VNAGENT_TEST_DATABASE=bmq_gen_qa \
#     apps/web/scripts/qa_vnagent_generation_concurrency.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"
OUT="${REPO_ROOT}/generated/coordinator/concurrency-proof.json"

OWNER="00000000-0000-4000-8000-000000000001"
STAFF="00000000-0000-4000-8000-000000000002"
REQUEST_A='{"topic":"controlled_revenue","count":20,"target_language":"vi","style_mix":{"variant":12,"typo":3,"ambiguous":3,"out_of_scope":2},"seed_ids":["seed-revenue-today"]}'
REQUEST_B='{"topic":"controlled_revenue","count":30,"target_language":"vi","style_mix":{"variant":18,"typo":5,"ambiguous":4,"out_of_scope":3},"seed_ids":["seed-revenue-today"]}'
SEEDS='["seed-revenue-today"]'

if [ -n "${VNAGENT_TEST_DATABASE_URL:-}" ]; then
  PSQL=(psql "$VNAGENT_TEST_DATABASE_URL")
  TARGET_DESC="$VNAGENT_TEST_DATABASE_URL"
else
  : "${VNAGENT_TEST_CONTAINER:?set VNAGENT_TEST_DATABASE_URL or VNAGENT_TEST_CONTAINER}"
  DB="${VNAGENT_TEST_DATABASE:-postgres}"
  PSQL=(docker exec -i "$VNAGENT_TEST_CONTAINER" psql -U postgres -d "$DB")
  TARGET_DESC="container:${VNAGENT_TEST_CONTAINER}/${DB}"
fi

mkdir -p "$(dirname "$OUT")"
WORK="$(cd "$(dirname "$OUT")" && pwd)/.concurrency-work"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

apply() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -q -f - < "$1"; }

# Run SQL; prints stdout+stderr; returns psql exit status.
run_sql() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -qAt -c "$1" 2>&1 </dev/null; }

call_as() { # role(sub|'') owner|'' key fp request sleep
  local jwt="$1" key="$2" fp="$3" request="$4" sleep="$5"
  local pre=""
  [ -n "$jwt" ] && pre="set local request.jwt.claim.sub='${jwt}';"
  local sql="begin; set local role authenticated; ${pre} select public.vnagent_generation_job_start('${request}'::jsonb, '${key}', '${fp}', 'm', 'p', '${SEEDS}'::jsonb, 1, 0.05); select pg_sleep(${sleep}); commit;"
  "${PSQL[@]}" -v ON_ERROR_STOP=1 -qAt -c "$sql" 2>&1 </dev/null
}

hr() { printf '%s\n' "────────────────────────────────────────────────────────"; }

hr
echo "VNAgent generation concurrency proof — ${TARGET_DESC}"
hr

apply "$SCRIPT_DIR/qa_vnagent_fixture_bootstrap.sql"
apply "$WEB_DIR/supabase/migrations/20260920120000_vnagent_data_assets.sql"
apply "$WEB_DIR/supabase/migrations/20260920130000_vnagent_data_admin_corrections.sql"
apply "$WEB_DIR/supabase/migrations/20260921100000_vnagent_generation_jobs.sql"

reset_jobs() { run_sql "delete from public.vnagent_generation_jobs;" >/dev/null 2>&1 || true; }

RESULTS="$WORK/checks.txt"
: > "$RESULTS"

record() { # name pass detail
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
  if [ "$2" = "true" ]; then echo "PASS  $1"; else echo "FAIL  $1 — $3"; fi
}

# 1. Same key resumes the durable job instead of dispatching twice.
reset_jobs
FIRST="$(call_as "$OWNER" 'owner-same-key-1' 'fp-same' "$REQUEST_A" 0)"
SECOND="$(call_as "$OWNER" 'owner-same-key-1' 'fp-same' "$REQUEST_A" 0)"
FIRST_ID="$(printf '%s' "$FIRST" | grep -o '"id": "[0-9a-f-]*"' | head -1)"
SECOND_ID="$(printf '%s' "$SECOND" | grep -o '"id": "[0-9a-f-]*"' | head -1)"
if printf '%s' "$FIRST" | grep -q '"resumed": false' && printf '%s' "$SECOND" | grep -q '"resumed": true' && [ "$FIRST_ID" = "$SECOND_ID" ] && [ -n "$FIRST_ID" ]; then
  record same_key_resume true "one job ${FIRST_ID}, second call resumed"
else
  record same_key_resume false "first=$(printf '%s' "$FIRST" | head -c 200) second=$(printf '%s' "$SECOND" | head -c 200)"
fi

# 2. Same key + different payload is a conflict.
reset_jobs
call_as "$OWNER" 'owner-conflict-1' 'fp-a' "$REQUEST_A" 0 >/dev/null 2>&1 || true
CONFLICT="$(call_as "$OWNER" 'owner-conflict-1' 'fp-b' "$REQUEST_B" 0 || true)"
if printf '%s' "$CONFLICT" | grep -qi 'idempotency_conflict'; then
  record same_key_payload_conflict true "$(printf '%s' "$CONFLICT" | tr '\n' ' ' | head -c 160)"
else
  record same_key_payload_conflict false "expected idempotency_conflict, got: $(printf '%s' "$CONFLICT" | tr '\n' ' ' | head -c 200)"
fi

# 3. Non-owner (staff) is denied.
reset_jobs
STAFF_OUT="$(call_as "$STAFF" 'staff-denied-1' 'fp-s' "$REQUEST_A" 0 || true)"
if printf '%s' "$STAFF_OUT" | grep -qi 'forbidden'; then
  record nonowner_denied true "$(printf '%s' "$STAFF_OUT" | tr '\n' ' ' | head -c 120)"
else
  record nonowner_denied false "expected forbidden, got: $(printf '%s' "$STAFF_OUT" | tr '\n' ' ' | head -c 200)"
fi

# 4. Anonymous (no JWT) is denied.
reset_jobs
ANON_OUT="$(call_as '' 'anon-denied-1' 'fp-a' "$REQUEST_A" 0 || true)"
if printf '%s' "$ANON_OUT" | grep -qi 'forbidden'; then
  record anon_denied true "$(printf '%s' "$ANON_OUT" | tr '\n' ' ' | head -c 120)"
else
  record anon_denied false "expected forbidden, got: $(printf '%s' "$ANON_OUT" | tr '\n' ' ' | head -c 200)"
fi

# 5. Concurrent DISTINCT keys: exactly one accepted.
reset_jobs
call_as "$OWNER" 'race-distinct-1' 'fp-1' "$REQUEST_A" 1.5 > "$WORK/race-a.out" 2>&1 &
PID_A=$!
sleep 0.2
call_as "$OWNER" 'race-distinct-2' 'fp-2' "$REQUEST_A" 0 > "$WORK/race-b.out" 2>&1 &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
A_OK=$(grep -c '"resumed"' "$WORK/race-a.out" || true)
B_OK=$(grep -c '"resumed"' "$WORK/race-b.out" || true)
A_BUSY=$(grep -ci 'generation_busy' "$WORK/race-a.out" || true)
B_BUSY=$(grep -ci 'generation_busy' "$WORK/race-b.out" || true)
RUNNING_ROWS="$(run_sql "select count(*) from public.vnagent_generation_jobs where status='running';" | tr -d '[:space:]')"
if [ "$A_OK" -eq 1 ] && [ "$B_OK" -eq 0 ] && [ "$B_BUSY" -eq 1 ] && [ "$A_BUSY" -eq 0 ] && [ "$RUNNING_ROWS" = "1" ]; then
  record concurrent_distinct_keys_exactly_one true "A accepted, B generation_busy, running rows=${RUNNING_ROWS}"
elif [ "$B_OK" -eq 1 ] && [ "$A_OK" -eq 0 ] && [ "$A_BUSY" -eq 1 ] && [ "$B_BUSY" -eq 0 ] && [ "$RUNNING_ROWS" = "1" ]; then
  record concurrent_distinct_keys_exactly_one true "B accepted, A generation_busy, running rows=${RUNNING_ROWS}"
else
  record concurrent_distinct_keys_exactly_one false "A=$(head -c 160 "$WORK/race-a.out" | tr '\n' ' ') B=$(head -c 160 "$WORK/race-b.out" | tr '\n' ' ') running=${RUNNING_ROWS}"
fi

# 6. Concurrent SAME key: one dispatch, one resume, one row.
reset_jobs
call_as "$OWNER" 'race-same-key-1' 'fp-same' "$REQUEST_A" 1.5 > "$WORK/same-a.out" 2>&1 &
PID_A=$!
sleep 0.2
call_as "$OWNER" 'race-same-key-1' 'fp-same' "$REQUEST_A" 0 > "$WORK/same-b.out" 2>&1 &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true
DISPATCHES=$(grep -c '"resumed": false' "$WORK/same-a.out" "$WORK/same-b.out" | awk -F: '{s+=$2} END {print s+0}')
RESUMES=$(grep -c '"resumed": true' "$WORK/same-a.out" "$WORK/same-b.out" | awk -F: '{s+=$2} END {print s+0}')
SAME_ROWS="$(run_sql "select count(*) from public.vnagent_generation_jobs;" | tr -d '[:space:]')"
if [ "$DISPATCHES" -eq 1 ] && [ "$RESUMES" -eq 1 ] && [ "$SAME_ROWS" = "1" ]; then
  record concurrent_same_key_single_dispatch true "dispatches=${DISPATCHES}, resumes=${RESUMES}, rows=${SAME_ROWS}"
else
  record concurrent_same_key_single_dispatch false "dispatches=${DISPATCHES}, resumes=${RESUMES}, rows=${SAME_ROWS}, a=$(head -c 160 "$WORK/same-a.out" | tr '\n' ' ') b=$(head -c 160 "$WORK/same-b.out" | tr '\n' ' ')"
fi

# 7. The structural one-running-per-owner index exists.
IDX="$(run_sql "select count(*) from pg_indexes where schemaname='public' and indexname='vnagent_generation_jobs_one_running_idx';" | tr -d '[:space:]')"
if [ "$IDX" = "1" ]; then
  record one_running_unique_index true "partial unique index present"
else
  record one_running_unique_index false "index missing"
fi

# 8. Exact-key recovery: the key returns the job, an absent key is authoritatively
#    empty, and finish is version-checked to a terminal state.
reset_jobs
call_as "$OWNER" 'lookup-key-0001' 'fp-l' "$REQUEST_A" 0 >/dev/null 2>&1
LOOKUP="$(run_sql "begin; set local role authenticated; set local request.jwt.claim.sub='${OWNER}'; select (public.vnagent_generation_job_get(null,'lookup-key-0001',10) ->> 'job') is not null; select public.vnagent_generation_job_get(null,'absent-key-0000',10)::text; commit;" | tr -d '[:space:]')"
FINISHED="$(run_sql "begin; set local role authenticated; set local request.jwt.claim.sub='${OWNER}'; select public.vnagent_generation_job_finish((select id from public.vnagent_generation_jobs where idempotency_key='lookup-key-0001'),1,'completed','{\"created\":20}'::jsonb,0.02,null) -> 'job' ->> 'status'; select public.vnagent_generation_job_get(null,'lookup-key-0001',10) -> 'job' ->> 'status'; commit;" | tr -d '[:space:]')"
if [ "$LOOKUP" = "t{\"job\":null,\"abandoned\":false}" ] && [ "$FINISHED" = "completedcompleted" ]; then
  record exact_key_lookup_and_finish true "found then {\"job\":null,\"abandoned\":false} when absent; finish -> completed"
else
  record exact_key_lookup_and_finish false "lookup=${LOOKUP} finished=${FINISHED}"
fi

# 9. Expired lease recovery (server clock): an expired running job is surfaced as
#    abandoned for an explicit release, and a NEW key reaps it instead of deadlocking.
reset_jobs
call_as "$OWNER" 'expired-key-0001' 'fp-e' "$REQUEST_A" 0 >/dev/null 2>&1
run_sql "update public.vnagent_generation_jobs set lease_expires_at = now() - interval '1 minute' where idempotency_key='expired-key-0001';" >/dev/null
EXPIRED_FLAG="$(run_sql "begin; set local role authenticated; set local request.jwt.claim.sub='${OWNER}'; select public.vnagent_generation_job_get(null,'expired-key-0001',10) ->> 'abandoned'; commit;" | tr -d '[:space:]')"
SAME_ABANDONED="$(call_as "$OWNER" 'expired-key-0001' 'fp-e' "$REQUEST_A" 0 | grep -o '"abandoned": [a-z]*' | head -1 | tr -d ' ')"
NEW_AFTER_EXPIRY="$(call_as "$OWNER" 'expired-new-key-1' 'fp-n' "$REQUEST_A" 0)"
RUNNING_AFTER="$(run_sql "select count(*) from public.vnagent_generation_jobs where status='running';" | tr -d '[:space:]')"
if [ "$EXPIRED_FLAG" = "true" ] && [ "$SAME_ABANDONED" = '"abandoned":true' ] && printf '%s' "$NEW_AFTER_EXPIRY" | grep -q '"resumed": false' && [ "$RUNNING_AFTER" = "1" ]; then
  record expired_lease_recovery true "abandoned=true on read; same key no dispatch; new key accepted; running rows=1"
else
  record expired_lease_recovery false "flag=${EXPIRED_FLAG} same=${SAME_ABANDONED} new=$(printf '%s' "$NEW_AFTER_EXPIRY" | head -c 140) running=${RUNNING_AFTER}"
fi

PASSED="true"
while IFS=$'\t' read -r _name pass _detail; do
  [ "$pass" = "true" ] || PASSED="false"
done < "$RESULTS"

mkdir -p "$(dirname "$OUT")"
python3 - "$RESULTS" "$OUT" "$TARGET_DESC" "$PASSED" <<'PY'
import json, sys
results, out, target, passed = sys.argv[1:5]
checks = []
with open(results) as handle:
    for line in handle:
        name, ok, detail = line.rstrip("\n").split("\t", 2)
        checks.append({"name": name, "pass": ok == "true", "detail": detail})
payload = {
    "environment": {"target": target, "postgres": "18"},
    "before": {
        "source": "generated/coordinator/concurrency-interim.json",
        "observed": "Both concurrent distinct-key jobs were accepted (race reproduced).",
    },
    "checks": checks,
    "passed": passed == "true",
}
with open(out, "w") as handle:
    json.dump(payload, handle, indent=2)
    handle.write("\n")
print(json.dumps(payload, indent=2))
PY

hr
if [ "$PASSED" = "true" ]; then
  echo "PASS: exactly one concurrent dispatch; same key never double-dispatches; conflicts and denials enforced."
  echo "Evidence: ${OUT}"
else
  echo "FAIL: see checks above." >&2
  exit 1
fi
