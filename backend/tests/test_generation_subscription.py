"""Exercise the subscription migration against real PostgreSQL."""

import psycopg
import pytest

from test_billing_credits import MIGRATION, db, generate, owner, paid, server, wallet
from test_guest_credits import guest, used
from test_monthly_plans_v4 import migrate


@pytest.fixture
def subscription_db(db):
    migrate(db)
    db.execute((MIGRATION.parent / '20261104010000_require_generation_subscription.sql').read_text())
    return db


def test_unsubscribed_and_guest_ai_requests_are_rejected_without_charges(subscription_db):
    conn = subscription_db
    user = owner(conn, bonus=5)
    conn.execute("UPDATE billing_accounts SET apple_remaining=123 WHERE user_id=%s", (user,))
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        generate(conn, user, 'llmToBricks')
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        guest(conn, 'novaToBricks')
    assert wallet(conn, user)['monthly_credits'] == 0
    assert wallet(conn, user)['apple_remaining'] == 123
    assert used(conn) == 0
    assert conn.execute('SELECT count(*) AS n FROM generations').fetchone()['n'] == 0


def test_paid_periods_can_generate_and_charge_credits(subscription_db):
    conn = subscription_db
    web = owner(conn)
    paid(conn, web, amount=225, cancel=True)
    generate(conn, web, 'llmToBricks')
    assert wallet(conn, web)['monthly_remaining'] == 223
    apple = owner(conn)
    conn.execute("""UPDATE billing_accounts SET apple_plan='builder',
      apple_expires_at=now()+interval '1 day', apple_remaining=225 WHERE user_id=%s""", (apple,))
    generate(conn, apple, 'novaToBricks')
    assert wallet(conn, apple)['apple_remaining'] == 205
    paid(conn, web, invoice=None, amount=None, status='canceled', version=2)
    assert wallet(conn, web)['monthly_remaining'] == 0
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        generate(conn, web)


def test_non_ai_file_tools_still_work_without_a_subscription(subscription_db):
    conn = subscription_db
    user = owner(conn)
    for endpoint in ('uploadLdraw', 'glbToBricks', 'objToBricks', 'resizeModel', 'updateModel'):
        generate(conn, user, endpoint)
    assert wallet(conn, user)['monthly_remaining'] == 0
    assert conn.execute("SELECT count(*) AS n FROM billing_credit_history WHERE kind='generation'").fetchone()['n'] == 0


@pytest.fixture
def tester_db(subscription_db):
    subscription_db.execute((MIGRATION.parent / '20261104030000_external_testers.sql').read_text())
    return subscription_db


def test_external_tester_requires_verified_email_and_is_scoped_to_billing_mode(tester_db):
    conn = tester_db
    user = owner(conn)
    conn.execute("UPDATE auth.users SET email='Tester@Example.com' WHERE id=%s", (user,))
    conn.execute("INSERT INTO external_testers(email) VALUES ('tester@example.com')")
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        generate(conn, user)

    conn.execute('UPDATE auth.users SET email_confirmed_at=now() WHERE id=%s', (user,))
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        generate(conn, user, live=False)

    generate(conn, user)
    row = wallet(conn, user)
    assert row['external_tester']
    assert row['monthly_credits'] == 225
    assert row['monthly_remaining'] == 223
    assert row['stripe_subscription_id'] is None

    conn.execute("UPDATE billing_accounts SET period_end=now()-interval '1 second', apple_remaining=50 WHERE user_id=%s", (user,))
    assert wallet(conn, user)['monthly_remaining'] == 225
    assert wallet(conn, user)['apple_remaining'] == 50

    conn.execute("DELETE FROM external_testers WHERE email='tester@example.com'")
    with pytest.raises(psycopg.errors.RaiseException, match='BB_SUBSCRIPTION_REQUIRED'):
        generate(conn, user)
    row = wallet(conn, user)
    assert not row['external_tester']
    assert row['monthly_remaining'] == 0
    assert row['apple_remaining'] == 50


def test_external_list_preserves_existing_paid_subscription_and_is_private(tester_db):
    conn = tester_db
    user = owner(conn)
    conn.execute("UPDATE auth.users SET email='paid@example.com',email_confirmed_at=now() WHERE id=%s", (user,))
    paid(conn, user, plan='creator', amount=1500)
    conn.execute("INSERT INTO external_testers(email) VALUES ('paid@example.com')")
    generate(conn, user)
    row = wallet(conn, user)
    assert not row['external_tester']
    assert row['plan_key'] == 'creator'
    assert row['monthly_remaining'] == 1498
    for role in ('anon', 'authenticated'):
        for privilege in ('SELECT', 'INSERT', 'DELETE'):
            assert not conn.execute("SELECT has_table_privilege(%s,'external_testers',%s) AS allowed",
                                    (role, privilege)).fetchone()['allowed']
