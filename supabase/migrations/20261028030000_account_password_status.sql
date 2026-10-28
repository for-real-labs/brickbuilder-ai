-- Return only whether the caller has a password. Email identities can also be
-- passwordless, so provider/user_metadata values are not reliable indicators.
CREATE FUNCTION public.account_has_password() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT coalesce((SELECT encrypted_password IS NOT NULL AND encrypted_password <> ''
    FROM auth.users WHERE id = auth.uid()), false);
$$;
REVOKE ALL ON FUNCTION public.account_has_password() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_has_password() TO authenticated;
