-- Maintenance signups can come from visitors without an account or a generation.
ALTER TABLE public.waitlist_emails
  ADD COLUMN IF NOT EXISTS maintenance_alert boolean NOT NULL DEFAULT false;

-- Email addresses are only accessible from trusted backend services.
ALTER TABLE public.waitlist_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.waitlist_emails FROM PUBLIC, anon, authenticated;
GRANT INSERT, UPDATE, SELECT ON public.waitlist_emails TO service_role;
