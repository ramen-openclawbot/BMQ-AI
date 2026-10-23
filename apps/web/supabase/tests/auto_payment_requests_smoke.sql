-- Rollback-only smoke cho migration 20261102960000_auto_payment_requests.sql.
--
-- Chạy: `supabase db query --linked -f supabase/tests/auto_payment_requests_smoke.sql`.
-- File mở một transaction, dán nguyên migration, tạo fixture rollback-only, rồi
-- rollback ở cuối. Không sửa / duyệt / chi bất kỳ phiếu thật nào.
begin;

-- ---------------------------------------------------------------------------
-- Inline copy of 20261102960000_auto_payment_requests.sql
-- ---------------------------------------------------------------------------
-- Bộ học duyệt chi — bước 1.
--
-- 1. public.expense_templates — khuôn khoản chi học từ các đề nghị chi lập tay
--    không có PO và không phải tiền mặt.
-- 2. public.incoming_invoices — hàng đợi hóa đơn đầu vào (email / link NCC / tay).
-- 3. public.expense_template_feedback — phản hồi khi chủ sửa / từ chối / duyệt
--    phiếu do bộ học tự lập.
-- 4. public.learn_expense_templates() — học khuôn (owner hoặc service_role).
-- 5. public.match_incoming_invoice(uuid) — ghép NCC + khuôn cho hóa đơn.
-- 6. public.create_payment_request_from_invoice(uuid) — tạo đúng một phiếu
--    Chờ duyệt từ hóa đơn đã ghép; idempotent theo incoming_invoices.payment_request_id.
-- 7. public.get_expense_due_notices() / public.get_auto_payment_request_count().
-- 8. Trigger ghi phản hồi trên payment_requests.
-- 9. Cron wrapper chạy hằng ngày 05:40 giờ VN (22:40 UTC).
--
-- Migration này không sửa, duyệt, chi hay xóa phiếu cũ. Nó chỉ tạo dữ liệu học
-- và các phiếu Chờ duyệt mới từ hóa đơn đầu vào.

-- ===========================================================================
-- 1. Bảng học khuôn chi
-- ===========================================================================

create table if not exists public.expense_templates (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  key text not null unique,
  label text not null,
  cadence text not null default 'irregular'
    check (cadence in ('monthly', 'irregular')),
  typical_day integer
    check (typical_day is null or typical_day between 1 and 31),
  amount_median numeric,
  amount_min numeric,
  amount_max numeric,
  sample_count integer not null default 0,
  last_request_id uuid references public.payment_requests(id) on delete set null,
  last_period text,
  title_pattern text,
  notes_pattern text,
  items_template jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items_template) = 'array'),
  requires_receipt boolean not null default true,
  payment_method public.payment_method_type default 'bank_transfer'::public.payment_method_type,
  cost_category_code text,
  confidence numeric
    check (confidence is null or confidence between 0 and 1),
  active boolean not null default true,
  goods_supplier boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.expense_templates
  add column if not exists goods_supplier boolean not null default false;

create index if not exists idx_expense_templates_supplier_active
  on public.expense_templates (supplier_id, active);
create index if not exists idx_expense_templates_active_cadence
  on public.expense_templates (active, cadence);

-- ===========================================================================
-- 2. Hàng đợi hóa đơn đầu vào
-- ===========================================================================

create table if not exists public.incoming_invoices (
  id uuid primary key default gen_random_uuid(),
  source text not null
    check (source in ('email', 'supplier_link', 'manual')),
  source_ref text unique,
  file_path text,
  file_mime text,
  seller_name text,
  seller_tax_code text,
  invoice_number text,
  invoice_series text,
  invoice_date date,
  period text,
  subtotal numeric,
  vat_amount numeric,
  total_amount numeric,
  raw jsonb,
  supplier_id uuid references public.suppliers(id) on delete set null,
  template_id uuid references public.expense_templates(id) on delete set null,
  match_source text,
  match_confidence numeric
    check (match_confidence is null or match_confidence between 0 and 1),
  status text not null default 'new'
    check (status in ('new', 'matched', 'pr_created', 'needs_review', 'ignored')),
  payment_request_id uuid unique references public.payment_requests(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_incoming_invoices_status
  on public.incoming_invoices (status, created_at desc);
create index if not exists idx_incoming_invoices_supplier_period
  on public.incoming_invoices (supplier_id, period);
create index if not exists idx_incoming_invoices_invoice_date
  on public.incoming_invoices (invoice_date desc);

-- ===========================================================================
-- 3. Phản hồi của chủ với phiếu tự lập
-- ===========================================================================

create table if not exists public.expense_template_feedback (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.expense_templates(id) on delete cascade,
  payment_request_id uuid references public.payment_requests(id) on delete cascade,
  kind text not null
    check (kind in ('edited', 'rejected', 'approved')),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_expense_template_feedback_template
  on public.expense_template_feedback (template_id, created_at desc);
create index if not exists idx_expense_template_feedback_request
  on public.expense_template_feedback (payment_request_id, kind);

-- ===========================================================================
-- 4. RLS: chỉ owner / người có quyền payment_requests edit được đọc.
--    Client không được ghi trực tiếp; service_role giữ toàn quyền.
-- ===========================================================================

alter table public.expense_templates enable row level security;
alter table public.incoming_invoices enable row level security;
alter table public.expense_template_feedback enable row level security;

revoke all on table public.expense_templates from public, anon, authenticated;
revoke all on table public.incoming_invoices from public, anon, authenticated;
revoke all on table public.expense_template_feedback from public, anon, authenticated;

grant select on table public.expense_templates to authenticated;
grant select on table public.incoming_invoices to authenticated;
grant select on table public.expense_template_feedback to authenticated;
grant all on table public.expense_templates to service_role;
grant all on table public.incoming_invoices to service_role;
grant all on table public.expense_template_feedback to service_role;

drop policy if exists expense_templates_select on public.expense_templates;
create policy expense_templates_select
  on public.expense_templates
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner'::public.app_role)
    or public.has_module_permission(auth.uid(), 'payment_requests', 'edit')
  );

drop policy if exists incoming_invoices_select on public.incoming_invoices;
create policy incoming_invoices_select
  on public.incoming_invoices
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner'::public.app_role)
    or public.has_module_permission(auth.uid(), 'payment_requests', 'edit')
  );

drop policy if exists expense_template_feedback_select on public.expense_template_feedback;
create policy expense_template_feedback_select
  on public.expense_template_feedback
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner'::public.app_role)
    or public.has_module_permission(auth.uid(), 'payment_requests', 'edit')
  );

-- ===========================================================================
-- 5. Hàm chuẩn hóa kỳ / tên / request number dùng chung
-- ===========================================================================

-- Bỏ kỳ dạng T09/2026, T092026, T7/26, T10/2026, T3.2026, 12/2025 khỏi ghi chú.
create or replace function public.expense_strip_period(p_text text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(p_text, ''), 'T[0-9]{1,2}[/.][0-9]{4}', '', 'gi'),
            'T[0-9]{1,2}[/.][0-9]{2}', '', 'gi'
          ),
          'T[0-9]{1,2}[0-9]{4}', '', 'gi'
        ),
        '[0-9]{1,2}/[0-9]{4}', '', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

-- Đọc kỳ từ ghi chú. Trả về ngày đầu tháng, hoặc null khi không có kỳ.
create or replace function public.expense_period_from_text(p_text text)
returns date
language plpgsql
immutable
as $$
declare
  v_match text[];
  v_month integer;
  v_year integer;
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})[/.]([0-9]{4})', 'i');
  if v_match is not null then
    v_month := v_match[1]::integer;
    v_year := v_match[2]::integer;
  else
    v_match := regexp_match(p_text, 'T([0-9]{1,2})[/.]([0-9]{2})', 'i');
    if v_match is not null then
      v_month := v_match[1]::integer;
      v_year := 2000 + v_match[2]::integer;
    end if;
  end if;

  if v_match is null then
    v_match := regexp_match(p_text, 'T([0-9]{1,2})([0-9]{4})', 'i');
    if v_match is not null then
      v_month := v_match[1]::integer;
      v_year := v_match[2]::integer;
    end if;
  end if;

  -- Chấp nhận kỳ không có tiền tố T, ví dụ "12/2025".
  if v_match is null then
    v_match := regexp_match(p_text, '([0-9]{1,2})/([0-9]{4})');
    if v_match is not null then
      v_month := v_match[1]::integer;
      v_year := v_match[2]::integer;
    end if;
  end if;

  if v_match is null
     or v_month not between 1 and 12
     or v_year not between 2000 and 2099 then
    return null;
  end if;

  return make_date(v_year, v_month, 1);
end;
$$;

-- Đổi kỳ trong ghi chú thành placeholder, giữ đúng độ dài tháng/năm của mẫu.
create or replace function public.expense_notes_pattern(p_text text)
returns text
language plpgsql
immutable
as $$
declare
  v_match text[];
  v_month_token text;
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})/([0-9]{4})', 'i');
  if v_match is not null then
    v_month_token := case when length(v_match[1]) = 1 then '{m}' else '{mm}' end;
    return replace(
      p_text,
      'T' || v_match[1] || '/' || v_match[2],
      'T' || v_month_token || '/{yyyy}'
    );
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})/([0-9]{2})', 'i');
  if v_match is not null then
    v_month_token := case when length(v_match[1]) = 1 then '{m}' else '{mm}' end;
    return replace(
      p_text,
      'T' || v_match[1] || '/' || v_match[2],
      'T' || v_month_token || '/{yy}'
    );
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})\.([0-9]{4})', 'i');
  if v_match is not null then
    v_month_token := case when length(v_match[1]) = 1 then '{m}' else '{mm}' end;
    return replace(
      p_text,
      'T' || v_match[1] || '.' || v_match[2],
      'T' || v_month_token || '.{yyyy}'
    );
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})\.([0-9]{2})', 'i');
  if v_match is not null then
    v_month_token := case when length(v_match[1]) = 1 then '{m}' else '{mm}' end;
    return replace(
      p_text,
      'T' || v_match[1] || '.' || v_match[2],
      'T' || v_month_token || '.{yy}'
    );
  end if;

  v_match := regexp_match(p_text, 'T([0-9]{1,2})([0-9]{4})', 'i');
  if v_match is not null then
    v_month_token := case when length(v_match[1]) = 1 then '{m}' else '{mm}' end;
    return replace(
      p_text,
      'T' || v_match[1] || v_match[2],
      'T' || v_month_token || '{yyyy}'
    );
  end if;

  return null;
end;
$$;

-- Áp placeholder kỳ vào notes_pattern.
create or replace function public.expense_apply_period_pattern(p_pattern text, p_period date)
returns text
language sql
stable
as $$
  select replace(
    replace(
      replace(
        replace(coalesce(p_pattern, ''), '{yyyy}', to_char(p_period, 'YYYY')),
        '{yy}', to_char(p_period, 'YY')
      ),
      '{mm}', to_char(p_period, 'MM')
    ),
    '{m}', to_char(p_period, 'FMmm')
  );
$$;

-- Đổi ngày 6 chữ số trong tiêu đề thành {ddmmyy}; không đụng dãy số dài hơn.
create or replace function public.expense_title_pattern(p_title text)
returns text
language plpgsql
immutable
as $$
declare
  v_match text[];
  v_token text;
  v_day integer;
  v_month integer;
begin
  if p_title is null or btrim(p_title) = '' then
    return null;
  end if;

  v_match := regexp_match(p_title, '(^|[^0-9])([0-9]{6})([^0-9]|$)');
  if v_match is null then
    return null;
  end if;

  v_token := v_match[2];
  v_day := substr(v_token, 1, 2)::integer;
  v_month := substr(v_token, 3, 2)::integer;
  if v_day not between 1 and 31 or v_month not between 1 and 12 then
    return null;
  end if;

  return replace(p_title, v_token, '{ddmmyy}');
end;
$$;

-- Chuẩn hóa tên NCC: bỏ dấu, bỏ CÔNG TY/CTY/TNHH/CP/CỔ PHẦN, bỏ ký tự lạ.
create or replace function public.expense_normalize_supplier_name(p_name text)
returns text
language sql
stable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(extensions.unaccent(coalesce(p_name, ''))),
          '\m(cong ty|cty|tnhh|mtv|cp|co phan|tap doan|chi nhanh)\M', ' ', 'gi'
        ),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

-- Chuẩn hóa nhãn thành khóa khuôn: bỏ dấu, bỏ từ chung đầu nhãn, gộp khoảng trắng.
create or replace function public.expense_normalize_label(p_label text)
returns text
language sql
stable
as $$
  select coalesce(
    nullif(
      btrim(
        regexp_replace(
          regexp_replace(
            lower(extensions.unaccent(coalesce(p_label, ''))),
            '^((tien|chi phi|cuoc|thanh toan)\s*)+', '', 'i'
          ),
          '\s+', ' ', 'g'
        )
      ),
      ''
    ),
    'chi phi'
  );
$$;

-- Đọc kỳ dạng text của hóa đơn; không có thì lấy tháng trước invoice_date.
create or replace function public.expense_parse_period_text(p_period text, p_invoice_date date)
returns date
language plpgsql
stable
as $$
declare
  v text := btrim(coalesce(p_period, ''));
  v_month integer;
  v_year integer;
begin
  if v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return make_date(split_part(v, '-', 1)::integer,
                     split_part(v, '-', 2)::integer,
                     split_part(v, '-', 3)::integer);
  elsif v ~ '^[0-9]{4}-[0-9]{1,2}$' then
    v_year := split_part(v, '-', 1)::integer;
    v_month := split_part(v, '-', 2)::integer;
  elsif v ~ '^[0-9]{1,2}/[0-9]{4}$' then
    v_month := split_part(v, '/', 1)::integer;
    v_year := split_part(v, '/', 2)::integer;
  elsif v ~ '^[0-9]{1,2}/[0-9]{2}$' then
    v_month := split_part(v, '/', 1)::integer;
    v_year := 2000 + split_part(v, '/', 2)::integer;
  elsif v ~ '^[0-9]{6}$' then
    v_year := substr(v, 1, 4)::integer;
    v_month := substr(v, 5, 2)::integer;
  end if;

  if v_month between 1 and 12 and v_year between 2000 and 2099 then
    return make_date(v_year, v_month, 1);
  end if;

  return (date_trunc('month', coalesce(p_invoice_date, current_date)) - interval '1 month')::date;
end;
$$;

-- Base36 giống Date.now().toString(36) mà app đang dùng cho request_number.
create or replace function public.expense_base36(p_value bigint)
returns text
language plpgsql
immutable
as $$
declare
  v_value bigint := p_value;
  v_digit integer;
  v_out text := '';
begin
  if v_value is null or v_value = 0 then
    return '0';
  end if;
  while v_value > 0 loop
    v_digit := (v_value % 36)::integer;
    v_out := substr('0123456789abcdefghijklmnopqrstuvwxyz', v_digit + 1, 1) || v_out;
    v_value := v_value / 36;
  end loop;
  return v_out;
end;
$$;

-- Cùng định dạng PR-<base36 epoch ms> với useCreatePaymentRequest, có kiểm trùng.
create or replace function public.expense_next_request_number()
returns text
language plpgsql
volatile
as $$
declare
  v_candidate text;
  v_try integer := 0;
begin
  loop
    v_candidate := 'PR-' || upper(public.expense_base36(
      (floor(extract(epoch from clock_timestamp()) * 1000)::bigint) + v_try
    ));
    exit when not exists (
      select 1 from public.payment_requests where request_number = v_candidate
    );
    v_try := v_try + 1;
    if v_try > 100 then
      v_candidate := v_candidate || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
      exit;
    end if;
  end loop;
  return v_candidate;
end;
$$;

-- ===========================================================================
-- 6. Nguồn học dùng chung
-- ===========================================================================

create or replace function public.expense_learning_candidates()
returns table (
  id uuid,
  supplier_id uuid,
  title text,
  notes text,
  total_amount numeric,
  vat_amount numeric,
  requires_receipt boolean,
  payment_method public.payment_method_type,
  created_at timestamptz,
  period date,
  label text,
  key text,
  is_goods_supplier boolean
)
language sql
stable
as $$
  with goods_suppliers as (
    select distinct pr.supplier_id
    from public.payment_requests pr
    where pr.supplier_id is not null
      and pr.purchase_order_id is not null
  ),
  base as (
    select
      pr.id,
      pr.supplier_id,
      pr.title,
      pr.notes,
      pr.total_amount::numeric as total_amount,
      pr.vat_amount::numeric as vat_amount,
      pr.requires_receipt,
      pr.payment_method,
      pr.created_at,
      coalesce(
        public.expense_period_from_text(pr.notes),
        public.expense_period_from_text(pr.title),
        public.expense_period_from_text(pi.product_name),
        date_trunc('month', pr.created_at at time zone 'Asia/Ho_Chi_Minh')::date
      ) as period,
      coalesce(
        nullif(public.expense_strip_period(pr.notes), ''),
        nullif(public.expense_strip_period(pi.product_name), ''),
        nullif(
          public.expense_strip_period(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  coalesce(pr.title, ''),
                  '^(Đề nghị chi|Đề nghị thanh toán|DNTT)\s*[-:]?\s*', '', 'i'
                ),
                '-', ' ', 'g'
              ),
              '[^[:space:]]*[0-9]{3,}[^[:space:]]*', ' ', 'g'
            )
          ),
          ''
        ),
        'Chi phí'
      ) as label,
      exists (
        select 1 from goods_suppliers gs where gs.supplier_id = pr.supplier_id
      ) as is_goods_supplier
    from public.payment_requests pr
    left join lateral (
      select pri.product_name
      from public.payment_request_items pri
      where pri.payment_request_id = pr.id
      order by pri.created_at, pri.id
      limit 1
    ) pi on true
    where pr.supplier_id is not null
      and pr.purchase_order_id is null
      and (pr.payment_method is null or pr.payment_method <> 'cash'::public.payment_method_type)
      and pr.status <> 'rejected'::public.payment_request_status
      and coalesce(pr.notes, '') not ilike 'Tự động tạo cùng PO%'
      and not (
        (pr.notes is null or btrim(pr.notes) = '')
        and pr.requires_receipt = true
        and exists (
          select 1 from goods_suppliers gs where gs.supplier_id = pr.supplier_id
        )
      )
  )
  select
    b.id,
    b.supplier_id,
    b.title,
    b.notes,
    b.total_amount,
    b.vat_amount,
    b.requires_receipt,
    b.payment_method,
    b.created_at,
    b.period,
    b.label,
    b.supplier_id::text || ':' || public.expense_normalize_label(b.label) as key,
    b.is_goods_supplier
  from base b;
$$;

-- ===========================================================================
-- 7. Học khuôn chi
-- ===========================================================================

create or replace function public.learn_expense_templates()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_row record;
  v_latest record;
  v_items jsonb;
  v_category text;
  v_count integer;
  v_median numeric;
  v_min numeric;
  v_max numeric;
  v_typical numeric;
  v_cv numeric;
  v_vat_rate numeric;
  v_rejected integer;
  v_confidence numeric;
  v_cadence text;
  v_active boolean;
  v_label text;
  v_key text;
  v_periods date[];
  v_monthly_gaps integer;
  v_day_gaps integer;
  v_current_supplier uuid;
  v_supplier_monthly boolean;
  v_supplier_active_keys integer;
  v_supplier_has_multi_period boolean;
  v_supplier_latest_key text;
  v_supplier_count integer;
  v_supplier_month_count integer;
  v_period_gap_median numeric;
  v_day_gap_median numeric;
  v_updated integer := 0;
  v_deactivated integer := 0;
begin
  if not (v_is_service or public.has_role(v_actor, 'owner'::public.app_role)) then
    raise exception 'not_authorized_expense_template_learning' using errcode = '42501';
  end if;

  for v_row in
    select
      c.supplier_id,
      c.key,
      count(*)::integer as sample_count
    from public.expense_learning_candidates() c
    group by c.supplier_id, c.key
    order by c.supplier_id, c.key
  loop
    v_key := v_row.key;

    select c.*
      into v_latest
    from public.expense_learning_candidates() c
    left join (
      select f.payment_request_id, max(f.created_at) as edited_at
      from public.expense_template_feedback f
      where f.kind = 'edited'
      group by f.payment_request_id
    ) edited on edited.payment_request_id = c.id
    where c.key = v_key
    order by coalesce(edited.edited_at, c.created_at) desc, c.created_at desc
    limit 1;

    if v_latest.id is null then
      continue;
    end if;

    v_label := btrim(regexp_replace(v_latest.label, '\s+', ' ', 'g'));

    -- Nhịp định kỳ tính ở mức NCC trước, rồi mới áp xuống khuôn.
    if v_current_supplier is distinct from v_row.supplier_id then
      v_current_supplier := v_row.supplier_id;
      v_supplier_monthly := false;
      v_supplier_active_keys := 0;
      v_supplier_has_multi_period := false;
      v_supplier_latest_key := null;
      v_supplier_count := 0;
      v_supplier_month_count := 0;
      v_period_gap_median := null;
      v_day_gap_median := null;

      select
        count(*)::integer,
        count(distinct date_trunc('month', c.created_at at time zone 'Asia/Ho_Chi_Minh')::date)::integer
        into v_supplier_count, v_supplier_month_count
      from public.expense_learning_candidates() c
      where c.supplier_id = v_row.supplier_id
        and c.created_at >= now() - interval '180 days';

      if v_supplier_count >= 3 and v_supplier_month_count >= 3 then
        select percentile_cont(0.5) within group (order by gaps.gap)
          into v_period_gap_median
        from (
          select
            (extract(year from p)::integer * 12 + extract(month from p)::integer)
            - lag(extract(year from p)::integer * 12 + extract(month from p)::integer)
              over (order by p) as gap
          from (
            select distinct c.period as p
            from public.expense_learning_candidates() c
            where c.supplier_id = v_row.supplier_id
              and c.created_at >= now() - interval '180 days'
          ) periods
        ) gaps
        where gaps.gap is not null;

        select percentile_cont(0.5) within group (order by gaps.gap_days)
          into v_day_gap_median
        from (
          select
            extract(epoch from (
              c.created_at - lag(c.created_at) over (order by c.created_at)
            )) / 86400 as gap_days
          from public.expense_learning_candidates() c
          where c.supplier_id = v_row.supplier_id
            and c.created_at >= now() - interval '180 days'
        ) gaps
        where gaps.gap_days is not null;

        v_supplier_monthly := coalesce(v_period_gap_median = 1, false)
          or coalesce(v_day_gap_median between 25 and 40, false);
      end if;

      select count(*)::integer
        into v_supplier_active_keys
      from (
        select c.key
        from public.expense_learning_candidates() c
        where c.supplier_id = v_row.supplier_id
        group by c.key
        having max(c.created_at) >= now() - interval '180 days'
      ) active_keys;

      select exists (
        select 1
        from (
          select c.key
          from public.expense_learning_candidates() c
          where c.supplier_id = v_row.supplier_id
          group by c.key
          having max(c.created_at) >= now() - interval '180 days'
             and count(distinct c.period) >= 2
        ) multi_period_keys
      )
        into v_supplier_has_multi_period;

      select c.key
        into v_supplier_latest_key
      from public.expense_learning_candidates() c
      where c.supplier_id = v_row.supplier_id
      group by c.key
      having max(c.created_at) >= now() - interval '180 days'
      order by max(c.created_at) desc
      limit 1;
    end if;

    select
      count(*)::integer,
      percentile_cont(0.5) within group (order by c.total_amount),
      min(c.total_amount),
      max(c.total_amount),
      percentile_cont(0.5) within group (
        order by extract(day from (c.created_at at time zone 'Asia/Ho_Chi_Minh'))
      )
      into v_count, v_median, v_min, v_max, v_typical
    from public.expense_learning_candidates() c
    where c.key = v_key;

    select coalesce(stddev_samp(c.total_amount) / nullif(avg(c.total_amount), 0), 0)
      into v_cv
    from public.expense_learning_candidates() c
    where c.key = v_key;

    select array_agg(distinct c.period order by c.period)
      into v_periods
    from public.expense_learning_candidates() c
    where c.key = v_key;

    v_cadence := 'irregular';
    v_monthly_gaps := 0;
    if v_count >= 2 and array_length(v_periods, 1) >= 2 then
      select count(*)
        into v_monthly_gaps
      from (
        select
          (extract(year from p)::integer * 12 + extract(month from p)::integer)
          - lag(extract(year from p)::integer * 12 + extract(month from p)::integer)
            over (order by p) as gap
        from unnest(v_periods) as p
      ) gaps
      where gaps.gap = 1;

      if v_monthly_gaps >= ceil((array_length(v_periods, 1) - 1) * 0.6) then
        v_cadence := 'monthly';
      end if;
    end if;

    -- Chấp nhận nhịp 25–40 ngày giữa các lần lập, kể cả khi kỳ ghi chú
    -- không đổi (ví dụ hai phiếu cùng kỳ nhưng lập cách nhau một tháng).
    if v_cadence <> 'monthly' and v_count >= 2 then
      select count(*)
        into v_day_gaps
      from (
        select c.created_at - lag(c.created_at) over (order by c.created_at) as gap
        from public.expense_learning_candidates() c
        where c.key = v_key
      ) gaps
      where gaps.gap between interval '25 days' and interval '40 days';

      if v_day_gaps >= ceil((v_count - 1) * 0.6) then
        v_cadence := 'monthly';
      end if;
    end if;

    -- Khuôn thuộc NCC có nhịp tháng: một khuôn duy nhất thì chính nó là
    -- monthly; nhiều khuôn thì khuôn có ≥ 2 kỳ mới là monthly.
    if v_supplier_monthly then
      if v_supplier_active_keys <= 1 then
        v_cadence := 'monthly';
      elsif coalesce(array_length(v_periods, 1), 0) >= 2 then
        v_cadence := 'monthly';
      elsif not v_supplier_has_multi_period
             and v_key = v_supplier_latest_key
             and v_latest.created_at >= now() - interval '180 days' then
        -- NCC đều tháng nhưng các khuôn mới chỉ có một mẫu: giữ khuôn đại
        -- diện mới nhất ở nhịp tháng để chuông còn nhắc khoản lặp lại.
        v_cadence := 'monthly';
      end if;
    end if;

    v_vat_rate := 0;
    if coalesce(v_latest.total_amount, 0) > 0
       and coalesce(v_latest.vat_amount, 0) >= 0
       and coalesce(v_latest.total_amount, 0) - coalesce(v_latest.vat_amount, 0) > 0 then
      v_vat_rate := round(
        coalesce(v_latest.vat_amount, 0)
        / (coalesce(v_latest.total_amount, 0) - coalesce(v_latest.vat_amount, 0)),
        4
      );
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', coalesce(nullif(btrim(pri.product_name), ''), 'Chi phí'),
          'unit', coalesce(nullif(btrim(pri.unit), ''), 'tháng'),
          'quantity', coalesce(pri.quantity, 1),
          'line_total', coalesce(pri.line_total, pri.quantity * pri.unit_price, 0),
          'vat_rate', coalesce(v_vat_rate, 0)
        )
        order by pri.created_at, pri.id
      ),
      '[]'::jsonb
    )
      into v_items
    from public.payment_request_items pri
    where pri.payment_request_id = v_latest.id;

    select pri.cost_category_code
      into v_category
    from public.payment_request_items pri
    where pri.payment_request_id = v_latest.id
      and pri.cost_category_code is not null
    order by pri.created_at
    limit 1;

    select count(*)
      into v_rejected
    from public.expense_template_feedback f
    join public.expense_templates t on t.id = f.template_id
    where t.key = v_key
      and f.kind = 'rejected'
      and f.created_at >= now() - interval '180 days';

    v_confidence := 0.30
      + least(v_count, 5) * 0.10
      + 0.25 * greatest(0, 1 - least(coalesce(v_cv, 0), 1));
    v_confidence := least(0.99, greatest(0.05, v_confidence - 0.15 * coalesce(v_rejected, 0)));
    v_active := coalesce(v_latest.created_at >= now() - interval '180 days', false);

    -- NCC hàng hóa: khuôn một lần không dùng để tự ghép hóa đơn; vẫn lưu
    -- nhưng chỉ khuôn monthly còn active.
    if coalesce(v_latest.is_goods_supplier, false) and v_cadence <> 'monthly' then
      v_active := false;
    end if;

    insert into public.expense_templates (
      supplier_id,
      key,
      label,
      cadence,
      typical_day,
      amount_median,
      amount_min,
      amount_max,
      sample_count,
      last_request_id,
      last_period,
      title_pattern,
      notes_pattern,
      items_template,
      requires_receipt,
      payment_method,
      cost_category_code,
      confidence,
      active,
      goods_supplier,
      updated_at
    )
    values (
      v_row.supplier_id,
      v_key,
      v_label,
      v_cadence,
      case when v_typical is null then null else greatest(1, least(31, round(v_typical)::integer)) end,
      v_median,
      v_min,
      v_max,
      v_count,
      v_latest.id,
      to_char(v_latest.period, 'YYYY-MM'),
      public.expense_title_pattern(v_latest.title),
      coalesce(public.expense_notes_pattern(v_latest.notes), v_label),
      v_items,
      coalesce(v_latest.requires_receipt, true),
      coalesce(v_latest.payment_method, 'bank_transfer'::public.payment_method_type),
      v_category,
      v_confidence,
      v_active,
      coalesce(v_latest.is_goods_supplier, false),
      now()
    )
    on conflict (key) do update set
      supplier_id = excluded.supplier_id,
      label = excluded.label,
      cadence = excluded.cadence,
      typical_day = excluded.typical_day,
      amount_median = excluded.amount_median,
      amount_min = excluded.amount_min,
      amount_max = excluded.amount_max,
      sample_count = excluded.sample_count,
      last_request_id = excluded.last_request_id,
      last_period = excluded.last_period,
      title_pattern = excluded.title_pattern,
      notes_pattern = excluded.notes_pattern,
      items_template = excluded.items_template,
      requires_receipt = excluded.requires_receipt,
      payment_method = excluded.payment_method,
      cost_category_code = excluded.cost_category_code,
      confidence = excluded.confidence,
      active = excluded.active,
      goods_supplier = excluded.goods_supplier,
      updated_at = now();

    v_updated := v_updated + 1;
  end loop;

  -- Không xóa khuôn cũ; chỉ tắt khi không còn phiếu mẫu trong 180 ngày.
  update public.expense_templates t
     set active = false,
         updated_at = now()
   where t.active = true
     and not exists (
       select 1
       from public.expense_learning_candidates() c
       where c.key = t.key
         and c.created_at >= now() - interval '180 days'
     );
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object(
    'status', 'learned',
    'templates_upserted', v_updated,
    'templates_deactivated', v_deactivated,
    'ran_at', now()
  );
end;
$$;

-- ===========================================================================
-- 8. Ghép hóa đơn đầu vào với NCC + khuôn
-- ===========================================================================

create or replace function public.match_incoming_invoice(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_inv public.incoming_invoices%rowtype;
  v_supplier uuid;
  v_supplier_source text := 'none';
  v_supplier_confidence numeric := 0;
  v_template uuid;
  v_template_count integer := 0;
  v_best_diff numeric;
  v_best_ratio numeric;
  v_second_diff numeric;
  v_second_ratio numeric;
  v_tax_column text;
  v_name_norm text;
  v_match_source text := 'none';
  v_match_confidence numeric := 0;
  v_status text;
  v_goods_recent boolean := false;
  v_amount_match boolean := false;
begin
  if not (v_is_service or public.has_role(v_actor, 'owner'::public.app_role)) then
    raise exception 'not_authorized_invoice_match' using errcode = '42501';
  end if;

  select * into v_inv
  from public.incoming_invoices
  where id = p_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  if v_inv.payment_request_id is not null then
    return jsonb_build_object(
      'status', v_inv.status,
      'payment_request_id', v_inv.payment_request_id,
      'already_linked', true
    );
  end if;

  -- 8.1. MST NCC nếu bảng suppliers có cột mã số thuế (hiện tại production chưa có).
  select column_name
    into v_tax_column
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'suppliers'
    and column_name in ('tax_code', 'tax_id', 'mst', 'ma_so_thue')
  order by case column_name
    when 'tax_code' then 0
    when 'tax_id' then 1
    when 'mst' then 2
    else 3
  end
  limit 1;

  if v_tax_column is not null
     and nullif(btrim(coalesce(v_inv.seller_tax_code, '')), '') is not null then
    execute format(
      'select s.id from public.suppliers s
       where upper(btrim((s.%I)::text)) = upper(btrim($1))
       order by s.created_at
       limit 1',
      v_tax_column
    )
    into v_supplier
    using v_inv.seller_tax_code;

    if v_supplier is not null then
      v_supplier_source := 'tax_code';
      v_supplier_confidence := 0.95;
    end if;
  end if;

  -- 8.2. Tên NCC đã chuẩn hóa: khớp chính xác trước, rồi mới đến chứa nhau.
  if v_supplier is null then
    v_name_norm := public.expense_normalize_supplier_name(v_inv.seller_name);
    if v_name_norm <> '' then
      select s.id
        into v_supplier
      from public.suppliers s
      where public.expense_normalize_supplier_name(s.name) = v_name_norm
      order by s.created_at
      limit 1;

      if v_supplier is not null then
        v_supplier_source := 'name';
        v_supplier_confidence := 0.85;
      else
        select s.id
          into v_supplier
        from public.suppliers s
        where public.expense_normalize_supplier_name(s.name) like '%' || v_name_norm || '%'
           or v_name_norm like '%' || public.expense_normalize_supplier_name(s.name) || '%'
        order by
          abs(length(public.expense_normalize_supplier_name(s.name)) - length(v_name_norm)),
          s.created_at
        limit 1;

        if v_supplier is not null then
          v_supplier_source := 'name_fuzzy';
          v_supplier_confidence := 0.70;
        end if;
      end if;
    end if;
  end if;

  -- 8.2b. NCC hàng hóa có PO gần đây nhưng hóa đơn không khớp khuôn nào
  -- trong ±50% median thì để chủ tự ghép vào phiếu theo PO.
  if v_supplier is not null then
    select exists (
      select 1
      from public.payment_requests pr
      where pr.supplier_id = v_supplier
        and pr.purchase_order_id is not null
        and pr.created_at >= now() - interval '120 days'
    )
      into v_goods_recent;

    if v_goods_recent then
      select exists (
        select 1
        from public.expense_templates t
        where t.supplier_id = v_supplier
          and t.active = true
          and coalesce(t.amount_median, 0) > 0
          and v_inv.total_amount is not null
          and abs(v_inv.total_amount - t.amount_median) <= 0.5 * t.amount_median
      )
        into v_amount_match;

      if not v_amount_match then
        v_template := null;
        v_match_source := 'goods_supplier_po';
        v_match_confidence := 0.50;
      end if;
    end if;
  end if;

  -- 8.3. Chọn khuôn của NCC.
  if v_supplier is not null and v_match_source <> 'goods_supplier_po' then
    select count(*)::integer
      into v_template_count
    from public.expense_templates t
    where t.supplier_id = v_supplier
      and t.active = true;

    if v_template_count = 1 then
      select t.id
        into v_template
      from public.expense_templates t
      where t.supplier_id = v_supplier
        and t.active = true
      limit 1;
      v_match_source := v_supplier_source;
      v_match_confidence := least(0.99, v_supplier_confidence + 0.05);
    elsif v_template_count > 1 then
      select
        t.id,
        abs(coalesce(t.amount_median, 0) - coalesce(v_inv.total_amount, 0)) as diff
        into v_template, v_best_diff
      from public.expense_templates t
      where t.supplier_id = v_supplier
        and t.active = true
      order by diff, t.updated_at desc
      limit 1;

      select abs(coalesce(t.amount_median, 0) - coalesce(v_inv.total_amount, 0))
        into v_second_diff
      from public.expense_templates t
      where t.supplier_id = v_supplier
        and t.active = true
      order by abs(coalesce(t.amount_median, 0) - coalesce(v_inv.total_amount, 0)), t.updated_at desc
      offset 1
      limit 1;

      v_best_ratio := coalesce(v_best_diff, 0) / greatest(coalesce(v_inv.total_amount, 0), 1);
      v_second_ratio := case
        when v_second_diff is null then null
        else v_second_diff / greatest(coalesce(v_inv.total_amount, 0), 1)
      end;

      if v_best_ratio <= 0.5
         and (v_second_ratio is null or v_second_ratio > v_best_ratio * 1.5 + 0.05) then
        v_match_source := 'amount';
        v_match_confidence := 0.80;
      else
        v_template := null;
        v_match_source := 'amount_ambiguous';
        v_match_confidence := 0.40;
      end if;
    else
      v_template := null;
      v_match_source := v_supplier_source;
      v_match_confidence := v_supplier_confidence;
    end if;
  end if;

  v_status := case when v_template is not null then 'matched' else 'needs_review' end;

  update public.incoming_invoices
     set supplier_id = v_supplier,
         template_id = v_template,
         match_source = v_match_source,
         match_confidence = v_match_confidence,
         status = v_status,
         note = case
           when v_match_source = 'goods_supplier_po'
             then 'NCC hàng hóa có đơn mua hàng — ghép vào phiếu theo PO'
           else note
         end
   where id = p_id;

  return jsonb_build_object(
    'status', v_status,
    'supplier_id', v_supplier,
    'template_id', v_template,
    'match_source', v_match_source,
    'match_confidence', v_match_confidence
  );
end;
$$;

-- ===========================================================================
-- 9. Tự lập đề nghị chi Chờ duyệt từ hóa đơn đã ghép
-- ===========================================================================

create or replace function public.create_payment_request_from_invoice(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_inv public.incoming_invoices%rowtype;
  v_template public.expense_templates%rowtype;
  v_existing public.payment_requests%rowtype;
  v_owner uuid;
  v_created_by uuid;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_period date;
  v_title text;
  v_notes text;
  v_source_label text;
  v_total numeric;
  v_vat numeric;
  v_subtotal numeric;
  v_request_number text;
  v_pr_id uuid;
  v_item jsonb;
  v_items jsonb;
  v_item_count integer;
  v_index integer;
  v_line_total numeric;
  v_allocated numeric := 0;
  v_weight numeric;
  v_weight_sum numeric := 0;
  v_equal_weights boolean := false;
  v_qty numeric;
  v_unit_price numeric;
  v_category text;
  v_no_receipt_reason text;
  v_no_receipt_set_by uuid;
  v_no_receipt_set_at timestamptz;
  v_warning text;
begin
  if not (v_is_service or public.has_role(v_actor, 'owner'::public.app_role)) then
    raise exception 'not_authorized_invoice_payment_request' using errcode = '42501';
  end if;

  select * into v_inv
  from public.incoming_invoices
  where id = p_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: hóa đơn đã có phiếu thì trả lại đúng phiếu cũ.
  if v_inv.payment_request_id is not null then
    select * into v_existing
    from public.payment_requests
    where id = v_inv.payment_request_id;
    return jsonb_build_object(
      'payment_request_id', v_existing.id,
      'request_number', v_existing.request_number,
      'status', v_existing.status,
      'created', false,
      'already_linked', true
    );
  end if;

  if v_inv.match_source = 'goods_supplier_po' then
    raise exception 'goods_supplier_needs_po_match' using errcode = 'P0001';
  end if;

  if v_inv.status <> 'matched' or v_inv.template_id is null then
    raise exception 'incoming_invoice_not_matched' using errcode = 'P0001';
  end if;

  select * into v_template
  from public.expense_templates
  where id = v_inv.template_id;

  if not found then
    raise exception 'expense_template_not_found' using errcode = 'P0002';
  end if;

  v_created_by := coalesce(
    v_actor,
    (select ur.user_id from public.user_roles ur where ur.role = 'owner'::public.app_role
      order by ur.created_at limit 1)
  );
  if v_created_by is null then
    raise exception 'owner_not_found' using errcode = 'P0002';
  end if;

  v_period := public.expense_parse_period_text(v_inv.period, v_inv.invoice_date);

  if nullif(btrim(coalesce(v_template.title_pattern, '')), '') is not null then
    v_title := replace(v_template.title_pattern, '{ddmmyy}', to_char(v_today, 'DDMMYY'));
  else
    v_title := 'Đề nghị chi - ' || coalesce(
      nullif(btrim(coalesce(v_inv.invoice_number, '')), ''),
      nullif(btrim(coalesce(v_inv.source_ref, '')), ''),
      'hóa đơn'
    );
  end if;

  v_notes := nullif(
    btrim(public.expense_apply_period_pattern(v_template.notes_pattern, v_period)),
    ''
  );
  if v_notes is null then
    v_notes := nullif(btrim(v_template.label), '');
  end if;
  if v_notes is null then
    v_notes := 'Chi phí';
  end if;
  -- Khuôn cũ có thể không chứa kỳ; vẫn phải ghi rõ kỳ của hóa đơn.
  if v_template.notes_pattern is null
     or (
       v_template.notes_pattern not like '%{m}%'
       and v_template.notes_pattern not like '%{mm}%'
     ) then
    v_notes := v_notes || ' T' || to_char(v_period, 'MM/YYYY');
  end if;

  v_source_label := case v_inv.source
    when 'email' then 'email'
    when 'supplier_link' then 'link NCC'
    else 'nhập tay'
  end;

  v_notes := v_notes || E'\n' || 'Tự lập từ hóa đơn '
    || coalesce(
      nullif(btrim(coalesce(v_inv.invoice_number, '')), ''),
      nullif(btrim(coalesce(v_inv.source_ref, '')), ''),
      '?'
    )
    || ' (' || v_source_label || ')';

  v_vat := coalesce(v_inv.vat_amount, 0);
  v_total := coalesce(
    v_inv.total_amount,
    coalesce(v_inv.subtotal, 0) + v_vat,
    v_template.amount_median,
    0
  );
  v_subtotal := coalesce(v_inv.subtotal, v_total - v_vat);
  if v_subtotal < 0 then
    v_subtotal := v_total;
  end if;

  if coalesce(v_template.amount_median, 0) > 0
     and abs(v_total - v_template.amount_median) > 0.5 * v_template.amount_median then
    v_warning := 'Cảnh báo: số tiền khác thường lệ (thường ~'
      || round(v_template.amount_median)::bigint::text || ')';
    v_notes := v_notes || E'\n' || v_warning;
  end if;

  if v_template.requires_receipt = false then
    v_no_receipt_reason := 'Hóa đơn điện tử đính kèm';
    v_no_receipt_set_by := v_created_by;
    v_no_receipt_set_at := now();
  end if;

  -- Tránh trùng request_number khi nhiều hóa đơn được tạo cùng lúc.
  perform pg_advisory_xact_lock(hashtext('expense_auto_payment_request_number'));
  v_request_number := public.expense_next_request_number();

  insert into public.payment_requests (
    request_number,
    title,
    description,
    supplier_id,
    total_amount,
    vat_amount,
    status,
    payment_status,
    payment_method,
    payment_type,
    requires_receipt,
    no_receipt_reason,
    no_receipt_set_by,
    no_receipt_set_at,
    image_url,
    notes,
    created_by
  )
  values (
    v_request_number,
    v_title,
    null,
    coalesce(v_inv.supplier_id, v_template.supplier_id),
    v_total,
    v_vat,
    'pending'::public.payment_request_status,
    'unpaid'::public.payment_status,
    coalesce(v_template.payment_method, 'bank_transfer'::public.payment_method_type),
    'old_order'::public.payment_type,
    coalesce(v_template.requires_receipt, true),
    v_no_receipt_reason,
    v_no_receipt_set_by,
    v_no_receipt_set_at,
    v_inv.file_path,
    v_notes,
    v_created_by
  )
  returning id into v_pr_id;

  v_items := case
    when jsonb_typeof(coalesce(v_template.items_template, '[]'::jsonb)) = 'array'
      then coalesce(v_template.items_template, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_item_count := jsonb_array_length(v_items);

  if v_item_count = 0 then
    insert into public.payment_request_items (
      payment_request_id,
      product_name,
      quantity,
      unit,
      unit_price,
      line_total,
      cost_category_code
    )
    values (
      v_pr_id,
      coalesce(nullif(btrim(v_template.label), ''), 'Chi phí'),
      1,
      'tháng',
      v_subtotal,
      v_subtotal,
      v_template.cost_category_code
    );
  else
    select sum(coalesce((item->>'line_total')::numeric, 0))
      into v_weight_sum
    from jsonb_array_elements(v_items) as item;

    if coalesce(v_weight_sum, 0) <= 0 then
      v_equal_weights := true;
      v_weight_sum := v_item_count;
    end if;

    for v_index in 0 .. v_item_count - 1 loop
      v_item := v_items->v_index;
      if v_equal_weights then
        v_weight := 1;
      else
        v_weight := coalesce((v_item->>'line_total')::numeric, 0);
      end if;

      if v_index = v_item_count - 1 then
        v_line_total := v_subtotal - v_allocated;
      else
        v_line_total := round(v_subtotal * v_weight / v_weight_sum, 0);
      end if;
      v_allocated := v_allocated + v_line_total;

      v_qty := coalesce((v_item->>'quantity')::numeric, 1);
      if v_qty <= 0 then
        v_qty := 1;
      end if;
      v_unit_price := round(v_line_total / v_qty, 2);
      v_category := coalesce(
        nullif(v_item->>'cost_category_code', ''),
        v_template.cost_category_code
      );

      insert into public.payment_request_items (
        payment_request_id,
        product_name,
        quantity,
        unit,
        unit_price,
        line_total,
        cost_category_code
      )
      values (
        v_pr_id,
        coalesce(nullif(btrim(v_item->>'name'), ''), nullif(btrim(v_template.label), ''), 'Chi phí'),
        v_qty,
        coalesce(nullif(btrim(v_item->>'unit'), ''), 'tháng'),
        v_unit_price,
        v_line_total,
        v_category
      );
    end loop;
  end if;

  if nullif(btrim(coalesce(v_inv.file_path, '')), '') is not null then
    insert into public.payment_request_attachments (
      payment_request_id,
      storage_path,
      file_name,
      mime_type,
      uploaded_by
    )
    values (
      v_pr_id,
      v_inv.file_path,
      regexp_replace(v_inv.file_path, '^.*/', ''),
      v_inv.file_mime,
      v_created_by
    );
  end if;

  update public.incoming_invoices
     set status = 'pr_created',
         payment_request_id = v_pr_id
   where id = p_id;

  return jsonb_build_object(
    'payment_request_id', v_pr_id,
    'request_number', v_request_number,
    'title', v_title,
    'notes', v_notes,
    'total_amount', v_total,
    'vat_amount', v_vat,
    'status', 'pending',
    'created', true,
    'warning', v_warning
  );
end;
$$;

-- ===========================================================================
-- 10. Ghi phản hồi khi chủ sửa / từ chối / duyệt phiếu tự lập
-- ===========================================================================

create or replace function public.record_auto_payment_request_feedback()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template_id uuid;
begin
  select i.template_id
    into v_template_id
  from public.incoming_invoices i
  where i.payment_request_id = new.id
  limit 1;

  if not found then
    return new;
  end if;

  if new.status = 'rejected' and old.status is distinct from new.status then
    insert into public.expense_template_feedback (
      template_id, payment_request_id, kind, before, after
    )
    values (
      v_template_id,
      new.id,
      'rejected',
      jsonb_build_object(
        'status', old.status,
        'title', old.title,
        'notes', old.notes,
        'total_amount', old.total_amount,
        'supplier_id', old.supplier_id
      ),
      jsonb_build_object(
        'status', new.status,
        'title', new.title,
        'notes', new.notes,
        'total_amount', new.total_amount,
        'supplier_id', new.supplier_id,
        'rejection_reason', new.rejection_reason
      )
    );
  elsif new.status = 'approved' and old.status is distinct from new.status then
    insert into public.expense_template_feedback (
      template_id, payment_request_id, kind, before, after
    )
    values (
      v_template_id,
      new.id,
      'approved',
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status)
    );
  elsif new.total_amount is distinct from old.total_amount
     or new.supplier_id is distinct from old.supplier_id
     or new.notes is distinct from old.notes
     or new.title is distinct from old.title then
    insert into public.expense_template_feedback (
      template_id, payment_request_id, kind, before, after
    )
    values (
      v_template_id,
      new.id,
      'edited',
      jsonb_build_object(
        'title', old.title,
        'notes', old.notes,
        'total_amount', old.total_amount,
        'supplier_id', old.supplier_id
      ),
      jsonb_build_object(
        'title', new.title,
        'notes', new.notes,
        'total_amount', new.total_amount,
        'supplier_id', new.supplier_id
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_record_auto_payment_request_feedback on public.payment_requests;
create trigger trg_record_auto_payment_request_feedback
after update on public.payment_requests
for each row
execute function public.record_auto_payment_request_feedback();

-- ===========================================================================
-- 11. Chuông thông báo khoản đến kỳ chưa có hóa đơn
-- ===========================================================================

create or replace function public.get_expense_due_notices()
returns table (
  label text,
  supplier_name text,
  period text,
  typical_day integer,
  amount_median numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_period_start date := (date_trunc('month', (now() at time zone 'Asia/Ho_Chi_Minh')::date) - interval '1 month')::date;
  v_period text := to_char(
    (date_trunc('month', (now() at time zone 'Asia/Ho_Chi_Minh')::date) - interval '1 month')::date,
    'YYYY-MM'
  );
begin
  if not (
    v_is_service
    or public.has_role(v_actor, 'owner'::public.app_role)
    or public.has_module_permission(v_actor, 'payment_requests', 'view')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'not_authorized_expense_due_notices' using errcode = '42501';
  end if;

  return query
  select
    t.label,
    s.name::text as supplier_name,
    v_period as period,
    t.typical_day,
    t.amount_median
  from public.expense_templates t
  join public.suppliers s on s.id = t.supplier_id
  where t.active = true
    and t.cadence = 'monthly'
    and t.typical_day is not null
    and v_today >= (
      date_trunc('month', v_today)::date
      + (
        least(
          t.typical_day,
          extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))::integer
        ) - 1
      )
      + 3
    )
    and (
      select max(c.created_at)
      from public.expense_learning_candidates() c
      where c.key = t.key
    ) >= now() - interval '75 days'
    and not exists (
      select 1
      from public.expense_learning_candidates() c
      where c.key = t.key
        and date_trunc('month', c.period)::date = v_period_start
    )
    and not exists (
      select 1
      from public.incoming_invoices i
      where i.supplier_id = t.supplier_id
        and i.status <> 'ignored'
        and public.expense_parse_period_text(i.period, i.invoice_date) = v_period_start
    )
    and (
      not exists (
        select 1
        from public.expense_learning_candidates() c
        where c.supplier_id = t.supplier_id
          and date_trunc('month', c.period)::date = v_period_start
      )
      or (
        select count(distinct c.period)
        from public.expense_learning_candidates() c
        where c.key = t.key
      ) >= 2
    )
  order by t.typical_day, s.name, t.label;
end;
$$;

create or replace function public.get_auto_payment_request_count()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_count integer;
begin
  if not (
    v_is_service
    or public.has_role(v_actor, 'owner'::public.app_role)
    or public.has_module_permission(v_actor, 'payment_requests', 'view')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'not_authorized_auto_payment_count' using errcode = '42501';
  end if;

  select count(*)::integer
    into v_count
  from public.payment_requests pr
  join public.incoming_invoices i on i.payment_request_id = pr.id
  where pr.status = 'pending'::public.payment_request_status;

  return coalesce(v_count, 0);
end;
$$;

-- ===========================================================================
-- 12. Cron hằng ngày 05:40 giờ VN (22:40 UTC)
-- ===========================================================================

create or replace function public.run_expense_template_learning_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  return public.learn_expense_templates();
end;
$$;

do $$
declare
  v_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for v_job_id in
      select jobid from cron.job where jobname = 'expense-template-learn-daily'
    loop
      perform cron.unschedule(v_job_id);
    end loop;

    perform cron.schedule(
      'expense-template-learn-daily',
      '40 22 * * *',
      $job$ select public.run_expense_template_learning_scheduled(); $job$
    );
  end if;
end;
$$;

-- ===========================================================================
-- 13. Quyền hàm
-- ===========================================================================

revoke all on function public.expense_strip_period(text) from public, anon, authenticated;
revoke all on function public.expense_period_from_text(text) from public, anon, authenticated;
revoke all on function public.expense_notes_pattern(text) from public, anon, authenticated;
revoke all on function public.expense_apply_period_pattern(text, date) from public, anon, authenticated;
revoke all on function public.expense_title_pattern(text) from public, anon, authenticated;
revoke all on function public.expense_normalize_supplier_name(text) from public, anon, authenticated;
revoke all on function public.expense_normalize_label(text) from public, anon, authenticated;
revoke all on function public.expense_parse_period_text(text, date) from public, anon, authenticated;
revoke all on function public.expense_base36(bigint) from public, anon, authenticated;
revoke all on function public.expense_next_request_number() from public, anon, authenticated;
revoke all on function public.expense_learning_candidates() from public, anon, authenticated;
grant execute on function public.expense_strip_period(text) to service_role;
grant execute on function public.expense_period_from_text(text) to service_role;
grant execute on function public.expense_notes_pattern(text) to service_role;
grant execute on function public.expense_apply_period_pattern(text, date) to service_role;
grant execute on function public.expense_title_pattern(text) to service_role;
grant execute on function public.expense_normalize_supplier_name(text) to service_role;
grant execute on function public.expense_normalize_label(text) to service_role;
grant execute on function public.expense_parse_period_text(text, date) to service_role;
grant execute on function public.expense_base36(bigint) to service_role;
grant execute on function public.expense_next_request_number() to service_role;
grant execute on function public.expense_learning_candidates() to service_role;

revoke all on function public.learn_expense_templates() from public, anon, authenticated;
revoke all on function public.match_incoming_invoice(uuid) from public, anon, authenticated;
revoke all on function public.create_payment_request_from_invoice(uuid) from public, anon, authenticated;
revoke all on function public.get_expense_due_notices() from public, anon, authenticated;
revoke all on function public.get_auto_payment_request_count() from public, anon, authenticated;
revoke all on function public.run_expense_template_learning_scheduled() from public, anon, authenticated;
revoke all on function public.record_auto_payment_request_feedback() from public, anon, authenticated;

grant execute on function public.learn_expense_templates() to authenticated, service_role;
grant execute on function public.match_incoming_invoice(uuid) to authenticated, service_role;
grant execute on function public.create_payment_request_from_invoice(uuid) to authenticated, service_role;
grant execute on function public.get_expense_due_notices() to authenticated, service_role;
grant execute on function public.get_auto_payment_request_count() to authenticated, service_role;
grant execute on function public.run_expense_template_learning_scheduled() to service_role;

-- ---------------------------------------------------------------------------
-- Smoke assertions
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
begin
  select ur.user_id
    into v_owner
  from public.user_roles ur
  where ur.role = 'owner'::public.app_role
  order by ur.created_at
  limit 1;

  if v_owner is null then
    raise exception 'SMOKE FAIL: no owner user';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
end $$;

do $$
declare
  v_result jsonb;
  v_missing text;
  v_active_count integer;
begin
  v_result := public.learn_expense_templates();

  if coalesce((v_result->>'templates_upserted')::integer, 0) < 4 then
    raise exception 'SMOKE FAIL: expected at least 4 learned templates, got %', v_result;
  end if;

  -- (a) NCC định kỳ phải có ít nhất một khuôn active cadence monthly.
  select string_agg(expected.name, ', ' order by expected.name)
    into v_missing
  from (
    values
      ('CTY ĐIỆN LỰC TÂN THUẬN_HCM'),
      ('Thiên An Sinh')
  ) as expected(name)
  where not exists (
    select 1
    from public.expense_templates t
    join public.suppliers s on s.id = t.supplier_id
    where s.name = expected.name
      and t.active = true
      and t.cadence = 'monthly'
  );

  if v_missing is not null then
    raise exception 'SMOKE FAIL: missing monthly active template for %', v_missing;
  end if;

  -- (b) NCC hàng hóa không được sinh khuôn active loại thường.
  select string_agg(distinct s.name, ', ' order by s.name)
    into v_missing
  from public.expense_templates t
  join public.suppliers s on s.id = t.supplier_id
  where s.name in ('Green Farm', 'Phúc Thịnh', 'Cholimex')
    and t.active = true
    and t.goods_supplier = false;

  if v_missing is not null then
    raise exception 'SMOKE FAIL: goods supplier has non-goods active template: %', v_missing;
  end if;

  select count(*)::integer
    into v_active_count
  from public.expense_templates
  where active = true;

  if v_active_count < 5 or v_active_count > 40 then
    raise exception 'SMOKE FAIL: active template count out of range 5..40: %', v_active_count;
  end if;

  raise notice 'SMOKE learn_expense_templates: %', v_result;
end $$;

-- (d) Hóa đơn NCC hàng hóa không khớp khuôn: cần ghép PO, không tự lập phiếu.
do $$
declare
  v_invoice_id uuid;
  v_match jsonb;
  v_raised boolean := false;
begin
  insert into public.incoming_invoices (
    source,
    source_ref,
    file_path,
    file_mime,
    seller_name,
    seller_tax_code,
    invoice_number,
    invoice_series,
    invoice_date,
    period,
    subtotal,
    vat_amount,
    total_amount,
    raw
  )
  values (
    'manual',
    'smoke-goods',
    'smoke/phuc-thinh-2026-10.pdf',
    'application/pdf',
    'CÔNG TY TNHH PHÚC THỊNH',
    null,
    'SMOKE-GOODS-001',
    'C26TAA',
    '2026-10-20',
    '2026-10',
    8310000,
    0,
    8310000,
    '{}'::jsonb
  )
  returning id into v_invoice_id;

  v_match := public.match_incoming_invoice(v_invoice_id);
  if v_match->>'status' <> 'needs_review' then
    raise exception 'SMOKE FAIL: goods invoice should need review, got %', v_match;
  end if;
  if v_match->>'match_source' <> 'goods_supplier_po' then
    raise exception 'SMOKE FAIL: goods invoice match_source %, expected goods_supplier_po', v_match->>'match_source';
  end if;
  if v_match->>'template_id' is not null then
    raise exception 'SMOKE FAIL: goods invoice must not be assigned a template: %', v_match;
  end if;
  if (
    select i.note
    from public.incoming_invoices i
    where i.id = v_invoice_id
  ) <> 'NCC hàng hóa có đơn mua hàng — ghép vào phiếu theo PO' then
    raise exception 'SMOKE FAIL: goods invoice note missing';
  end if;

  begin
    perform public.create_payment_request_from_invoice(v_invoice_id);
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'goods_supplier_needs_po_match' then
        raise;
      end if;
      v_raised := true;
  end;

  if not v_raised then
    raise exception 'SMOKE FAIL: goods invoice should refuse to create a payment request';
  end if;

  raise notice 'SMOKE goods invoice: %', v_match;
end $$;

do $$
declare
  v_invoice_id uuid;
  v_match jsonb;
  v_create jsonb;
  v_again jsonb;
  v_pr public.payment_requests%rowtype;
  v_count integer;
  v_green_template uuid;
begin
  insert into public.incoming_invoices (
    source,
    source_ref,
    file_path,
    file_mime,
    seller_name,
    seller_tax_code,
    invoice_number,
    invoice_series,
    invoice_date,
    period,
    subtotal,
    vat_amount,
    total_amount,
    raw
  )
  values (
    'manual',
    'smoke-1',
    'smoke/green-sm-2026-10.pdf',
    'application/pdf',
    'CÔNG TY TNHH GREEN SM',
    null,
    'SMOKE-001',
    'C26TAA',
    '2026-10-19',
    '2026-10',
    11287672,
    903014,
    12190686,
    '{}'::jsonb
  )
  returning id into v_invoice_id;

  v_match := public.match_incoming_invoice(v_invoice_id);
  if v_match->>'status' <> 'matched' then
    raise exception 'SMOKE FAIL: invoice should match, got %', v_match;
  end if;

  select i.template_id
    into v_green_template
  from public.incoming_invoices i
  where i.id = v_invoice_id;

  if v_green_template is null then
    raise exception 'SMOKE FAIL: no template matched for GREEN SM';
  end if;

  if not exists (
    select 1
    from public.expense_templates t
    join public.suppliers s on s.id = t.supplier_id
    where t.id = v_green_template
      and s.name = 'GREEN SM'
  ) then
    raise exception 'SMOKE FAIL: matched template is not GREEN SM';
  end if;

  v_create := public.create_payment_request_from_invoice(v_invoice_id);
  if v_create->>'status' <> 'pending' then
    raise exception 'SMOKE FAIL: created request not pending: %', v_create;
  end if;

  select *
    into v_pr
  from public.payment_requests
  where id = (v_create->>'payment_request_id')::uuid;

  if v_pr.id is null then
    raise exception 'SMOKE FAIL: payment request not found';
  end if;
  if v_pr.status <> 'pending'::public.payment_request_status then
    raise exception 'SMOKE FAIL: status %', v_pr.status;
  end if;
  if v_pr.payment_status <> 'unpaid'::public.payment_status then
    raise exception 'SMOKE FAIL: payment_status %', v_pr.payment_status;
  end if;
  if v_pr.total_amount <> 12190686 then
    raise exception 'SMOKE FAIL: total_amount %', v_pr.total_amount;
  end if;
  if v_pr.vat_amount <> 903014 then
    raise exception 'SMOKE FAIL: vat_amount %', v_pr.vat_amount;
  end if;
  if v_pr.image_url is distinct from 'smoke/green-sm-2026-10.pdf' then
    raise exception 'SMOKE FAIL: image_url %', v_pr.image_url;
  end if;
  if v_pr.notes not like '%T10/2026%' then
    raise exception 'SMOKE FAIL: notes missing period T10/2026: %', v_pr.notes;
  end if;
  if v_pr.notes not like '%SMOKE-001%' then
    raise exception 'SMOKE FAIL: notes missing invoice number: %', v_pr.notes;
  end if;
  if v_pr.payment_type <> 'old_order'::public.payment_type then
    raise exception 'SMOKE FAIL: payment_type %', v_pr.payment_type;
  end if;
  if v_pr.purchase_order_id is not null then
    raise exception 'SMOKE FAIL: auto request must not have PO';
  end if;

  if not exists (
    select 1
    from public.payment_request_attachments a
    where a.payment_request_id = v_pr.id
      and a.storage_path = 'smoke/green-sm-2026-10.pdf'
  ) then
    raise exception 'SMOKE FAIL: attachment missing';
  end if;

  if (select i.status from public.incoming_invoices i where i.id = v_invoice_id) <> 'pr_created' then
    raise exception 'SMOKE FAIL: invoice status not pr_created';
  end if;
  if (select i.payment_request_id from public.incoming_invoices i where i.id = v_invoice_id) <> v_pr.id then
    raise exception 'SMOKE FAIL: invoice not linked to request';
  end if;

  v_again := public.create_payment_request_from_invoice(v_invoice_id);
  if (v_again->>'payment_request_id')::uuid <> v_pr.id then
    raise exception 'SMOKE FAIL: idempotent call returned a different request: %', v_again;
  end if;

  select count(*)::integer
    into v_count
  from public.payment_requests pr
  join public.incoming_invoices i on i.payment_request_id = pr.id
  where i.id = v_invoice_id;
  if v_count <> 1 then
    raise exception 'SMOKE FAIL: invoice created % payment requests', v_count;
  end if;

  -- Chủ sửa phiếu tự lập: trigger phải ghi feedback 'edited'.
  update public.payment_requests
     set title = title || ' (smoke sửa)'
   where id = v_pr.id;
  if not exists (
    select 1
    from public.expense_template_feedback f
    where f.payment_request_id = v_pr.id
      and f.kind = 'edited'
  ) then
    raise exception 'SMOKE FAIL: edited feedback missing';
  end if;

  select public.get_auto_payment_request_count() into v_count;
  if v_count < 1 then
    raise exception 'SMOKE FAIL: auto payment count should be >= 1, got %', v_count;
  end if;

  -- (f) Chuông chỉ trả khuôn còn phiếu mẫu trong 75 ngày.
  if exists (
    select 1
    from public.get_expense_due_notices() n
    where not exists (
      select 1
      from public.expense_templates t
      join public.suppliers s on s.id = t.supplier_id
      where s.name = n.supplier_name
        and t.label = n.label
        and (
          select max(c.created_at)
          from public.expense_learning_candidates() c
          where c.key = t.key
        ) >= now() - interval '75 days'
    )
  ) then
    raise exception 'SMOKE FAIL: due notice without a sample in the last 75 days';
  end if;

  raise notice 'SMOKE create_payment_request_from_invoice: %', v_create;
end $$;

select jsonb_build_object(
  'status', 'SMOKE_RESULT PASS',
  'templates', (select count(*) from public.expense_templates),
  'active_template_count', (select count(*) from public.expense_templates where active = true),
  'active_templates', (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'supplier', s.name,
          'label', t.label,
          'cadence', t.cadence,
          'sample_count', t.sample_count
        )
        order by s.name, t.label
      ),
      '[]'::jsonb
    )
    from public.expense_templates t
    join public.suppliers s on s.id = t.supplier_id
    where t.active = true
  ),
  'green_sm_template', (
    select t.id
    from public.expense_templates t
    join public.suppliers s on s.id = t.supplier_id
    where s.name = 'GREEN SM'
    order by t.updated_at desc
    limit 1
  ),
  'invoice_id', (select i.id from public.incoming_invoices i where i.source_ref = 'smoke-1'),
  'invoice_status', (select i.status from public.incoming_invoices i where i.source_ref = 'smoke-1'),
  'goods_invoice_status', (select i.status from public.incoming_invoices i where i.source_ref = 'smoke-goods'),
  'goods_invoice_match_source', (select i.match_source from public.incoming_invoices i where i.source_ref = 'smoke-goods'),
  'payment_request_id', (select i.payment_request_id from public.incoming_invoices i where i.source_ref = 'smoke-1'),
  'request_number', (
    select pr.request_number
    from public.payment_requests pr
    join public.incoming_invoices i on i.payment_request_id = pr.id
    where i.source_ref = 'smoke-1'
  ),
  'total_amount', (
    select pr.total_amount
    from public.payment_requests pr
    join public.incoming_invoices i on i.payment_request_id = pr.id
    where i.source_ref = 'smoke-1'
  ),
  'notes', (
    select pr.notes
    from public.payment_requests pr
    join public.incoming_invoices i on i.payment_request_id = pr.id
    where i.source_ref = 'smoke-1'
  ),
  'image_url', (
    select pr.image_url
    from public.payment_requests pr
    join public.incoming_invoices i on i.payment_request_id = pr.id
    where i.source_ref = 'smoke-1'
  ),
  'auto_payment_count', public.get_auto_payment_request_count(),
  'due_notices', (select count(*) from public.get_expense_due_notices())
) as result;

rollback;
