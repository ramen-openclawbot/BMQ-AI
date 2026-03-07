-- ==========================================================================
-- v0.0.27 — Phase 2: consolidate daily finance reads into one RPC
-- Returns declaration + reconciliation + UNC detail sum + QTM opening balance
-- in a single round-trip.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.finance_daily_snapshot(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_utc timestamptz;
  v_end_utc timestamptz;
  v_declaration jsonb;
  v_reconciliation jsonb;
  v_unc_detail numeric := 0;
  v_qtm_opening numeric := 0;
BEGIN
  -- Interpret day boundaries in Asia/Saigon, compare against UTC timestamptz.
  v_start_utc := (p_date::timestamp AT TIME ZONE 'Asia/Saigon');
  v_end_utc := ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Saigon');

  SELECT to_jsonb(d)
    INTO v_declaration
  FROM (
    SELECT
      closing_date,
      unc_total_declared,
      unc_extracted_amount,
      cash_fund_topup_amount,
      qtm_extracted_amount,
      notes,
      extraction_meta
    FROM public.ceo_daily_closing_declarations
    WHERE closing_date = p_date
    LIMIT 1
  ) d;

  SELECT to_jsonb(r)
    INTO v_reconciliation
  FROM (
    SELECT *
    FROM public.daily_reconciliations
    WHERE closing_date = p_date
    LIMIT 1
  ) r;

  -- UNC detail amount: bank_transfer requests by created_at (day window)
  -- OR invoice_date == p_date, excluding likely QTM records.
  SELECT COALESCE(SUM(pr.total_amount), 0)
    INTO v_unc_detail
  FROM public.payment_requests pr
  LEFT JOIN public.invoices i ON i.id = pr.invoice_id
  WHERE pr.payment_method = 'bank_transfer'
    AND (
      (pr.created_at >= v_start_utc AND pr.created_at < v_end_utc)
      OR i.invoice_date = p_date
    )
    AND NOT (
      lower(concat_ws(' ', pr.title, pr.description, pr.notes, pr.image_url))
      ~ '(^|\W)qtm($|\W)|quỹ\s*tiền\s*mặt|quy\s*tien\s*mat|cash\s*fund'
    );

  -- QTM opening precedence:
  -- 1) exact previous day closing
  -- 2) nearest previous day closing
  -- 3) stored opening in current declaration
  SELECT COALESCE(
      NULLIF(prev.extraction_meta->>'qtm_closing_balance', '')::numeric,
      COALESCE(NULLIF(prev.extraction_meta->>'qtm_opening_balance', '')::numeric, 0)
        + COALESCE(prev.qtm_extracted_amount, prev.cash_fund_topup_amount, 0)
        - COALESCE(NULLIF(prev.extraction_meta->>'qtm_spent_from_folder', '')::numeric, 0)
    )
    INTO v_qtm_opening
  FROM public.ceo_daily_closing_declarations prev
  WHERE prev.closing_date = (p_date - 1)
  LIMIT 1;

  IF v_qtm_opening IS NULL THEN
    SELECT COALESCE(
        NULLIF(prev.extraction_meta->>'qtm_closing_balance', '')::numeric,
        COALESCE(NULLIF(prev.extraction_meta->>'qtm_opening_balance', '')::numeric, 0)
          + COALESCE(prev.qtm_extracted_amount, prev.cash_fund_topup_amount, 0)
          - COALESCE(NULLIF(prev.extraction_meta->>'qtm_spent_from_folder', '')::numeric, 0)
      )
      INTO v_qtm_opening
    FROM public.ceo_daily_closing_declarations prev
    WHERE prev.closing_date < p_date
    ORDER BY prev.closing_date DESC
    LIMIT 1;
  END IF;

  IF v_qtm_opening IS NULL THEN
    v_qtm_opening := COALESCE(NULLIF(v_declaration->'extraction_meta'->>'qtm_opening_balance', '')::numeric, 0);
  END IF;

  RETURN jsonb_build_object(
    'declaration', COALESCE(v_declaration, 'null'::jsonb),
    'dailyReconciliation', COALESCE(v_reconciliation, 'null'::jsonb),
    'uncDetailAmount', COALESCE(v_unc_detail, 0),
    'qtmOpeningBalance', COALESCE(v_qtm_opening, 0)
  );
END;
$$;