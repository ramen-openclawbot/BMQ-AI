-- Normalize legacy storage URLs/paths to canonical storage paths (without signed/public host)
-- This helps old PO/UNC/invoice records render reliably with signed URL resolvers.

create or replace function public.normalize_storage_path(raw text, bucket_name text)
returns text
language plpgsql
as $$
declare
  v text;
  marker text;
  p int;
begin
  if raw is null then
    return null;
  end if;

  v := btrim(raw);
  if v = '' then
    return null;
  end if;

  -- Case 1: full Supabase storage URL (public/sign/authenticated)
  marker := '/storage/v1/object/';
  p := strpos(v, marker);
  if p > 0 then
    -- strip host + marker
    v := substring(v from p + char_length(marker));
    -- expected: visibility/bucket/path
    if strpos(v, '/') > 0 then
      v := substring(v from strpos(v, '/') + 1); -- remove visibility
      if strpos(v, '/') > 0 then
        if split_part(v, '/', 1) = bucket_name then
          v := substring(v from strpos(v, '/') + 1); -- remove bucket
        end if;
      end if;
    end if;
    -- drop query/hash
    v := split_part(v, '?', 1);
    v := split_part(v, '#', 1);
    return nullif(v, '');
  end if;

  -- Case 2: already prefixed with bucket/path
  if v like bucket_name || '/%' then
    return nullif(substring(v from char_length(bucket_name) + 2), '');
  end if;

  -- Case 3: already plain path
  return v;
end;
$$;

-- purchase_orders.image_url -> purchase-orders bucket
update public.purchase_orders
set image_url = public.normalize_storage_path(image_url, 'purchase-orders')
where image_url is not null;

-- invoices.image_url + payment_slip_url -> invoices bucket
update public.invoices
set image_url = public.normalize_storage_path(image_url, 'invoices')
where image_url is not null;

update public.invoices
set payment_slip_url = public.normalize_storage_path(payment_slip_url, 'invoices')
where payment_slip_url is not null;

-- payment_requests.image_url -> invoices bucket (legacy design)
update public.payment_requests
set image_url = public.normalize_storage_path(image_url, 'invoices')
where image_url is not null;
