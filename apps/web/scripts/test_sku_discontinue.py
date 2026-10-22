from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
DEALER_CATALOG = ROOT / "supabase/functions/_shared/dealer-catalog-data.ts"
DEALER_ORDER_SUBMIT = ROOT / "supabase/functions/dealer-order-submit/index.ts"
TYPES = ROOT / "src/integrations/supabase/types.ts"
HOOK = ROOT / "src/hooks/useSkuDiscontinue.ts"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def latest_discontinued_migration() -> str:
    matches = sorted(MIGRATIONS.glob("*_sku_discontinued.sql"))
    assert matches, "Missing sku discontinued migration"
    return read(matches[-1])


def latest_save_sku_cogs_migration() -> str:
    matches = sorted(
        path
        for path in MIGRATIONS.glob("*.sql")
        if "create or replace function public.save_sku_cogs" in read(path)
    )
    assert matches, "Missing save_sku_cogs definition"
    return read(matches[-1])


def test_migration_adds_discontinued_columns_and_request_table():
    migration = latest_discontinued_migration()
    assert "alter table public.product_skus" in migration
    assert "add column if not exists discontinued_at timestamptz" in migration
    assert "add column if not exists discontinued_by uuid" in migration
    assert "create table if not exists public.sku_discontinue_requests" in migration
    assert "request_id uuid primary key" in migration
    assert "sku_id uuid not null references public.product_skus(id)" in migration
    assert "value boolean not null" in migration
    assert "enable row level security" in migration


def test_set_sku_discontinued_is_secured_and_idempotent():
    migration = latest_discontinued_migration()
    save_sku_cogs = latest_save_sku_cogs_migration()

    permission_line = next(
        line.strip()
        for line in save_sku_cogs.splitlines()
        if "if actor_id is null or not (public.has_role" in line
    )
    assert permission_line in migration
    assert "raise exception 'forbidden'" in migration
    assert "raise exception 'sku_not_found'" in migration

    assert "create or replace function public.set_sku_discontinued(" in migration
    assert "language plpgsql" in migration
    assert "security definer" in migration
    assert "set search_path = public" in migration

    assert "from public.sku_discontinue_requests r where r.request_id = p_request_id" in migration
    assert "insert into public.sku_discontinue_requests" in migration
    assert "case when p_value then coalesce(ps.discontinued_at, now()) else null end" in migration
    assert "case when p_value then actor_id else null end" in migration
    assert "jsonb_build_object('sku_id', p_sku_id, 'discontinued_at', v_discontinued_at)" in migration

    assert "revoke all on function public.set_sku_discontinued(uuid, boolean, uuid) from public, anon;" in migration
    assert "grant execute on function public.set_sku_discontinued(uuid, boolean, uuid) to authenticated;" in migration


def test_snapshot_functions_exclude_discontinued_finished_goods():
    migration = latest_discontinued_migration()
    assert "create or replace function public.get_warehouse_game_snapshot(p_location text)" in migration
    assert "create or replace function public.get_tan_tao_warehouse_snapshot()" in migration

    game_part = migration.split(
        "create or replace function public.get_warehouse_game_snapshot", 1
    )[1].split("create or replace function public.get_tan_tao_warehouse_snapshot", 1)[0]
    tan_tao_part = migration.split(
        "create or replace function public.get_tan_tao_warehouse_snapshot", 1
    )[1]

    assert "discontinued_at is null" in game_part
    assert "discontinued_at is null" in tan_tao_part


def test_dealer_catalog_and_order_submit_reject_discontinued_skus():
    catalog = read(DEALER_CATALOG)
    assert "discontinued_at" in catalog
    assert "!sku.hide_from_dealer_portal && !sku.discontinued_at" in catalog

    submit = read(DEALER_ORDER_SUBMIT)
    assert "discontinued_at" in submit
    assert "!sku.hide_from_dealer_portal && !sku.discontinued_at" in submit
    assert '"invalid_sku"' in submit


def test_client_types_and_hook_support_discontinued_skus():
    types = read(TYPES)
    product_skus = types.split("product_skus: {", 1)[1].split("Relationships:", 1)[0]
    assert "discontinued_at: string | null" in product_skus
    assert "discontinued_by: string | null" in product_skus
    assert product_skus.count("discontinued_at?: string | null") >= 2
    assert product_skus.count("discontinued_by?: string | null") >= 2

    assert "set_sku_discontinued: {" in types
    function_part = types.split("set_sku_discontinued: {", 1)[1].split("}", 1)[0]
    assert "p_sku_id: string" in function_part
    assert "p_value: boolean" in function_part
    assert "p_request_id: string" in function_part

    hook = read(HOOK)
    assert "isSkuDiscontinued" in hook
    assert 'supabase.rpc("set_sku_discontinued"' in hook
    assert "p_request_id: crypto.randomUUID()" in hook
    assert 'invalidateQueries({ queryKey: ["product-skus"] })' in hook
    assert 'invalidateQueries({ queryKey: ["tan-tao-warehouse-snapshot"] })' in hook
    assert 'invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] })' in hook


if __name__ == "__main__":
    tests = [
        value
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    failures = 0
    for test in tests:
        try:
            test()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
    if failures:
        raise SystemExit(1)
    print(f"ok - {len(tests)} tests passed")
