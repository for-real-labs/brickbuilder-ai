from pathlib import Path
from uuid import uuid4
import psycopg
import pytest
from test_billing_credits import server

MIGRATION = Path(__file__).parents[2]/'supabase/migrations/20261028020000_account_deletion.sql'

@pytest.fixture
def deletion_db(server):
    with psycopg.connect(server.get_uri(),autocommit=True) as db:
        db.execute('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth; DROP SCHEMA IF EXISTS storage CASCADE; CREATE SCHEMA storage')
        for role in ('anon','authenticated','service_role'):
            if not db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone(): db.execute(f'CREATE ROLE {role}')
        db.execute('CREATE TABLE auth.users(id uuid PRIMARY KEY,email text); CREATE TABLE user_profiles(id uuid); CREATE TABLE generations(id uuid PRIMARY KEY,generation_id uuid,user_id text,status text,is_community boolean,notification_email text,notification_origin text); CREATE TABLE orders(generation_id uuid REFERENCES generations(id) ON DELETE CASCADE); CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,owner uuid); CREATE TABLE change_requests(id uuid,user_id uuid); CREATE TABLE generation_email_outbox(generation_id uuid,email text)')
        for table in ('generation_daily_usage','generation_daily_limit_overrides','generation_guest_usage'):
            db.execute(f'CREATE TABLE {table}(user_id text)')
        for table in ('generation_daily_email_exemptions','change_request_email_access','waitlist_emails'):
            db.execute(f'CREATE TABLE {table}(email text)')
        db.execute('CREATE TABLE billing_credit_purchases(user_id uuid)')
        db.execute(MIGRATION.read_text())
        yield db


def test_owner_files_erased_orders_preserved_and_other_users_untouched(deletion_db):
    db=deletion_db
    alice,bob,plain,purchased,version,other=[str(uuid4()) for _ in range(6)]
    db.execute("INSERT INTO auth.users VALUES(%s,'alice@example.test'),(%s,'bob@example.test')",(alice,bob))
    for gid,group,uid in [(plain,plain,alice),(purchased,purchased,alice),(version,purchased,alice),(other,other,bob)]:
        db.execute("INSERT INTO generations VALUES(%s,%s,%s,'completed',true,'contact@example.test',NULL)",(gid,group,uid))
        db.execute("INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('generations',%s,%s)",(f'generations/{gid}/model.ldr',uid))
    db.execute('INSERT INTO orders VALUES(%s)',(purchased,))
    db.execute('SELECT account_deletion_prepare(%s)',(alice,))
    names=db.execute('SELECT name FROM account_deletion_files(%s)',(alice,)).fetchall()
    assert names==[(f'generations/{plain}/model.ldr',)]
    db.execute('DELETE FROM storage.objects WHERE name=%s',(f'generations/{plain}/model.ldr',))
    db.execute('SELECT account_deletion_data(%s)',(alice,))
    assert db.execute('SELECT owner_id FROM storage.objects WHERE name=%s',(f'generations/{purchased}/model.ldr',)).fetchone()==(None,)
    assert db.execute('SELECT count(*) FROM orders').fetchone()[0]==1
    assert db.execute('SELECT user_id,is_community FROM generations WHERE id=%s',(purchased,)).fetchone()==('deleted-account',False)
    assert db.execute('SELECT user_id FROM generations WHERE id=%s',(other,)).fetchone()[0]==bob
    assert db.execute('SELECT count(*) FROM generations WHERE id=%s',(plain,)).fetchone()[0]==0
    with pytest.raises(psycopg.errors.RaiseException,match='DELETION_IN_PROGRESS'):
        db.execute("INSERT INTO generations(id,user_id,status) VALUES(%s,%s,'started')",(str(uuid4()),alice))
    db.execute('SELECT account_deletion_data(%s)',(alice,)) # retry-safe


def test_active_builds_block_before_tombstone_and_public_cannot_erase(deletion_db):
    db=deletion_db; uid=str(uuid4())
    db.execute("INSERT INTO generations(id,user_id,status) VALUES(%s,%s,'processing')",(str(uuid4()),uid))
    with pytest.raises(psycopg.errors.RaiseException,match='ACTIVE_BUILDS'): db.execute('SELECT account_deletion_prepare(%s)',(uid,))
    assert db.execute('SELECT count(*) FROM account_deletions').fetchone()[0]==0
    db.execute('GRANT USAGE ON SCHEMA public TO authenticated; SET ROLE authenticated')
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT account_deletion_data(%s)',(uid,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM account_deletions')
    finally: db.execute('RESET ROLE')
