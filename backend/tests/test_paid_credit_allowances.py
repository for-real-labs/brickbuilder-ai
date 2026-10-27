import pytest
from test_billing_credits import db, server, owner, wallet, paid, MIGRATION
from test_apple_billing_database import migrate as apple_migrate, purchase


def apply_allowances(db):
    db.execute((MIGRATION.parent / '20261027000000_paid_credit_allowances.sql').read_text())


@pytest.mark.parametrize('plan,old,new', [('builder',500,800), ('creator',750,1500)])
def test_existing_web_usage_preserved_and_invoice_replay_is_idempotent(db, plan, old, new):
    apple_migrate(db)
    uid = owner(db)
    first = paid(db,uid,plan=plan,amount=old)
    db.execute('UPDATE billing_accounts SET monthly_remaining=monthly_remaining-30 WHERE user_id=%s',(uid,))
    apply_allowances(db)
    assert wallet(db,uid)['monthly_remaining'] == new-30
    assert wallet(db,uid)['monthly_credits'] == new
    repeated = paid(db,uid,plan=plan,amount=new,version=2,start=first['period_start'],end=first['period_end'])
    assert repeated['monthly_remaining'] == new-30
    # The previous backend remains compatible during rollout.
    repeated = paid(db,uid,plan=plan,amount=old,version=3,start=first['period_start'],end=first['period_end'])
    assert repeated['monthly_remaining'] == new-30


def test_new_web_purchase_preserves_free_balance(db):
    apple_migrate(db); apply_allowances(db)
    uid = owner(db)
    result = paid(db,uid,amount=800)
    assert result['monthly_credits'] == 800
    assert result['monthly_remaining'] == 1100


def test_apple_history_keeps_original_allowance_and_new_renewals_receive_increase(db):
    apple_migrate(db); uid = owner(db)
    purchase(db,uid,start='2026-01-01',end='2026-02-01')
    apply_allowances(db)
    purchase(db,uid,version=2,start='2026-01-01',end='2026-02-01')
    assert wallet(db,uid)['apple_remaining'] == 500
    purchase(db,uid,tx='renewal',version=3)
    assert wallet(db,uid)['apple_remaining'] == 1300
    purchase(db,uid,tx='renewal',version=3)
    assert wallet(db,uid)['apple_remaining'] == 1300
    purchase(db,uid,tx='renewal',version=4,revoked=True)
    assert wallet(db,uid)['apple_remaining'] == 500


def test_late_apple_history_uses_allowance_at_purchase_date(db):
    apple_migrate(db); apply_allowances(db); uid = owner(db)
    purchase(db,uid,start='2026-01-01',end='2026-02-01')
    assert wallet(db,uid)['apple_remaining'] == 500
