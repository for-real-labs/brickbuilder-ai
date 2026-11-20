CREATE TABLE public.apple_sign_in_credentials (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_refresh_token text NOT NULL
);

ALTER TABLE public.apple_sign_in_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.apple_sign_in_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.apple_sign_in_credentials TO service_role;
