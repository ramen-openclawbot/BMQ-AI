-- ============================================================================
-- v0.0.18 — Security audit logs table
-- Tracks sensitive operations: user invites, deletions, role changes, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_id   uuid,              -- optional: the user/resource being acted upon
  metadata    jsonb DEFAULT '{}', -- flexible payload (email, role, etc.)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for querying by actor or action
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor   ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);

-- RLS: only service_role can insert; owners can read
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so inserts from edge functions (using service_role key) work automatically.
-- Owners can read audit logs via the app.
CREATE POLICY "Owners can read audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = auth.uid()
        AND user_roles.role = 'owner'
    )
  );

-- No INSERT/UPDATE/DELETE policies for regular users — only service_role can write.

COMMENT ON TABLE public.audit_logs IS 'Tracks sensitive operations for security auditing (v0.0.18)';
