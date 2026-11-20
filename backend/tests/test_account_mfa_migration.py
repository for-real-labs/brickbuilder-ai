import json
from pathlib import Path

import pgserver
import psycopg
import pytest

ACCOUNT = '00000000-0000-0000-0000-000000000001'


def test_account_mfa_policies_keep_existing_access_and_require_verified_sessions(tmp_path):
    server = pgserver.get_server(tmp_path / 'postgres', cleanup_mode='delete')
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as db:
            db.execute("""
                CREATE ROLE anon;
                CREATE ROLE authenticated;
                CREATE ROLE service_role BYPASSRLS;
                CREATE ROLE storage_admin;
                CREATE SCHEMA auth;
                CREATE SCHEMA storage;
                CREATE TABLE auth.mfa_factors (user_id uuid, status text);
                CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
                  $$ SELECT current_setting('request.jwt.claims', true)::jsonb $$;
                CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
                  $$ SELECT (auth.jwt()->>'sub')::uuid $$;
                CREATE TABLE public.profiles (label text);
                CREATE TABLE storage.objects (label text);
                CREATE TABLE storage.internal_metadata (label text);
                ALTER TABLE storage.internal_metadata OWNER TO storage_admin;
                ALTER TABLE storage.internal_metadata ENABLE ROW LEVEL SECURITY;
                INSERT INTO public.profiles VALUES ('profile');
                INSERT INTO storage.objects VALUES ('file');
                ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
                ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
                CREATE POLICY read_profile ON public.profiles FOR SELECT USING (true);
                CREATE POLICY read_object ON storage.objects FOR SELECT USING (true);
                CREATE POLICY add_object ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);
                GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
                GRANT SELECT ON public.profiles, storage.objects TO anon, authenticated, service_role;
                GRANT INSERT ON storage.objects TO authenticated;
                CREATE FUNCTION public.award_account_referral(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
                CREATE TABLE auth.users (id uuid, encrypted_password text, raw_user_meta_data jsonb);
                CREATE TABLE auth.sessions (id uuid, user_id uuid);
                CREATE TABLE auth.mfa_amr_claims (session_id uuid, authentication_method text);
                GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;
                GRANT USAGE ON SCHEMA auth TO authenticated;
            """)
            migration = Path(__file__).parents[2] / 'supabase/migrations/20261119040000_account_mfa_enforcement.sql'
            db.execute(migration.read_text())
            assert db.execute("""
                SELECT count(*) FROM pg_policies
                WHERE schemaname = 'storage' AND tablename = 'internal_metadata'
            """).fetchone()[0] == 0

            for status, aal, visible in [('unverified', 'aal1', True),
                                         ('verified', 'aal1', False), ('verified', 'aal2', True)]:
                db.execute('DELETE FROM auth.mfa_factors')
                db.execute('INSERT INTO auth.mfa_factors VALUES (%s, %s)', (ACCOUNT, status))
                db.execute("SELECT set_config('request.jwt.claims', %s, false)", (json.dumps({'sub': ACCOUNT, 'aal': aal}),))
                db.execute('SET ROLE service_role')
                assert db.execute('SELECT public.account_requires_mfa(%s)', (ACCOUNT,)).fetchone()[0] == (status == 'verified')
                db.execute('SET ROLE authenticated')
                assert db.execute('SELECT label FROM public.profiles').fetchall() == ([('profile',)] if visible else [])
                assert db.execute("SELECT label FROM storage.objects WHERE label = 'file'").fetchall() == ([('file',)] if visible else [])
                assert db.execute('SELECT public.claim_account_referral(%s)', (ACCOUNT,)).fetchone()[0] == visible
                if visible:
                    db.execute("INSERT INTO storage.objects VALUES ('new file')")
                else:
                    with pytest.raises(psycopg.errors.InsufficientPrivilege):
                        db.execute("INSERT INTO storage.objects VALUES ('new file')")
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    db.execute('SELECT public.account_requires_mfa(%s)', (ACCOUNT,))
                db.execute('RESET ROLE')

            db.execute('SET ROLE anon')
            assert db.execute('SELECT label FROM public.profiles').fetchall() == [('profile',)]
    finally:
        server.cleanup()
