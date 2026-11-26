-- Run against a migrated test database. The fixture and updates roll back.
BEGIN;
INSERT INTO auth.users(id) VALUES ('c94601bc-1200-4d52-832d-ce0a13eef011');
INSERT INTO public.billing_accounts(user_id, livemode)
VALUES ('c94601bc-1200-4d52-832d-ce0a13eef011', false) ON CONFLICT DO NOTHING;
UPDATE public.billing_accounts SET subscription_status = 'past_due'
WHERE user_id = 'c94601bc-1200-4d52-832d-ce0a13eef011' AND NOT livemode;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"c94601bc-1200-4d52-832d-ce0a13eef011"}';
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM public.billing_status_updates WHERE user_id = auth.uid());
END $$;
SET LOCAL request.jwt.claims = '{"sub":"c94601bc-1200-4d52-832d-ce0a13eef012"}';
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.billing_status_updates WHERE user_id = 'c94601bc-1200-4d52-832d-ce0a13eef011');
END $$;
ROLLBACK;
