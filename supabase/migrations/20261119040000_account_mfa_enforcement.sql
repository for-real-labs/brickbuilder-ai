CREATE FUNCTION public.account_requires_mfa(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.mfa_factors WHERE user_id = p_user_id AND status = 'verified'
  );
$$;

REVOKE ALL ON FUNCTION public.account_requires_mfa(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_requires_mfa(uuid) TO service_role;

CREATE FUNCTION public.account_has_mfa_assurance() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    OR NOT public.account_requires_mfa(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.account_has_mfa_assurance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_has_mfa_assurance() TO authenticated;

-- Restrictive policies apply alongside the existing ownership policies.
-- Anonymous requests and service-role calls keep their existing policies.
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    EXECUTE format(
      'CREATE POLICY account_mfa_assurance ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated
        USING ((SELECT public.account_has_mfa_assurance()))
        WITH CHECK ((SELECT public.account_has_mfa_assurance()))',
      target.nspname, target.relname
    );
  END LOOP;
END;
$$;

-- Supabase permits object policies without granting access to internal Storage tables.
CREATE POLICY account_mfa_assurance ON storage.objects
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.account_has_mfa_assurance()))
  WITH CHECK ((SELECT public.account_has_mfa_assurance()));

CREATE OR REPLACE FUNCTION public.claim_account_referral(p_visit uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN public.account_has_mfa_assurance()
    THEN public.award_account_referral(auth.uid(), p_visit) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.account_has_password() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.account_has_mfa_assurance() AND coalesce((
    SELECT coalesce(u.encrypted_password, '') <> '' AND
      (u.raw_user_meta_data->'password_configured' = 'true'::jsonb OR EXISTS (
        SELECT 1 FROM auth.sessions s JOIN auth.mfa_amr_claims a ON a.session_id = s.id
        WHERE s.user_id = u.id AND a.authentication_method = 'password'
      ))
    FROM auth.users u WHERE u.id = auth.uid()
  ), false);
$$;
