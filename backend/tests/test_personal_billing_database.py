from uuid import uuid4
import pytest
import psycopg
from test_billing_credits import db, server, owner, wallet, generate, MIGRATION


def migrate(db):
    db.execute((MIGRATION.parent/'20261023010000_user_provider_keys.sql').read_text())


def insert(db, uid, endpoint='novaToBricks', user_type='authenticated'):
    gid = str(uuid4())
    db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status,billing_policy_version,personal_billing) VALUES(%s,%s,%s,%s,'started',2,true)", (gid,uid,user_type,endpoint))
    return gid


def test_personal_builds_bypass_wallet_daily_and_platform_budget(db):
    migrate(db)
    uid = owner(db)
    db.execute('UPDATE billing_accounts SET monthly_remaining=0,bonus_remaining=0')
    db.execute('UPDATE billing_settings SET generation_budget_usd=1,enabled=false')
    for _ in range(12): insert(db,uid)
    assert db.execute('SELECT count(*) n FROM generation_daily_usage').fetchone()['n'] == 0
    db.execute('UPDATE billing_settings SET enabled=true')
    insert(db,uid,'llmToBricks')
    assert wallet(db,uid)['monthly_remaining'] == 0
    assert db.execute('SELECT count(*) n FROM billing_ai_reservations').fetchone()['n'] == 0
    with pytest.raises(psycopg.errors.RaiseException, match='BB_CREDITS_EXHAUSTED'): generate(db,uid)


def test_personal_billing_is_service_only_and_immutable(db):
    migrate(db)
    uid = owner(db)
    gid = insert(db,uid)
    with pytest.raises(psycopg.errors.RaiseException): insert(db,uid,'textToBricks')
    with pytest.raises(psycopg.errors.RaiseException): insert(db,uid,user_type='anonymous')
    with pytest.raises(psycopg.errors.RaiseException): db.execute('UPDATE generations SET personal_billing=false WHERE id=%s',(gid,))
    db.execute('GRANT USAGE ON SCHEMA public TO authenticated; GRANT INSERT ON generations TO authenticated; SET ROLE authenticated')
    try:
        with pytest.raises(psycopg.errors.RaiseException, match='Invalid personal billing'): insert(db,uid)
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM user_provider_keys')
    finally: db.execute('RESET ROLE')


def test_personal_builds_still_enforce_concurrency(db):
    migrate(db)
    db.execute((MIGRATION.parent/'20261022010000_generation_concurrency_limit_1.sql').read_text())
    uid = owner(db)
    insert(db,uid)
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'): insert(db,uid)
