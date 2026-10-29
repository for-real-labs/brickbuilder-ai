from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest

from test_billing_credits import db, server, wallet, generate, MIGRATION
from test_apple_billing_database import migrate


@pytest.fixture
def referrals(db):
    migrate(db)
    db.execute((MIGRATION.parent/'20261027010000_credit_packs.sql').read_text())
    db.execute("ALTER TABLE auth.users ADD COLUMN created_at timestamptz DEFAULT clock_timestamp(), ADD COLUMN raw_user_meta_data jsonb DEFAULT '{}'::jsonb")
    db.execute("CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$")
    db.execute((MIGRATION.parent/'20261029000000_account_referrals.sql').read_text())
    return db


def account(db, confirmed=True, visit=None, anonymous=False):
    uid = uuid4()
    db.execute('INSERT INTO auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data) VALUES(%s,%s,CASE WHEN %s THEN clock_timestamp() END,%s,%s)',
               (uid, f'{uid}@example.test', confirmed, anonymous, Jsonb({'referral_visit': str(visit)} if visit else {})))
    return uid


def visit(db, referrer):
    return db.execute('SELECT begin_referral_visit(%s) id', (referrer,)).fetchone()['id']


def claim(db, user, receipt):
    db.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (str(user),))
    return db.execute('SELECT claim_account_referral(%s) awarded', (receipt,)).fetchone()['awarded']


def test_email_confirmation_awards_once_and_reward_is_spendable(referrals):
    db = referrals
    sender = account(db)
    receipt = visit(db, sender)
    newcomer = account(db, confirmed=False, visit=receipt)
    assert wallet(db, sender)['apple_remaining'] == 0
    db.execute('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=%s', (newcomer,))
    assert wallet(db, sender)['apple_remaining'] == 300
    assert claim(db, newcomer, receipt) is False
    db.execute('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=%s', (newcomer,))
    assert wallet(db, sender)['apple_remaining'] == 300
    ledger = db.execute("SELECT kind,amount,bucket FROM billing_credit_history WHERE kind='referral'").fetchall()
    assert ledger == [{'kind': 'referral', 'amount': 300, 'bucket': 'apple'}]
    db.execute('UPDATE billing_accounts SET monthly_remaining=0 WHERE user_id=%s', (sender,))
    generate(db, str(sender), 'novaToBricks')
    assert wallet(db, sender)['apple_remaining'] == 285


def test_oauth_claim_and_immediately_confirmed_signup(referrals):
    db = referrals
    sender = account(db)
    receipt = visit(db, sender)
    newcomer = account(db)
    assert claim(db, newcomer, receipt) is True
    account(db, visit=visit(db, sender))
    assert wallet(db, sender)['apple_remaining'] == 600
    assert wallet(db, sender, False)['apple_remaining'] == 0


def test_rejects_existing_self_guest_unverified_expired_and_missing(referrals):
    db = referrals
    sender = account(db)
    existing = account(db)
    receipt = visit(db, sender)
    assert claim(db, existing, receipt) is False
    assert claim(db, sender, receipt) is False
    assert claim(db, account(db, anonymous=True), receipt) is False
    assert claim(db, account(db, confirmed=False), receipt) is False
    assert claim(db, account(db), uuid4()) is False
    assert visit(db, uuid4()) is None
    assert visit(db, account(db, anonymous=True)) is None
    assert visit(db, account(db, confirmed=False)) is None
    db.execute("UPDATE referral_visits SET created_at=now()-interval '31 days' WHERE id=%s", (receipt,))
    assert claim(db, account(db), receipt) is False
    assert wallet(db, sender)['apple_remaining'] == 0


def test_parallel_claims_cannot_reward_twice_or_change_sender(referrals, server):
    db = referrals
    senders = [account(db), account(db)]
    receipts = [visit(db, sender) for sender in senders]
    newcomer = account(db)
    def attempt(index):
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            conn.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (str(newcomer),))
            return conn.execute('SELECT claim_account_referral(%s)', (receipts[index % 2],)).fetchone()[0]
    with ThreadPoolExecutor(max_workers=6) as pool:
        assert sum(pool.map(attempt, range(12))) == 1
    assert sum(wallet(db, sender)['apple_remaining'] for sender in senders) == 300


def test_public_permissions_and_auth_identity(referrals):
    db = referrals
    sender = account(db)
    db.execute('GRANT USAGE ON SCHEMA public,auth TO anon,authenticated')
    db.execute('SET ROLE anon')
    try:
        receipt = visit(db, sender)
        assert receipt
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM referral_visits')
        with pytest.raises(psycopg.errors.InsufficientPrivilege): claim(db, sender, receipt)
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT award_account_referral(%s,%s)', (sender,receipt))
    finally: db.execute('RESET ROLE')
    newcomer = account(db)
    db.execute('SET ROLE authenticated')
    try:
        assert claim(db, newcomer, receipt) is True
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM referral_rewards')
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT award_account_referral(%s,%s)', (sender,receipt))
    finally: db.execute('RESET ROLE')
    # Account deletion still cascades; deleting a sender cannot block another user.
    db.execute('DELETE FROM auth.users WHERE id=%s', (sender,))
    assert db.execute('SELECT referrer_id FROM referral_rewards').fetchone()['referrer_id'] is None
