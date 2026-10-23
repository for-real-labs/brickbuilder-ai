"""Retry cost controls use the same PostgreSQL admission path as real builds."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from uuid import uuid4

import psycopg
import pytest

from test_billing_credits import db, server, owner, wallet, paid, generate, MIGRATION
from test_guest_credits import migrate as migrate_guest, guest, used, NETWORK
from src.utils.generation_retry_guard import retry_guard_error

RETRY_MIGRATION = MIGRATION.parent / '20261023030000_generation_retry_guard.sql'


def migrate(db):
    migrate_guest(db)
    db.execute(RETRY_MIGRATION.read_text())
    db.execute((MIGRATION.parent / '20261022010000_generation_concurrency_limit_1.sql').read_text())


def finish(db, gid, status='failed'):
    db.execute('UPDATE generations SET status=%s WHERE id=%s', (status, gid))


@pytest.mark.parametrize('plan', ['guest', 'free', 'builder', 'creator', 'master'])
@pytest.mark.parametrize('endpoint', ['llmToBricks', 'novaToBricks'])
def test_three_failures_or_cancellations_pause_every_plan_without_revoking_refunds(db, plan, endpoint):
    migrate(db)
    uid = owner(db)
    if plan not in ('guest', 'free'):
        paid(db, uid, plan=plan, amount={'builder': 500, 'creator': 750, 'master': 1000}[plan])
    allowance = wallet(db, uid)['monthly_remaining']
    build = lambda: guest(db, endpoint) if plan == 'guest' else generate(db, uid, endpoint)
    for status in ['failed', 'cancelled', 'failed']:
        finish(db, build(), status)
    with pytest.raises(psycopg.errors.RaiseException, match=r'BB_GENERATION_RETRY_LIMIT:\d+'):
        build()
    assert wallet(db, uid)['monthly_remaining'] == allowance
    assert used(db) == used(db, 'network:' + NETWORK) == 0
    assert db.execute('SELECT count(*) n FROM generations').fetchone()['n'] == 3
    assert db.execute('SELECT sum(amount) n FROM billing_ai_reservations').fetchone()['n'] == 63


def test_guest_claims_deletion_and_status_replays_do_not_reset_or_extend_the_pause(db):
    migrate(db)
    uid = owner(db)
    for _ in range(3):
        gid = guest(db)
        finish(db, gid)
        for state in ['processing', 'failed', 'cancelled']:
            finish(db, gid, state)
        db.execute("UPDATE generations SET user_id=%s,user_type='authenticated' WHERE id=%s", (uid, gid))
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts').fetchone()['n'] == 9
    timestamps = db.execute('SELECT failed_at FROM generation_retry_attempts ORDER BY failed_at').fetchall()
    db.execute('DELETE FROM generations')
    assert db.execute('SELECT failed_at FROM generation_retry_attempts ORDER BY failed_at').fetchall() == timestamps
    for build in [lambda: generate(db, uid), lambda: guest(db, session='new_browser'),
                  lambda: guest(db, network='ip_v1_' + 'b' * 64)]:
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
            build()
    # Failed guest claims still leave all 300 Free credits available.
    assert wallet(db, uid)['monthly_remaining'] == 300


def test_cooldown_uses_the_exact_rolling_window_and_blocked_requests_do_not_extend_it(db):
    migrate(db)
    uid = owner(db)
    ids = [generate(db, uid)]
    finish(db, ids[0])
    for _ in range(2):
        ids.append(generate(db, uid))
        finish(db, ids[-1])
    db.execute("UPDATE generation_retry_attempts SET failed_at=now()-interval '23 hours' WHERE generation_id=%s", (ids[0],))
    expected = db.execute("SELECT ceil(extract(epoch FROM min(failed_at)+interval '24 hours')) n FROM generation_retry_attempts").fetchone()['n']
    for _ in range(2):
        with pytest.raises(psycopg.errors.RaiseException, match=f'BB_GENERATION_RETRY_LIMIT:{expected}'):
            generate(db, uid)
    db.execute("UPDATE generation_retry_attempts SET failed_at=now()-interval '25 hours' WHERE generation_id=%s", (ids[0],))
    gid = generate(db, uid)
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_PENDING'):
        generate(db, uid)
    finish(db, gid, 'completed')
    finish(db, generate(db, uid), 'cancelled')
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        generate(db, uid)


def test_parallel_browser_identities_cannot_spend_more_than_remaining_retry_slots(db, server):
    migrate(db)
    def attempt(i):
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            try:
                return guest(conn, session=f'new_browser_{i}')
            except psycopg.errors.RaiseException as error:
                assert 'BB_GENERATION_RETRY_PENDING' in str(error)
                return None
    with ThreadPoolExecutor(max_workers=12) as pool:
        ids = [gid for gid in pool.map(attempt, range(12)) if gid]
    assert len(ids) == 3
    assert db.execute('SELECT sum(amount) n FROM billing_ai_reservations').fetchone()['n'] == 63
    for gid in ids:
        finish(db, gid)
    assert used(db, 'network:' + NETWORK) == 0
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        guest(db, session='another_browser')


def test_successful_builds_release_slots_and_deleting_running_builds_keeps_a_strike(db):
    migrate(db)
    uid = owner(db)
    for _ in range(8):
        finish(db, generate(db, uid), 'completed')
    for _ in range(3):
        gid = generate(db, uid)
        db.execute('DELETE FROM generations WHERE id=%s', (gid,))
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        generate(db, uid)
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts WHERE failed_at IS NOT NULL').fetchone()['n'] == 3


def test_personal_keys_and_free_tools_work_during_a_pause_and_never_add_strikes(db):
    migrate(db)
    uid = owner(db)
    for _ in range(3):
        finish(db, generate(db, uid))
    for _ in range(4):
        gid = str(uuid4())
        db.execute("""INSERT INTO generations(id,user_id,user_type,endpoint,status,personal_billing,billing_policy_version)
            VALUES(%s,%s,'authenticated','novaToBricks','started',true,2)""", (gid, uid))
        finish(db, gid, 'cancelled')
    for endpoint in ['resizeModel', 'updateModel', 'uploadLdraw', 'glbToBricks', 'objToBricks']:
        finish(db, generate(db, uid, endpoint))
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts').fetchone()['n'] == 3
    assert wallet(db, uid)['monthly_remaining'] == 300


def test_quota_capacity_and_concurrency_rejections_leave_no_retry_reservation(db):
    migrate(db)
    uid = owner(db)
    db.execute('UPDATE billing_settings SET generation_budget_usd=1')
    with pytest.raises(psycopg.errors.RaiseException, match='BB_AI_CAPACITY'):
        guest(db)
    db.execute('UPDATE billing_settings SET generation_budget_usd=100000')
    db.execute('UPDATE billing_accounts SET monthly_remaining=0 WHERE user_id=%s', (uid,))
    with pytest.raises(psycopg.errors.RaiseException, match='BB_CREDITS_EXHAUSTED'):
        generate(db, uid)
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts').fetchone()['n'] == 0
    guest(db)
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'):
        guest(db)
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts').fetchone()['n'] == 2


def test_upgrade_and_monthly_reset_cannot_bypass_pause_but_live_and_sandbox_are_isolated(db):
    migrate(db)
    uid = owner(db)
    for _ in range(3):
        finish(db, generate(db, uid))
    paid(db, uid)
    db.execute("UPDATE billing_accounts SET period_start=now()-interval '1 month' WHERE user_id=%s", (uid,))
    db.execute('UPDATE billing_settings SET enabled=false')
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        generate(db, uid)
    generate(db, uid, live=False)


@pytest.mark.parametrize('missing_timestamp', [False, True])
def test_migration_backfills_known_history_and_ledger_is_private(db, missing_timestamp):
    migrate_guest(db)
    uid = owner(db)
    ids = []
    for _ in range(3):
        gid = guest(db)
        finish(db, gid)
        db.execute("UPDATE generations SET user_id=%s,user_type='authenticated' WHERE id=%s", (uid, gid))
        ids.append(gid)
    if missing_timestamp:
        db.execute('UPDATE generations SET created_at=NULL')
    db.execute(RETRY_MIGRATION.read_text())
    assert db.execute('SELECT count(*) n FROM generation_retry_attempts').fetchone()['n'] == 9
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        generate(db, uid)
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_RETRY_LIMIT'):
        guest(db, session='new_browser')
    for role in ('anon', 'authenticated'):
        assert not db.execute("SELECT has_table_privilege(%s,'generation_retry_attempts','SELECT,INSERT,UPDATE,DELETE') p", (role,)).fetchone()['p']
        assert not db.execute("SELECT has_function_privilege(%s,'enforce_generation_retry_guard()','EXECUTE') p", (role,)).fetchone()['p']


def test_public_error_exposes_exact_retry_time_without_private_state():
    expected = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=1)
    error = retry_guard_error(ValueError(f'BB_GENERATION_RETRY_LIMIT:{int(expected.timestamp())} private database context'))
    assert error.status_code == 429
    assert parsedate_to_datetime(error.headers['Retry-After']) == expected
    assert '3 failed or canceled attempts within 24 hours' in error.detail
    assert 'Upgrading does not remove this pause.' in error.detail
    assert 'private' not in error.detail
    pending = retry_guard_error(ValueError('BB_GENERATION_RETRY_PENDING'))
    assert pending.status_code == 429 and not pending.headers
    assert retry_guard_error(ValueError('unrelated')) is None


def test_a_cooldown_that_expires_in_transit_does_not_show_an_extra_day_of_waiting():
    before = datetime.now(timezone.utc).replace(microsecond=0)
    expired = int((before - timedelta(minutes=1)).timestamp())
    error = retry_guard_error(ValueError(f'BB_GENERATION_RETRY_LIMIT:{expired}'))
    assert before <= parsedate_to_datetime(error.headers['Retry-After']) <= before + timedelta(seconds=2)


@pytest.mark.parametrize('suffix', ['', ':bad', ':999999999999', ':1'])
def test_malformed_retry_dates_fall_back_to_a_safe_24_hour_message(suffix):
    before = datetime.now(timezone.utc).replace(microsecond=0)
    error = retry_guard_error(ValueError('BB_GENERATION_RETRY_LIMIT' + suffix))
    reset = parsedate_to_datetime(error.headers['Retry-After'])
    assert before + timedelta(hours=24) <= reset <= before + timedelta(hours=24, seconds=2)
