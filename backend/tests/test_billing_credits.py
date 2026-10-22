from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pgserver
import psycopg
from psycopg.rows import dict_row
import pytest

MIGRATION = Path(__file__).parents[2] / 'supabase/migrations/20261022000000_credit_subscriptions.sql'


@pytest.fixture(scope='module')
def server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp('billing-postgres'), cleanup_mode='delete')
    yield instance
    instance.cleanup()


@pytest.fixture
def db(server, request):
    with psycopg.connect(server.get_uri(), autocommit=True, row_factory=dict_row) as conn:
        conn.execute('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth')
        for role in ('anon', 'authenticated', 'service_role'):
            if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                conn.execute(f'CREATE ROLE {role}')
        conn.execute('CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE public.user_profiles(id uuid,credits integer)')
        conn.execute('CREATE TABLE public.generations(id uuid PRIMARY KEY,user_id text,user_type text,endpoint text,status text)')
        if hasattr(request, 'param'):
            conn.execute("INSERT INTO auth.users VALUES('00000000-0000-0000-0000-000000000001')")
            conn.execute("INSERT INTO user_profiles VALUES('00000000-0000-0000-0000-000000000001',%s)", (request.param,))
        with conn.transaction():
            conn.execute(MIGRATION.read_text())
        conn.execute('UPDATE billing_settings SET enabled=true')
        yield conn


def owner(db, bonus=0):
    uid = str(uuid4())
    db.execute('INSERT INTO auth.users VALUES(%s)', (uid,))
    db.execute('SELECT billing_account(%s,true)', (uid,))
    db.execute('UPDATE billing_accounts SET bonus_remaining=%s WHERE user_id=%s', (bonus, uid))
    return uid


def wallet(db, uid, live=True):
    return db.execute('SELECT * FROM billing_account(%s,%s)', (uid, live)).fetchone()


def generate(db, uid, endpoint='novaToBricks', live=True):
    gid = str(uuid4())
    db.execute("INSERT INTO generations VALUES(%s,%s,'authenticated',%s,'started',%s)", (gid, uid, endpoint, live))
    return gid


def paid(db, uid, invoice='in_1', plan='builder', amount=30, version=1, start=None, end=None, status='active', cancel=False, sub='sub_1'):
    db.execute("UPDATE billing_accounts SET stripe_customer_id='cus_1' WHERE user_id=%s", (uid,))
    return db.execute("""SELECT * FROM billing_sync_subscription(%s,true,'cus_1',%s,%s,%s,%s,%s,
        coalesce(%s::timestamptz,now()-interval '1 hour'),coalesce(%s::timestamptz,now()+interval '1 month'),%s,%s)""",
        (uid,sub,status,cancel,version,plan,start,end,invoice,amount)).fetchone()


def test_atomic_credit_admission_cannot_overdraw_and_uses_monthly_first(db, server):
    uid = owner(db, bonus=2)
    def attempt(_):
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            try:
                generate(conn, uid)
                return True
            except psycopg.errors.RaiseException as e:
                assert 'BB_CREDITS_EXHAUSTED' in str(e)
                return False
    with ThreadPoolExecutor(max_workers=12) as workers:
        assert sum(workers.map(attempt, range(16))) == 7
    assert wallet(db, uid)['monthly_remaining'] == wallet(db, uid)['bonus_remaining'] == 0
    rows = db.execute("SELECT bucket,count(*) n FROM billing_credit_history GROUP BY bucket").fetchall()
    assert {r['bucket']:r['n'] for r in rows} == {'monthly':5, 'bonus':2}
    for endpoint in ('resizeModel','updateModel','uploadLdraw'):
        generate(db, uid, endpoint)


def test_failure_and_cancellation_refund_only_once_and_not_after_reset(db):
    uid = owner(db)
    gid = generate(db, uid)
    db.execute("UPDATE generations SET status='failed' WHERE id=%s", (gid,))
    db.execute("UPDATE generations SET status='processing' WHERE id=%s", (gid,))
    db.execute("UPDATE generations SET status='cancelled' WHERE id=%s", (gid,))
    assert wallet(db, uid)['monthly_remaining'] == 5
    old = generate(db, uid)
    db.execute("UPDATE billing_accounts SET period_end=now()-interval '1 day',period_start=now()-interval '2 months' WHERE user_id=%s", (uid,))
    assert wallet(db, uid)['monthly_remaining'] == 5
    # Original reservation had the same free-month start. Simulate an older month.
    db.execute("UPDATE billing_credit_history SET period_start=now()-interval '2 months' WHERE reference=%s", (old,))
    db.execute("UPDATE generations SET status='failed' WHERE id=%s", (old,))
    assert wallet(db, uid)['monthly_remaining'] == 5


def test_paid_invoice_replays_upgrades_and_renewal_do_not_mint_extra_credits(db):
    uid = owner(db, bonus=100)
    first = paid(db, uid)
    generate(db, uid)
    replay = paid(db, uid, version=2, start=first['period_start'], end=first['period_end'])
    assert replay['monthly_remaining'] == 29
    upgraded = paid(db, uid, invoice='in_upgrade', plan='creator', amount=100, version=3, start=first['period_start'], end=first['period_end'])
    assert upgraded['monthly_remaining'] == 99
    paid(db, uid, invoice='in_downgrade', plan='builder', amount=30, version=4, start=first['period_start'], end=first['period_end'])
    repeated = paid(db, uid, invoice='in_reupgrade', plan='creator', amount=100, version=5, start=first['period_start'], end=first['period_end'])
    assert repeated['monthly_remaining'] == 99
    next_start = db.execute("SELECT now() AS d").fetchone()['d']
    renewed = paid(db, uid, invoice='in_renewal', plan='creator', amount=100, version=6, start=next_start)
    assert renewed['monthly_remaining'] == 100 and renewed['bonus_remaining'] == 100


def test_unpaid_expiry_cancel_and_stale_events_preserve_correct_entitlements(db):
    uid = owner(db, bonus=7)
    first = paid(db, uid)
    scheduled = paid(db, uid, invoice=None, amount=None, version=2, cancel=True)
    assert scheduled['cancel_at_period_end'] and scheduled['monthly_remaining'] == 30
    past_due = paid(db, uid, invoice=None, amount=None, status='past_due', version=3)
    assert past_due['monthly_remaining'] == 30
    db.execute("UPDATE billing_accounts SET period_end=now()-interval '1 second' WHERE user_id=%s", (uid,))
    generate(db, uid)
    assert wallet(db, uid)['bonus_remaining'] == 6  # expired monthly credits cannot be spent
    canceled = paid(db, uid, invoice=None, amount=None, status='canceled', version=4)
    assert canceled['plan_key']=='free' and canceled['monthly_remaining']==5
    replay = paid(db, uid, version=1, start=first['period_start'], end=first['period_end'])
    assert replay['plan_key']=='free' and replay['bonus_remaining']==6


def test_wallets_are_isolated_and_clients_cannot_write_or_invoke_grants(db):
    uid=owner(db)
    generate(db, uid, live=False)
    assert wallet(db, uid)['monthly_remaining']==5
    assert wallet(db, uid, False)['monthly_remaining']==4
    for role in ('anon','authenticated'):
        assert not db.execute("SELECT has_table_privilege(%s,'billing_accounts','UPDATE') p", (role,)).fetchone()['p']
        assert not db.execute("SELECT has_table_privilege(%s,'generations','UPDATE') p", (role,)).fetchone()['p']
        assert not db.execute("SELECT has_function_privilege(%s,'billing_account(uuid,boolean)','EXECUTE') p", (role,)).fetchone()['p']
    assert db.execute('SELECT billing_checkout_lock(%s,true,true) p', (uid,)).fetchone()['p']
    assert not db.execute('SELECT billing_checkout_lock(%s,true,true) p', (uid,)).fetchone()['p']
    db.execute('SELECT billing_checkout_lock(%s,true,false)', (uid,))
    assert db.execute('SELECT billing_checkout_lock(%s,true,true) p', (uid,)).fetchone()['p']


def test_bonus_refunds_survive_a_month_change_and_invalid_plans_roll_back(db):
    uid=owner(db, bonus=1)
    db.execute('UPDATE billing_accounts SET monthly_remaining=0 WHERE user_id=%s',(uid,))
    gid=generate(db,uid)
    db.execute("UPDATE billing_accounts SET period_end=now()-interval '1 day' WHERE user_id=%s",(uid,))
    db.execute("UPDATE generations SET status='cancelled' WHERE id=%s",(gid,))
    assert wallet(db,uid)['bonus_remaining']==1
    with pytest.raises(psycopg.errors.RaiseException,match='BILLING_INVALID_PLAN'):
        paid(db,uid,amount=999)
    assert wallet(db,uid)['plan_key']=='free'


@pytest.mark.parametrize('db', [100], indirect=True)
def test_existing_balances_are_preserved_once_as_live_bonus_credits(db):
    uid='00000000-0000-0000-0000-000000000001'
    assert wallet(db,uid)['bonus_remaining']==100
    assert wallet(db,uid)['monthly_remaining']==5
    assert wallet(db,uid,False)['bonus_remaining']==0
    assert db.execute("SELECT count(*) n FROM billing_credit_history WHERE kind='welcome'").fetchone()['n']==1


def test_verified_internal_developer_identity_does_not_need_a_customer_wallet(db):
    generate(db,'developer')
    assert db.execute('SELECT count(*) n FROM billing_accounts').fetchone()['n']==0
