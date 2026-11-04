"""Verify the new pricing policy on real PostgreSQL, including old charges."""
import psycopg
import pytest
from test_billing_credits import db, server, owner, wallet, generate, paid, MIGRATION
from test_guest_credits import migrate as guest_migrate, guest, used
from src.utils import billing


def migrate(db):
    guest_migrate(db)
    db.execute((MIGRATION.parent/'20261024010000_apple_subscriptions.sql').read_text())
    db.execute((MIGRATION.parent/'20261027000000_paid_credit_allowances.sql').read_text())
    db.execute((MIGRATION.parent/'20261101000000_monthly_plans_v4.sql').read_text())


def test_catalog():
    assert [(p['monthly_cents'],p['credits']) for p in billing.PLANS] == [(299,225),(1999,1500)]


def test_new_and_existing_allowances_preserve_spent_and_purchased_credits(db):
    uid=owner(db)
    db.execute('UPDATE billing_accounts SET monthly_remaining=280 WHERE user_id=%s',(uid,))
    migrate(db)
    assert wallet(db,uid)['monthly_remaining']==55
    assert wallet(db,owner(db))['monthly_remaining']==75
    result=paid(db,uid,amount=225)
    assert result['monthly_credits']==225 and result['monthly_remaining']==280
    canceled=paid(db,uid,invoice=None,amount=None,status='canceled',version=2)
    assert canceled['monthly_remaining']==75


@pytest.mark.parametrize('endpoint,cost', [('llmToBricks',2),('novaToBricks',20),('textToBricks',20),('imageToBricks',20),('promptEditModel',20)])
def test_costs_and_exactly_once_refunds(db,endpoint,cost):
    migrate(db); uid=owner(db)
    gid=generate(db,uid,endpoint)
    assert wallet(db,uid)['monthly_remaining']==75-cost
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(gid,))
    db.execute("UPDATE generations SET status='cancelled' WHERE id=%s",(gid,))
    assert wallet(db,uid)['monthly_remaining']==75


def test_one_hundred_credits_funds_exactly_five_all_parts_generations(db):
    migrate(db); uid=owner(db)
    db.execute('UPDATE billing_accounts SET monthly_remaining=100 WHERE user_id=%s',(uid,))
    for _ in range(5): generate(db,uid,'novaToBricks')
    assert wallet(db,uid)['monthly_remaining']==0
    with pytest.raises(psycopg.errors.RaiseException,match='BB_CREDITS_EXHAUSTED'):
        generate(db,uid,'novaToBricks')


def test_guest_costs_and_legacy_bonus_cannot_overdraw(db):
    migrate(db)
    for _ in range(3): guest(db)
    for _ in range(7): guest(db,'llmToBricks')
    assert used(db)==74
    with pytest.raises(psycopg.errors.RaiseException,match='BB_GUEST_CREDITS_EXHAUSTED'): guest(db,'llmToBricks')
    uid=owner(db,bonus=5)
    db.execute('UPDATE billing_accounts SET monthly_remaining=0 WHERE user_id=%s',(uid,))
    for _ in range(2): generate(db,uid)
    assert wallet(db,uid)['bonus_remaining']==1
    with pytest.raises(psycopg.errors.RaiseException,match='BB_CREDITS_EXHAUSTED'): generate(db,uid)


def test_old_guest_charge_is_not_repriced_on_claim_or_refund(db):
    guest_migrate(db)
    gid=guest(db)
    db.execute((MIGRATION.parent/'20261024010000_apple_subscriptions.sql').read_text())
    db.execute((MIGRATION.parent/'20261027000000_paid_credit_allowances.sql').read_text())
    db.execute((MIGRATION.parent/'20261101000000_monthly_plans_v4.sql').read_text())
    uid=owner(db)
    db.execute("UPDATE generations SET user_id=%s,user_type='authenticated' WHERE id=%s",(uid,gid))
    assert wallet(db,uid)['monthly_remaining']==60
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(gid,))
    assert wallet(db,uid)['monthly_remaining']==75
    assert used(db)==0


def test_existing_paid_allowance_reduces_without_resetting_usage(db):
    guest_migrate(db)
    db.execute((MIGRATION.parent/'20261024010000_apple_subscriptions.sql').read_text())
    db.execute((MIGRATION.parent/'20261027000000_paid_credit_allowances.sql').read_text())
    uid=owner(db); paid(db,uid,amount=800)
    db.execute('UPDATE billing_accounts SET monthly_remaining=770,apple_remaining=123 WHERE user_id=%s',(uid,))
    db.execute((MIGRATION.parent/'20261101000000_monthly_plans_v4.sql').read_text())
    row=wallet(db,uid)
    assert row['monthly_credits']==225 and row['monthly_remaining']==195
    assert row['apple_remaining']==123
