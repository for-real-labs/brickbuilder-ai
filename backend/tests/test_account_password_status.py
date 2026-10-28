from pathlib import Path
from uuid import uuid4
import psycopg
import pytest
from test_billing_credits import server


def test_password_status_is_private_and_uses_the_current_auth_identity(server):
    migration = Path(__file__).parents[2] / 'supabase/migrations/20261028030000_account_password_status.sql'
    with psycopg.connect(server.get_uri(), autocommit=True) as db:
        db.execute('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth')
        for role in ('anon', 'authenticated'):
            if not db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone(): db.execute(f'CREATE ROLE {role}')
        db.execute("CREATE TABLE auth.users(id uuid PRIMARY KEY,encrypted_password text, raw_user_meta_data jsonb); CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid); CREATE TABLE auth.mfa_amr_claims(session_id uuid,authentication_method text); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$")
        db.execute(migration.read_text())
        password_user, otp_user = str(uuid4()), str(uuid4())
        db.execute('INSERT INTO auth.users VALUES(%s,%s, \'{"password_configured":true}\'),(%s,\'random-generated-otp-hash\',NULL)', (password_user, 'hash-never-exposed', otp_user))
        legacy_user, session_id = str(uuid4()), str(uuid4())
        db.execute("INSERT INTO auth.users VALUES(%s,'legacy-password-hash',NULL)", (legacy_user,))
        db.execute('INSERT INTO auth.sessions VALUES(%s,%s)', (session_id, legacy_user))
        db.execute("INSERT INTO auth.mfa_amr_claims VALUES(%s,'password')", (session_id,))
        db.execute(migration.with_name('20261028040000_track_configured_passwords.sql').read_text())
        db.execute('DELETE FROM auth.mfa_amr_claims; DELETE FROM auth.sessions')
        db.execute('GRANT USAGE ON SCHEMA public TO authenticated,anon; SET ROLE authenticated')
        db.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (otp_user,))
        assert db.execute('SELECT public.account_has_password()').fetchone() == (False,)
        db.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (password_user,))
        assert db.execute('SELECT public.account_has_password()').fetchone() == (True,)
        db.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (legacy_user,))
        assert db.execute('SELECT public.account_has_password()').fetchone() == (True,)
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT encrypted_password FROM auth.users')
        db.execute('RESET ROLE')
        db.execute("UPDATE auth.users SET encrypted_password='chosen-password-hash' WHERE id=%s", (otp_user,))
        db.execute('SET ROLE authenticated')
        db.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (otp_user,))
        assert db.execute('SELECT public.account_has_password()').fetchone() == (True,)
        db.execute('RESET ROLE; SET ROLE anon')
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT public.account_has_password()')
        db.execute('RESET ROLE')
