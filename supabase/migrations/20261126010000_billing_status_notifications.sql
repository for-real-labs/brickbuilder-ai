-- Only publish a refresh signal. Stripe records stay in the server-owned wallet.
CREATE TABLE public.billing_status_updates (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_status_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_status_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_status_updates TO authenticated;
CREATE POLICY billing_status_owner ON public.billing_status_updates
FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
ALTER PUBLICATION supabase_realtime ADD TABLE public.billing_status_updates;

CREATE FUNCTION public.notify_billing_status_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.billing_status_updates(user_id) VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO UPDATE SET updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_billing_status_changed() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER billing_status_changed AFTER UPDATE OF subscription_status ON public.billing_accounts
FOR EACH ROW WHEN (OLD.subscription_status IS DISTINCT FROM NEW.subscription_status
    OR (NEW.subscription_status IN ('past_due', 'unpaid') AND OLD.sync_version IS DISTINCT FROM NEW.sync_version))
EXECUTE FUNCTION public.notify_billing_status_changed();
