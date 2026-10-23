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
        conn.execute('CREATE TABLE public.generations(id uuid PRIMARY KEY,user_id text,user_type text,endpoint text,status text,created_at timestamptz DEFAULT now(),estimated_cost_usd numeric,ai_usage jsonb)')
        conn.execute('CREATE TABLE public.generation_guest_usage(user_id text PRIMARY KEY,attempts bigint); CREATE TABLE public.anonymous_users(ip_hash text PRIMARY KEY,identity_type text,call_count integer,first_call timestamptz,updated_at timestamptz DEFAULT now())')
        if hasattr(request, 'param'):
            conn.execute("INSERT INTO auth.users VALUES('00000000-0000-0000-0000-000000000001')")
            conn.execute("INSERT INTO user_profiles VALUES('00000000-0000-0000-0000-000000000001',%s)", (request.param,))
        with conn.transaction():
            conn.execute(MIGRATION.read_text())
            conn.execute((MIGRATION.parent/'20261023000000_billing_pricing_v2.sql').read_text())
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


def generate(db, uid, endpoint='llmToBricks', live=True):
    gid = str(uuid4())
    db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status,billing_livemode,billing_policy_version) VALUES(%s,%s,'authenticated',%s,'started',%s,2)", (gid, uid, endpoint, live))
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
    upgraded = paid(db, uid, invoice='in_upgrade', plan='creator', amount=75, version=3, start=first['period_start'], end=first['period_end'])
    assert upgraded['monthly_remaining'] == 74
    paid(db, uid, invoice='in_downgrade', plan='builder', amount=30, version=4, start=first['period_start'], end=first['period_end'])
    repeated = paid(db, uid, invoice='in_reupgrade', plan='creator', amount=75, version=5, start=first['period_start'], end=first['period_end'])
    assert repeated['monthly_remaining'] == 74
    next_start = db.execute("SELECT now() AS d").fetchone()['d']
    renewed = paid(db, uid, invoice='in_renewal', plan='creator', amount=75, version=6, start=next_start)
    assert renewed['monthly_remaining'] == 75 and renewed['bonus_remaining'] == 100


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


def test_all_parts_requires_paid_monthly_credits_and_refunds_fifteen(db):
    uid=owner(db,bonus=100)
    with pytest.raises(psycopg.errors.RaiseException,match='BB_PAID_MODE_REQUIRED'):
        generate(db,uid,'novaToBricks')
    paid(db,uid)
    first=generate(db,uid,'novaToBricks')
    generate(db,uid,'novaToBricks')
    with pytest.raises(psycopg.errors.RaiseException,match='BB_CREDITS_EXHAUSTED'):
        generate(db,uid,'novaToBricks')
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(first,))
    assert wallet(db,uid)['monthly_remaining']==15
    assert wallet(db,uid)['bonus_remaining']==100
    assert db.execute("SELECT amount FROM billing_ai_reservations WHERE reference=%s",(first,)).fetchone()['amount']==21


def test_legacy_bonus_redemption_is_basic_only_capped_and_resets_monthly(db):
    uid=owner(db,bonus=100)
    db.execute('UPDATE billing_accounts SET monthly_remaining=0 WHERE user_id=%s',(uid,))
    for _ in range(5): generate(db,uid)
    with pytest.raises(psycopg.errors.RaiseException,match='BB_CREDITS_EXHAUSTED'): generate(db,uid)
    assert wallet(db,uid)['bonus_remaining']==95
    db.execute("UPDATE billing_accounts SET bonus_period_start=now()-interval '2 months' WHERE user_id=%s",(uid,))
    generate(db,uid)
    assert wallet(db,uid)['bonus_used']==1
    assert wallet(db,uid)['bonus_remaining']==94


def test_budget_admission_is_atomic_and_rejected_request_spends_no_credits(db,server):
    db.execute('UPDATE billing_settings SET generation_budget_usd=42')
    uid=owner(db)
    def attempt(_):
        with psycopg.connect(server.get_uri(),autocommit=True) as conn:
            try: generate(conn,uid); return True
            except psycopg.errors.RaiseException as error:
                assert 'BB_AI_CAPACITY' in str(error); return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(attempt,range(8)))==2
    assert wallet(db,uid)['monthly_remaining']==3
    assert db.execute('SELECT sum(amount) AS total FROM billing_ai_reservations').fetchone()['total']==42


def test_only_final_success_releases_budget_and_late_usage_never_reduces_it(db):
    uid=owner(db)
    gid=generate(db,uid)
    db.execute("UPDATE generations SET status='completed',estimated_cost_usd=.2,ai_usage='{" + '"calls":[{}]' + "}'::jsonb WHERE id=%s",(gid,))
    assert db.execute('SELECT amount FROM billing_ai_reservations WHERE reference=%s',(gid,)).fetchone()['amount']==21
    db.execute("UPDATE generations SET ai_usage=ai_usage||'{" + '"finalized":true' + "}'::jsonb WHERE id=%s",(gid,))
    assert float(db.execute('SELECT amount FROM billing_ai_reservations WHERE reference=%s',(gid,)).fetchone()['amount'])==.2
    db.execute("UPDATE generations SET estimated_cost_usd=.4 WHERE id=%s",(gid,))
    db.execute("UPDATE generations SET estimated_cost_usd=.1 WHERE id=%s",(gid,))
    assert float(db.execute('SELECT amount FROM billing_ai_reservations WHERE reference=%s',(gid,)).fetchone()['amount'])==.4


def test_guest_is_basic_only_one_attempt_and_claim_counts_toward_free_month(db):
    uid=owner(db)
    gid=str(uuid4())
    with pytest.raises(psycopg.errors.RaiseException,match='BB_PAID_MODE_REQUIRED'):
        db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status,billing_policy_version) VALUES(%s,'guest','anonymous','novaToBricks','started',2)",(gid,))
    db.execute("SELECT reserve_guest_generation('guest','anonymous')")
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GENERATION_GUEST_LIMIT:1'):
        db.execute("SELECT reserve_guest_generation('guest','anonymous')")
    db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status,billing_policy_version) VALUES(%s,'guest','anonymous','llmToBricks','completed',2)",(gid,))
    db.execute("UPDATE generations SET user_id=%s,user_type='authenticated' WHERE id=%s",(uid,gid))
    db.execute("UPDATE generations SET user_id=%s,user_type='authenticated' WHERE id=%s",(uid,gid))
    assert wallet(db,uid)['monthly_remaining']==4
    assert db.execute("SELECT count(*) n FROM billing_credit_history WHERE reference=%s",(gid,)).fetchone()['n']==1


def test_monthly_budget_is_mode_isolated_and_cannot_be_called_by_browsers(db):
    db.execute('UPDATE billing_settings SET assistant_budget_usd=.1')
    db.execute("SELECT billing_reserve_ai('aux-1',true,'assistant',.1)")
    with pytest.raises(psycopg.errors.RaiseException,match='BB_AI_CAPACITY'):
        db.execute("SELECT billing_reserve_ai('aux-2',true,'assistant',.01)")
    db.execute("SELECT billing_reserve_ai('aux-2',false,'assistant',.01)")
    for role in ('anon','authenticated'):
        assert not db.execute("SELECT has_function_privilege(%s,'billing_reserve_ai(text,boolean,text,numeric)','EXECUTE') p",(role,)).fetchone()['p']
    db.execute("UPDATE billing_ai_reservations SET period_start=now()-interval '2 months'")
    db.execute("SELECT billing_reserve_ai('aux-3',true,'assistant',.1)")


def test_old_api_cannot_bypass_enabled_policy_and_switching_off_preserves_old_trial(db):
    with pytest.raises(psycopg.errors.RaiseException,match='BB_BILLING_VERSION'):
        db.execute("INSERT INTO generations(id,user_id,user_type,endpoint,status) VALUES(%s,'guest','anonymous','llmToBricks','started')",(str(uuid4()),))
    db.execute('UPDATE billing_settings SET enabled=false')
    for _ in range(3): db.execute("SELECT reserve_guest_generation('guest','anonymous')")
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GENERATION_GUEST_LIMIT:3'):
        db.execute("SELECT reserve_guest_generation('guest','anonymous')")
