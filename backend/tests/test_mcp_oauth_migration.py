"""Execute the actual OAuth hook migration in an isolated local transaction."""
import json
from pathlib import Path

import pgserver
import psycopg
from psycopg import sql


def test_token_hook_resource_binding_and_database_permissions(tmp_path):
    server = pgserver.get_server(str(tmp_path / "postgres"))
    migration = Path(__file__).resolve().parents[2] / "supabase/migrations/20260930000001_mcp_oauth.sql"
    with psycopg.connect(server.get_uri()) as conn:
        try:
            for role in ("anon", "authenticated", "service_role", "supabase_auth_admin"):
                conn.execute(sql.SQL("create role {} noinherit").format(sql.Identifier(role)))
            conn.execute(migration.read_text())
            conn.execute("insert into public.mcp_oauth_clients values ('chatgpt-client', 'https://api.example.com/mcp')")
            original = {"aud": "authenticated", "sub": "user", "email": "builder@example.com", "exp": 123, "role": "authenticated"}

            def issue(claims):
                return conn.execute("select public.mcp_access_token_hook(%s::jsonb)",
                                    (json.dumps({"claims": claims}),)).fetchone()[0]["claims"]

            conn.execute("set local role supabase_auth_admin")
            assert issue(original) == original
            unknown = {**original, "client_id": "unregistered-client"}
            assert issue(unknown) == unknown
            trusted = {**original, "client_id": "chatgpt-client"}
            assert issue(trusted) == {**trusted, "aud": "https://api.example.com/mcp", "scope": "email"}
            conn.execute("reset role")
            for role in ("anon", "authenticated"):
                table_access, hook_access = conn.execute(
                    "select has_table_privilege(%s, 'public.mcp_oauth_clients', 'select'), "
                    "has_function_privilege(%s, 'public.mcp_access_token_hook(jsonb)', 'execute')", (role, role),
                ).fetchone()
                assert not table_access and not hook_access
        finally:
            conn.rollback()
