"""Exercise the hosted guest allowance against real PostgreSQL triggers."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from fastapi import HTTPException

from test_billing_credits import db, server, owner, wallet, generate, MIGRATION
from src.utils.generation_storage import GenerationStorage

GUEST_MIGRATION = MIGRATION.parent / '20261023020000_guest_credit_allowance.sql'
NETWORK = 'ip_v1_' + 'a' * 64


def migrate(db):
    db.execute('ALTER TABLE generations ADD COLUMN guest_ip_hash text')
    db.execute((MIGRATION.parent / '20261023010000_user_provider_keys.sql').read_text())
    db.execute(GUEST_MIGRATION.read_text())
    db.execute('UPDATE billing_settings SET generation_budget_usd=100000')


def guest(db, endpoint='novaToBricks', session='guest_trial', network=NETWORK):
    gid = str(uuid4())
    db.execute("""INSERT INTO generations(id,user_id,user_type,endpoint,status,guest_ip_hash,billing_policy_version)
        VALUES(%s,%s,'anonymous',%s,'started',%s,2)""", (gid, session, endpoint, network))
    return gid


def used(db, identity='session:guest_trial'):
    row = db.execute('SELECT credits_used FROM guest_credit_usage WHERE identity=%s', (identity,)).fetchone()
    return row['credits_used'] if row else 0


@pytest.mark.parametrize('endpoint,count', [('novaToBricks',5), ('llmToBricks',75)])
def test_guests_get_five_all_parts_or_seventy_five_basic_without_a_daily_cap(db,endpoint,count):
    migrate(db)
    for _ in range(count): guest(db,endpoint)
    assert used(db) == used(db,'network:'+NETWORK) == 75
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db,endpoint)
    assert db.execute('SELECT count(*) n FROM guest_credit_charges').fetchone()['n'] == count
    assert db.execute('SELECT count(*) n FROM billing_accounts').fetchone()['n'] == 0
    assert db.execute('SELECT count(*) n FROM generations WHERE guest_ip_hash IS NOT NULL').fetchone()['n'] == 0


def test_modes_and_ai_edits_share_the_same_nonrenewing_allowance(db):
    migrate(db)
    for endpoint in ['novaToBricks']*4+['llmToBricks']*5: guest(db,endpoint)
    assert used(db) == 65
    # A rejected expensive build does not consume the ten credits still usable for Basic.
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db)
    for _ in range(10): guest(db,'llmToBricks')
    for endpoint in ['updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks']: guest(db,endpoint)
    assert used(db) == 75
    db.execute('DELETE FROM generations')
    db.execute('UPDATE generation_daily_usage SET usage_day=usage_day-90')
    db.execute('UPDATE billing_settings SET enabled=false')
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db,'llmToBricks')


@pytest.mark.parametrize('shared_network', [False,True])
def test_parallel_admission_cannot_overdraw_browser_or_network_balance(db,server,shared_network):
    migrate(db)
    def attempt(i):
        with psycopg.connect(server.get_uri(),autocommit=True) as conn:
            try:
                guest(conn,session=f'session_{i}' if shared_network else 'guest_trial',
                    network=NETWORK if shared_network else 'ip_v1_'+f'{i:064x}')
                return True
            except psycopg.errors.RaiseException as error:
                assert 'BB_GUEST_CREDITS_EXHAUSTED' in str(error)
                return False
    with ThreadPoolExecutor(max_workers=12) as pool:
        assert sum(pool.map(attempt,range(12))) == 5
    assert db.execute('SELECT sum(credits_used) n FROM guest_credit_usage').fetchone()['n'] == 150
    assert db.execute('SELECT count(*) n FROM guest_credit_charges').fetchone()['n'] == 5


def test_claiming_and_new_browser_or_network_cannot_replenish_guest_credits(db):
    migrate(db)
    uid=owner(db)
    ids=[guest(db) for _ in range(5)]
    for gid in ids:
        db.execute("UPDATE generations SET user_type='authenticated',user_id=%s,status='completed' WHERE id=%s",(uid,gid))
    assert used(db) == 75
    assert wallet(db,uid)['monthly_remaining'] == 225
    assert db.execute('SELECT count(*) n FROM billing_credit_history WHERE kind=\'generation\'').fetchone()['n'] == 5
    db.execute('DELETE FROM generations')
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db,session='new_browser')
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db,network='ip_v1_'+'b'*64)
    assert used(db,'session:new_browser') == 0
    guest(db,session='new_browser',network='ip_v1_'+'b'*64)


@pytest.mark.parametrize('status', ['failed','cancelled'])
def test_failed_or_cancelled_builds_refund_once_even_after_claiming_without_erasing_spend(db,status):
    migrate(db)
    gid=guest(db)
    uid=owner(db)
    db.execute("UPDATE generations SET user_type='authenticated',user_id=%s WHERE id=%s",(uid,gid))
    assert wallet(db,uid)['monthly_remaining'] == 285
    for state in [status,'processing',status]:
        db.execute('UPDATE generations SET status=%s WHERE id=%s',(state,gid))
    assert used(db) == used(db,'network:'+NETWORK) == 0
    assert wallet(db,uid)['monthly_remaining'] == 300
    assert db.execute('SELECT refunded FROM guest_credit_charges WHERE generation_id=%s',(gid,)).fetchone()['refunded']
    assert db.execute('SELECT amount FROM billing_ai_reservations WHERE reference=%s',(gid,)).fetchone()['amount'] == 21
    for _ in range(5): guest(db)


def test_failed_trials_do_not_charge_a_signed_in_wallet_and_old_month_claims_do_not_charge(db):
    migrate(db)
    uid=owner(db)
    failed=guest(db)
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(failed,))
    db.execute("UPDATE generations SET user_type='authenticated',user_id=%s WHERE id=%s",(uid,failed))
    old=guest(db,'llmToBricks')
    db.execute("UPDATE generations SET created_at=now()-interval '2 months' WHERE id=%s",(old,))
    db.execute("UPDATE generations SET user_type='authenticated',user_id=%s WHERE id=%s",(uid,old))
    assert wallet(db,uid)['monthly_remaining'] == 300
    assert used(db) == 1


def test_capacity_concurrency_and_explicit_limits_roll_back_guest_reservations(db):
    migrate(db)
    db.execute('UPDATE billing_settings SET generation_budget_usd=1')
    with pytest.raises(psycopg.errors.RaiseException,match='BB_AI_CAPACITY'): guest(db)
    assert used(db) == 0
    db.execute('UPDATE billing_settings SET generation_budget_usd=100000')
    db.execute((MIGRATION.parent/'20261022010000_generation_concurrency_limit_1.sql').read_text())
    first=guest(db)
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GENERATION_CONCURRENCY_LIMIT'): guest(db)
    db.execute("UPDATE generations SET status='completed' WHERE id=%s",(first,))
    uid=owner(db)
    db.execute("INSERT INTO generation_daily_limit_overrides(user_id,user_type,daily_limit) VALUES(%s,'authenticated',1)",(uid,))
    signed_in=generate(db,uid)
    db.execute("UPDATE generations SET status='completed' WHERE id=%s",(signed_in,))
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GENERATION_DAILY_LIMIT:1'): generate(db,uid)
    assert used(db) == used(db,'network:'+NETWORK) == 15
    assert db.execute('SELECT count(*) n FROM guest_credit_charges').fetchone()['n'] == 1


def test_migration_preserves_known_weighted_history_and_unknown_legacy_attempts(db):
    db.execute('UPDATE billing_settings SET enabled=false')
    db.execute("INSERT INTO generation_guest_usage VALUES('old',4),('claimed',2)")
    db.execute("INSERT INTO anonymous_users(ip_hash,identity_type,call_count,first_call) VALUES(%s,'ip_v1',4,now()),('legacy','legacy',500,now())",(NETWORK,))
    for endpoint in ['novaToBricks','llmToBricks','uploadLdraw']:
        db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status) VALUES(%s,'old','anonymous',%s,'completed')",(str(uuid4()),endpoint))
    migrate(db)
    assert used(db,'session:old') == 17  # 15+1+0 known, plus one deleted attempt.
    assert used(db,'session:claimed') == 2
    assert used(db,'network:'+NETWORK) == 4
    assert used(db,'network:legacy') == 0
    assert db.execute('SELECT call_count FROM anonymous_users WHERE ip_hash=\'legacy\'').fetchone()['call_count'] == 500


@pytest.mark.parametrize('network',[None,'192.0.2.1','guest_'+'a'*64])
def test_network_identity_is_required_and_credit_records_are_server_only(db,network):
    migrate(db)
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GENERATION_GUEST_IP_REQUIRED'): guest(db,network=network)
    assert used(db) == 0
    for role in ['anon','authenticated']:
        for table in ['guest_credit_usage','guest_credit_charges']:
            assert not db.execute('SELECT has_table_privilege(%s,%s,\'SELECT,INSERT,UPDATE,DELETE\') p',(role,table)).fetchone()['p']
        assert not db.execute("SELECT has_function_privilege(%s,'reserve_guest_credits(uuid,text,text,text)','EXECUTE') p",(role,)).fetchone()['p']


def test_guest_error_explains_the_shared_lifetime_allowance_without_a_reset_time():
    class Table:
        def insert(self,row): return self
        def execute(self): raise ValueError('BB_GUEST_CREDITS_EXHAUSTED')
    storage=GenerationStorage.__new__(GenerationStorage)
    storage.client=SimpleNamespace(table=lambda _:Table())
    with pytest.raises(HTTPException) as error:
        asyncio.run(storage.create_generation('guest_trial','anonymous','cube',40))
    assert error.value.status_code == 403
    assert '75 credits: 5 All parts builds or 75 Basic builds, or a mix' in error.value.detail
    assert 'Sign in for 300 free monthly credits' in error.value.detail
    assert not error.value.headers
