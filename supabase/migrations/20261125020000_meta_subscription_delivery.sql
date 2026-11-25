-- An atomic insert claims one delivery per paid invoice, across webhook workers.
CREATE TABLE public.meta_subscription_delivery (
    event_id text PRIMARY KEY CHECK (event_id ~ '^[a-f0-9]{64}$'),
    status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'accepted', 'uncertain')),
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meta_subscription_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_subscription_delivery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meta_subscription_delivery TO service_role;
CREATE POLICY service_meta_delivery ON public.meta_subscription_delivery
    FOR ALL TO service_role USING (true) WITH CHECK (true);
