#!/usr/bin/env python3
"""Static contract checks for migration
20261031120000_submission_reminder_skip_rejected.sql.

These checks never connect to a database or Supabase. They guard the intent of
the migration "Nhắc chi gấp bỏ qua phiếu đã từ chối (phần dữ liệu)":

  * every open-line predicate ``payment_status::text in ('unpaid', 'partial')``
    in the new migration is accompanied by ``pr.status::text <> 'rejected'`` in
    the same where clause, so unpaid_count / remaining_amount / the message
    lines / the stop condition all ignore rejected requests;
  * the two re-created functions keep the exact signatures of their newest
    originals (20261030130000 and 20261030110000);
  * the same revoke/grant pairs are re-issued and security/search_path stay;
  * the rollback-only smoke ends in the PASS raise inside its DO block.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

NEW_MIGRATION = MIGRATIONS / "20261031120000_submission_reminder_skip_rejected.sql"
BUILDER_SOURCE = MIGRATIONS / "20261030130000_payment_submission_reminder_last_paid_v2.sql"
ENQUEUE_SOURCE = MIGRATIONS / "20261030110000_payment_submission_reminders.sql"
SMOKE = SCRIPTS / "smoke_submission_reminder_skip_rejected.sql"

PREDICATE = "payment_status::text in ('unpaid', 'partial')"
EXCLUSION = "pr.status::text <> 'rejected'"
PASS_RAISE = "raise exception 'SMOKE_RESULT PASS: submission reminder skip rejected';"

BUILDER_NAME = "public.build_finance_zalo_payment_submission_reminder_message"
ENQUEUE_NAME = "public.enqueue_payment_submission_reminders"

BUILDER_REVOKE = (
    "revoke all on function public.build_finance_zalo_payment_submission_reminder_message(uuid) "
    "from public, anon, authenticated;"
)
BUILDER_GRANT = (
    "grant execute on function public.build_finance_zalo_payment_submission_reminder_message(uuid) "
    "to service_role;"
)
ENQUEUE_REVOKE = (
    "revoke all on function public.enqueue_payment_submission_reminders(boolean) "
    "from public, anon, authenticated;"
)
ENQUEUE_GRANT = (
    "grant execute on function public.enqueue_payment_submission_reminders(boolean) to service_role;"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def strip_line_comments(sql: str) -> str:
    """Drop ``-- ...`` comments while keeping the line structure intact."""
    return re.sub(r"--[^\n]*", "", sql)


SIGNATURE_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+([\w.]+)\s*\((.*?)\)\s*returns",
    re.IGNORECASE | re.DOTALL,
)


def signatures(sql: str) -> dict[str, str]:
    """Map fully-qualified function name -> normalised parameter list."""
    result: dict[str, str] = {}
    for match in SIGNATURE_RE.finditer(sql):
        result[match.group(1)] = re.sub(r"\s+", " ", match.group(2)).strip()
    return result


def where_clause_windows(sql: str) -> list[str]:
    """Return the text from each open-line predicate to the end of its where clause.

    The end is the first ``;`` or the first line that closes the subquery or
    starts a new clause (``)``, ``group by``, ``order by``, ``loop``, ``then``),
    whichever is closer. This models "the same where clause" without a full SQL
    parser.
    """
    windows: list[str] = []
    for match in re.finditer(re.escape(PREDICATE), sql):
        rest = sql[match.end():]
        end = len(rest)

        semi = rest.find(";")
        if semi != -1:
            end = min(end, semi)

        boundary = re.search(
            r"\n[ \t]*\)|\n[ \t]*(?:group\s+by|order\s+by|loop|then)\b",
            rest,
            re.IGNORECASE,
        )
        if boundary:
            end = min(end, boundary.start())

        windows.append(rest[:end])
    return windows


def main() -> None:
    migration = read(NEW_MIGRATION)
    code = strip_line_comments(migration)

    # --- Every open-line predicate must exclude rejected requests ------------
    predicate_count = code.count(PREDICATE)
    assert_true(
        predicate_count >= 1,
        "the new migration must still select open submission lines",
    )
    windows = where_clause_windows(code)
    assert_true(
        len(windows) == predicate_count,
        f"expected {predicate_count} open-line windows, found {len(windows)}",
    )
    for index, window in enumerate(windows, start=1):
        assert_true(
            EXCLUSION in window,
            f"open-line predicate #{index} must require {EXCLUSION!r} in the same where clause",
        )

    # --- Signatures match the newest originals exactly -----------------------
    new_signatures = signatures(code)
    original_signatures = signatures(strip_line_comments(read(BUILDER_SOURCE)))
    original_signatures.update(signatures(strip_line_comments(read(ENQUEUE_SOURCE))))

    assert_true(
        set(new_signatures) == {BUILDER_NAME, ENQUEUE_NAME},
        f"the migration must re-create exactly the two reminder functions, got {sorted(new_signatures)}",
    )
    for name in (BUILDER_NAME, ENQUEUE_NAME):
        assert_true(name in original_signatures, f"original definition of {name} not found")
        assert_true(
            new_signatures[name] == original_signatures[name],
            f"{name} signature changed: {new_signatures[name]!r} != {original_signatures[name]!r}",
        )

    # --- Security / search_path / grants are preserved -----------------------
    assert_true(
        code.count("security definer") == 2,
        "both reminder functions must stay security definer",
    )
    assert_true(
        code.count("set search_path = public, pg_temp") == 2,
        "both reminder functions must pin search_path = public, pg_temp",
    )
    for statement in (BUILDER_REVOKE, BUILDER_GRANT, ENQUEUE_REVOKE, ENQUEUE_GRANT):
        assert_true(statement in code, f"migration must re-issue: {statement}")

    # Only the reminders functions may be touched: no tables, policies or cron.
    for forbidden in ("create table", "create policy", "cron.schedule", "cron.unschedule"):
        assert_true(
            forbidden not in code.lower(),
            f"the new migration must not contain {forbidden!r}",
        )

    # --- Smoke ends in the PASS raise inside its DO block --------------------
    smoke = read(SMOKE)
    assert_true("begin;" in smoke, "smoke must open one transaction")
    for fragment in ("create or replace function " + BUILDER_NAME, "create or replace function " + ENQUEUE_NAME):
        assert_true(fragment in smoke, f"smoke must apply the migration body inline ({fragment})")
    assert_true(
        smoke.count(PREDICATE) == predicate_count and smoke.count(EXCLUSION) == predicate_count,
        "smoke inline body must carry the same predicate/exclusion pairs",
    )

    raise_at = smoke.rfind(PASS_RAISE)
    assert_true(raise_at != -1, f"smoke must end with {PASS_RAISE!r}")
    assert_true(
        smoke[raise_at + len(PASS_RAISE):].strip() == "end $$;",
        "the PASS raise must be the last statement before the DO block closes",
    )

    print("PASS: submission reminder skip rejected contracts hold")


if __name__ == "__main__":
    main()
