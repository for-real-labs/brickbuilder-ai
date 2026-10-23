import pytest
import psycopg
from test_billing_credits import db, server, owner, wallet, generate, MIGRATION


def migrate(db):
    db.execute('ALTER TABLE generations ADD COLUMN personal_billing boolean NOT NULL DEFAULT false')
    db.execute((MIGRATION.parent/'20261024000000_apple_subscriptions.sql').read_text())


def purchase(db, uid, tx='1', version=1, revoked=False, upgraded=False, plan='builder', start=None, end=None):
    db.execute("""SELECT billing_apply_apple_transaction(%s,true,%s,'original',%s,
        coalesce(%s::timestamptz,now()-interval '1 hour'),coalesce(%s::timestamptz,now()+interval '1 month'),%s,%s,%s,%s)""", (uid,tx,plan,start,end,version,revoked,upgraded,500 if plan=='builder' else 750))


def test_renewal_replay_rollover_and_expiry(db):
    migrate(db); uid=owner(db)
    purchase(db,uid,start='2026-01-01',end='2026-02-01'); purchase(db,uid,start='2026-01-01',end='2026-02-01')
    assert wallet(db,uid)['apple_remaining']==500
    purchase(db,uid,tx='2')
    assert wallet(db,uid)['apple_remaining']==1000
    db.execute("UPDATE billing_accounts SET monthly_remaining=0,apple_expires_at=now()-interval '1 day'")
    generate(db,uid,'novaToBricks')
    assert wallet(db,uid)['apple_remaining']==985


def test_atomic_mixed_balance_and_refund_after_month_change(db):
    migrate(db); uid=owner(db); purchase(db,uid)
    db.execute('UPDATE billing_accounts SET monthly_remaining=5')
    gid=generate(db,uid,'novaToBricks')
    assert wallet(db,uid)['monthly_remaining']==0
    assert wallet(db,uid)['apple_remaining']==490
    db.execute("UPDATE billing_accounts SET period_start=now()+interval '1 day',monthly_remaining=300")
    db.execute("UPDATE generations SET status='failed' WHERE id=%s",(gid,))
    db.execute("UPDATE generations SET status='cancelled' WHERE id=%s",(gid,))
    assert wallet(db,uid)['apple_remaining']==500
    assert wallet(db,uid)['monthly_remaining']==300


def test_refund_revoke_replay_and_out_of_order_do_not_mint(db):
    migrate(db); uid=owner(db); purchase(db,uid)
    db.execute('UPDATE billing_accounts SET monthly_remaining=0')
    generate(db,uid)
    purchase(db,uid,version=3,revoked=True)
    assert wallet(db,uid)['apple_remaining']==-1
    assert wallet(db,uid)['apple_plan'] is None
    purchase(db,uid,version=3,revoked=True); purchase(db,uid,version=2)
    assert wallet(db,uid)['apple_remaining']==-1
    purchase(db,uid,tx='2',version=4)
    assert wallet(db,uid)['apple_remaining']==499


def test_original_subscription_owner_is_immutable_and_tables_private(db):
    migrate(db); uid=owner(db); other=owner(db); purchase(db,uid)
    with pytest.raises(psycopg.errors.RaiseException,match='APPLE_OWNER_MISMATCH'): purchase(db,other,tx='2')
    db.execute('GRANT USAGE ON SCHEMA public TO authenticated; SET ROLE authenticated')
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM billing_apple_transactions')
        with pytest.raises(psycopg.errors.InsufficientPrivilege): purchase(db,uid,tx='3')
    finally: db.execute('RESET ROLE')


def test_upgrade_cycle_and_out_of_order_history_converge(db):
    migrate(db); uid=owner(db)
    purchase(db,uid,tx='creator',plan='creator',start='2026-01-15',end='2026-02-15')
    purchase(db,uid,tx='builder',start='2026-01-01',end='2026-02-01',upgraded=True)
    assert wallet(db,uid)['apple_remaining']==750
    purchase(db,uid,tx='builder2',start='2026-01-16',end='2026-02-16',upgraded=True)
    purchase(db,uid,tx='creator2',plan='creator',start='2026-01-17',end='2026-02-17')
    assert wallet(db,uid)['apple_remaining']==750
    purchase(db,uid,tx='renewal',plan='creator',start='2026-02-17',end='2026-03-17')
    assert wallet(db,uid)['apple_remaining']==1500


def test_refund_reversal_restores_only_once(db):
    migrate(db); uid=owner(db); purchase(db,uid)
    purchase(db,uid,version=2,revoked=True)
    assert wallet(db,uid)['apple_remaining']==0
    purchase(db,uid,version=3); purchase(db,uid,version=4)
    assert wallet(db,uid)['apple_remaining']==500
