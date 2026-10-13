from pathlib import Path

import pgserver
import psycopg
import pytest

MIGRATION = (Path(__file__).resolve().parents[2] /
             'supabase/migrations/20261013000000_order_cancellation.sql').read_text()


@pytest.fixture(scope='module')
def cancellation_server(tmp_path_factory):
    server = pgserver.get_server(tmp_path_factory.mktemp('order-cancellation'))
    try:
        yield server
    finally:
        server.cleanup()


@pytest.fixture
def db(cancellation_server):
    with psycopg.connect(cancellation_server.get_uri(), autocommit=True) as connection:
        connection.execute('DROP TABLE IF EXISTS public.orders')
        connection.execute('''CREATE TABLE public.orders (
            id bigint PRIMARY KEY, fulfilled boolean DEFAULT false,
            amount_paid text, stripe_payment_intent text
        )''')
        yield connection


def test_migration_preserves_history_and_new_orders_default_to_active(db):
    db.execute("INSERT INTO public.orders VALUES (1, false, '171.60', 'pi_original'), (2, true, '171.60', 'pi_replacement')")
    db.execute(MIGRATION)
    assert db.execute('SELECT * FROM public.orders ORDER BY id').fetchall() == [
        (1, False, '171.60', 'pi_original', False),
        (2, True, '171.60', 'pi_replacement', False),
    ]
    assert db.execute('INSERT INTO public.orders (id) VALUES (3) RETURNING fulfilled, cancelled').fetchone() == (False, False)
    db.execute('UPDATE public.orders SET cancelled = true WHERE id = 1')
    assert db.execute('SELECT fulfilled, cancelled FROM public.orders ORDER BY id').fetchall() == [
        (False, True), (True, False), (False, False),
    ]


@pytest.mark.parametrize('statement', [
    'INSERT INTO public.orders (id, fulfilled, cancelled) VALUES (1, true, true)',
    'UPDATE public.orders SET fulfilled = true WHERE id = 2',
    'UPDATE public.orders SET cancelled = true WHERE id = 3',
])
def test_order_cannot_be_both_cancelled_and_fulfilled(db, statement):
    db.execute(MIGRATION)
    db.execute('INSERT INTO public.orders (id, fulfilled, cancelled) VALUES (2, false, true), (3, true, false)')
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(statement)


def test_migration_is_idempotent_and_handles_historical_null_fulfillment(db):
    db.execute('INSERT INTO public.orders (id, fulfilled) VALUES (1, NULL)')
    db.execute(MIGRATION)
    db.execute('UPDATE public.orders SET cancelled = true WHERE id = 1')
    db.execute(MIGRATION)
    assert db.execute('SELECT fulfilled, cancelled FROM public.orders').fetchone() == (None, True)
    assert db.execute("SELECT count(*) FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_not_cancelled_and_fulfilled'").fetchone() == (1,)
