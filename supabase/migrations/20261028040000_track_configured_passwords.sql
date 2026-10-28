-- GoTrue also generates password hashes for OTP users. Track explicit password
-- setup instead. This metadata controls a UI label only, never authorization.
CREATE FUNCTION public.track_configured_password() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password THEN
    NEW.raw_user_meta_data := coalesce(NEW.raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('password_configured', coalesce(NEW.encrypted_password, '') <> '');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.track_configured_password() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER track_configured_password BEFORE UPDATE OF encrypted_password ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.track_configured_password();

-- Preserve known password users even after their current sessions expire.
UPDATE auth.users u SET raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
  || '{"password_configured":true}'::jsonb
WHERE EXISTS (SELECT 1 FROM auth.sessions s JOIN auth.mfa_amr_claims a ON a.session_id=s.id
  WHERE s.user_id=u.id AND a.authentication_method='password');

CREATE OR REPLACE FUNCTION public.account_has_password() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT coalesce((SELECT coalesce(u.encrypted_password, '') <> '' AND
    (u.raw_user_meta_data->'password_configured' = 'true'::jsonb OR EXISTS (
      SELECT 1 FROM auth.sessions s JOIN auth.mfa_amr_claims a ON a.session_id=s.id
      WHERE s.user_id=u.id AND a.authentication_method='password'))
    FROM auth.users u WHERE u.id=auth.uid()), false);
$$;
REVOKE ALL ON FUNCTION public.account_has_password() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_has_password() TO authenticated;
