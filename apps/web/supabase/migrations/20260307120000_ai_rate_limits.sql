-- ============================================================================
-- v0.0.19 — Rate limit tracking cho AI scan functions
-- Giới hạn số lần gọi OpenAI API per user per function per ngày
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_function_rate_limits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  usage_count  integer NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  window_end   timestamptz NOT NULL DEFAULT ((date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + interval '1 day') AT TIME ZONE 'Asia/Ho_Chi_Minh'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One row per user per function per day window
  CONSTRAINT uq_rate_limit_user_fn_window UNIQUE (user_id, function_name, window_start)
);

-- Fast lookup for active windows
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON public.ai_function_rate_limits (user_id, function_name, window_end DESC);

-- Cleanup index
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_end
  ON public.ai_function_rate_limits (window_end);

-- RLS: service_role bypasses (for edge functions), owners can read
ALTER TABLE public.ai_function_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view rate limits"
  ON public.ai_function_rate_limits FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = auth.uid()
        AND user_roles.role = 'owner'
    )
  );

-- Cleanup function: xoá records cũ hơn 7 ngày
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS integer AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.ai_function_rate_limits
  WHERE window_end < now() - interval '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.ai_function_rate_limits IS 'Rate limit tracking cho AI scan functions (v0.0.19)';
