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
