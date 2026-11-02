import pytest
import psycopg
from test_billing_credits import db, server, owner, wallet, generate, MIGRATION
from test_apple_billing_database import migrate


def grant(db, uid, version=1, amount=800):
    db.execute("SELECT billing_apply_credit_pack(%s,true,'stripe:pi_test','builder',%s,%s)",(uid,version,amount))


def test_purchases_replay_refund_debt_reversal_and_generation(db):
    migrate(db)
    db.execute((MIGRATION.parent/'20261027010000_credit_packs.sql').read_text())
    uid=owner(db)
    grant(db,uid); grant(db,uid)
    assert wallet(db,uid)['apple_remaining']==800
    assert wallet(db,uid)['apple_plan'] is None
    db.execute('UPDATE billing_accounts SET monthly_remaining=0')
    gid=generate(db,uid)
    grant(db,uid,3,0); grant(db,uid,2)
    assert wallet(db,uid)['apple_remaining']==-1
    grant(db,uid,4); grant(db,uid,5)
    assert wallet(db,uid)['apple_remaining']==799
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(gid,))
    assert wallet(db,uid)['apple_remaining']==800
    other=owner(db)
    with pytest.raises(psycopg.errors.RaiseException,match='OWNER_MISMATCH'): grant(db,other,6)
    db.execute('GRANT USAGE ON SCHEMA public TO authenticated; SET ROLE authenticated')
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege): grant(db,uid,7)
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM billing_credit_purchases')
    finally: db.execute('RESET ROLE')


def test_custom_purchase_limit_replay_and_refund_preserve_the_ledger(db):
    migrate(db)
    db.execute((MIGRATION.parent/'20261027010000_credit_packs.sql').read_text())
    db.execute((MIGRATION.parent/'20261102010000_custom_credit_purchases.sql').read_text())
    uid=owner(db)
    def custom(version, amount, transaction='stripe:pi_custom'):
        db.execute("SELECT billing_apply_credit_pack(%s,true,%s,'custom',%s,%s)",(uid,transaction,version,amount))
    custom(1,753); custom(1,753)
    assert wallet(db,uid)['apple_remaining']==753
    custom(2,376)
    assert wallet(db,uid)['apple_remaining']==376
    custom(1,753)
    assert wallet(db,uid)['apple_remaining']==376
    custom(3,753)
    assert wallet(db,uid)['apple_remaining']==753
    with pytest.raises(psycopg.errors.RaiseException,match='INVALID_CREDIT_PURCHASE'): custom(4,752509)
    with pytest.raises(psycopg.errors.RaiseException,match='INVALID_CREDIT_PURCHASE'): custom(4,753,'apple:production:123')
