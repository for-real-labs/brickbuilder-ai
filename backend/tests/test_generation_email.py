import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pgserver
import psycopg
import pytest
from fastapi import HTTPException

from src.requests import generationEmail as endpoint
from src.utils import generation_email as mail


@pytest.fixture
def email_config(monkeypatch):
    monkeypatch.setenv('GENERATION_NOTIFICATION_FROM', 'BrickBuilder <models@notifications.brickbuilder.ai>')
    monkeypatch.setenv('RESEND_API_KEY', 'test-only-key')
    monkeypatch.setenv('GENERATION_NOTIFICATION_ORIGIN', 'https://brickbuilder.ai')


@pytest.mark.parametrize('authenticated', [True, False])
def test_owner_enrollment_uses_account_email_or_guest_contact(monkeypatch, email_config, authenticated):
    profile_id = str(uuid4())
    row = {'id': str(uuid4()), 'status': 'processing', 'user_id': 'owner',
           'user_type': 'authenticated' if authenticated else 'anonymous'}
    client = Mock()
    def rpc(name, params):
        if name == 'subscribe_generation_email':
            row['notification_email'] = params['p_email']
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=True))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=None))
    client.rpc.side_effect = rpc
    client.auth.admin.create_user.return_value = SimpleNamespace(user=SimpleNamespace(id=profile_id))
    storage = SimpleNamespace(client=client, get_generation=AsyncMock(side_effect=lambda _: row))
    monkeypatch.setattr(endpoint, 'generation_storage', storage)
    auth = {'user_id': 'owner', 'authenticated': authenticated, 'user_email': 'account@example.com'}
    result = asyncio.run(endpoint.save_notification_email(row['id'], endpoint.NotificationEmailRequest(email='guest@example.com'), auth))
    assert result == {'subscribed': True}
    assert row['notification_email'] == ('account@example.com' if authenticated else 'guest@example.com')
    assert row['user_id'] == 'owner'  # Entering an email never grants/changes ownership.
    if not authenticated:
        client.auth.admin.create_user.assert_called_once_with({'email': 'guest@example.com', 'email_confirm': False})
        client.table.return_value.upsert.assert_called_once_with({'id': profile_id, 'email': 'guest@example.com'}, on_conflict='id', ignore_duplicates=True)
    else:
        client.auth.admin.create_user.assert_not_called()


def test_another_guest_cannot_enroll_or_read_subscription(monkeypatch, email_config):
    storage = SimpleNamespace(client=Mock(), get_generation=AsyncMock(return_value={'user_id': 'other', 'user_type': 'anonymous'}))
    monkeypatch.setattr(endpoint, 'generation_storage', storage)
    for action in [endpoint.notification_status('id', {'user_id':'mine'}), endpoint.save_notification_email('id', endpoint.NotificationEmailRequest(email='guest@example.com'), {'user_id':'mine'})]:
        with pytest.raises(HTTPException) as error:
            asyncio.run(action)
        assert error.value.status_code == 404
    storage.client.rpc.assert_not_called()


@pytest.mark.parametrize('status,expected', [(200,'sent'),(429,'pending'),(500,'pending'),(422,'failed')])
def test_durable_delivery_escapes_title_and_retries_only_transient_errors(email_config, status, expected):
    row={'generation_id': str(uuid4()), 'email':'delivered@resend.dev', 'origin':'https://brickbuilder.ai', 'title':'Ship <script>\nRed roof', 'attempts':1, 'lease_id':str(uuid4())}
    client=Mock()
    client.rpc.return_value.execute.return_value=SimpleNamespace(data=[row])
    seen=[]
    def respond(request):
        seen.append(request)
        return httpx.Response(status,json={'id':'resend-message'} if status==200 else {'error':'failure'})
    asyncio.run(mail.deliver_one(client,httpx.MockTransport(respond)))
    client.table.return_value.update.assert_called_once()
    update=client.table.return_value.update.call_args.args[0]
    assert update['state']==expected
    assert seen[0].headers['idempotency-key']=='generation-ready/'+row['generation_id']
    payload=mail.email_payload(row)
    assert '\n' not in payload['subject']
    assert '&lt;script&gt;' in payload['html']
    assert '<script>' not in payload['html']
    assert f"id={row['generation_id']}" in payload['text']
    assert 'exact=1' in payload['text']


def test_local_preview_does_not_deliver_shared_database_mail(monkeypatch,email_config):
    monkeypatch.delenv('RAILWAY_ENVIRONMENT_NAME',raising=False)
    monkeypatch.delenv('GENERATION_NOTIFICATION_WORKER',raising=False)
    assert mail.start_email_worker(Mock()) is None


@pytest.mark.parametrize('preview', [None, '', 'javascript:alert(1)', 'http://example.com/model.png', 'https://[invalid'])
def test_missing_or_unsafe_preview_keeps_completion_link(email_config, preview):
    payload = mail.email_payload({'generation_id': str(uuid4()), 'email': 'delivered@resend.dev',
                                 'origin': 'https://brickbuilder.ai', 'title': 'Pirate ship',
                                 'preview_image_url': preview})
    assert '<img' not in payload['html']
    assert 'See your model' in payload['html']


def test_preview_is_responsive_escaped_and_links_to_exact_generation(email_config):
    id = str(uuid4())
    payload = mail.email_payload({'generation_id': id, 'email': 'delivered@resend.dev',
                                 'origin': 'https://brickbuilder.ai', 'title': 'Ship "Red" <roof>',
                                 'preview_image_url': 'https://example.com/model.png?size=560&view="front"'})
    assert '<img src="https://example.com/model.png?size=560&amp;view=&quot;front&quot;"' in payload['html']
    assert 'alt="Preview of Ship &quot;Red&quot; &lt;roof&gt;"' in payload['html']
    assert 'max-width:560px;height:auto' in payload['html']
    assert payload['html'].count(f'id={id}&amp;exact=1') == 2


def test_database_completion_race_privacy_limits_and_lease_recovery(tmp_path):
    server=pgserver.get_server(tmp_path/'mail-db',cleanup_mode='delete')
    try:
        with psycopg.connect(server.get_uri(),autocommit=True) as db:
            for role in ['anon','authenticated','service_role']:
                db.execute(f'CREATE ROLE {role}')
            db.execute('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid,email text)')
            db.execute("CREATE TABLE public.generations(id uuid PRIMARY KEY,user_id text,status text,name text,preview_image_url text,updated_at timestamptz DEFAULT now())")
            db.execute('GRANT SELECT,INSERT,UPDATE ON public.generations TO anon,authenticated')
            # Supabase grants new functions explicitly to API roles by default.
            db.execute('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated')
            db.execute((Path(__file__).resolve().parents[2]/'supabase/migrations/20261005010000_generation_notification_email.sql').read_text())
            db.execute((Path(__file__).resolve().parents[2]/'supabase/migrations/20261005140000_generation_email_preview.sql').read_text())
            id=uuid4()
            db.execute("INSERT INTO generations(id,user_id,status,name) VALUES (%s,'owner','processing','Pirate ship')",(id,))
            assert db.execute("SELECT subscribe_generation_email(%s,'guest@example.com','https://brickbuilder.ai')",(id,)).fetchone()[0]
            assert db.execute('SELECT count(*) FROM generation_email_outbox').fetchone()[0]==0
            db.execute("UPDATE generations SET status='completed' WHERE id=%s",(id,))
            db.execute("UPDATE generations SET status='completed' WHERE id=%s",(id,))
            assert db.execute('SELECT count(*) FROM generation_email_outbox').fetchone()[0]==1
            # Concurrent/repeated clicks cannot change the recipient or send twice.
            db.execute("SELECT subscribe_generation_email(%s,'other@example.com','https://brickbuilder.ai')",(id,))
            assert db.execute('SELECT notification_email FROM generations').fetchone()[0]=='guest@example.com'
            assert db.execute("SELECT count(*) FROM claim_generation_email('other-origin')").fetchone()[0]==0
            # The preview can arrive after completion, before the first worker claim.
            db.execute("UPDATE generations SET preview_image_url='https://example.com/finished.png' WHERE id=%s",(id,))
            claimed=db.execute("SELECT attempts,preview_image_url FROM claim_generation_email('https://brickbuilder.ai')").fetchone()
            assert claimed==(1,'https://example.com/finished.png')
            assert db.execute("SELECT count(*) FROM claim_generation_email('https://brickbuilder.ai')").fetchone()[0]==0
            db.execute("UPDATE generation_email_outbox SET available_at=now()-interval '1 minute'")
            db.execute("UPDATE generations SET preview_image_url='https://example.com/edited.png' WHERE id=%s",(id,))
            assert db.execute("SELECT attempts,preview_image_url FROM claim_generation_email('https://brickbuilder.ai')").fetchone()==(2,'https://example.com/finished.png')
            for status in ['completed','cancelled','failed']:
                next_id=uuid4()
                db.execute('INSERT INTO generations(id,user_id,status,name) VALUES (%s,%s,%s,%s)',(next_id,'owner',status,'Other model'))
                db.execute("SELECT subscribe_generation_email(%s,'guest@example.com','https://brickbuilder.ai')",(next_id,))
            assert db.execute('SELECT count(*) FROM generation_email_outbox').fetchone()[0]==2
            third=uuid4()
            db.execute("INSERT INTO generations(id,status) VALUES (%s,'processing')",(third,))
            db.execute("SELECT subscribe_generation_email(%s,'guest@example.com','https://brickbuilder.ai')",(third,))
            fourth=uuid4()
            db.execute("INSERT INTO generations(id,status) VALUES (%s,'processing')",(fourth,))
            with pytest.raises(psycopg.errors.RaiseException,match='notification recipient limit'):
                db.execute("SELECT subscribe_generation_email(%s,'guest@example.com','https://brickbuilder.ai')",(fourth,))
            db.execute("UPDATE generation_email_outbox SET first_attempt_at=now()-interval '21 hours',available_at=now()-interval '1 minute' WHERE generation_id=%s",(id,))
            db.execute("SELECT count(*) FROM claim_generation_email('https://brickbuilder.ai')")
            assert db.execute('SELECT state FROM generation_email_outbox WHERE generation_id=%s',(id,)).fetchone()[0]=='failed'
            for role in ['anon','authenticated']:
                db.execute(f'SET ROLE {role}')
                db.execute('SELECT id,status FROM public.generations')
                for sql in ['SELECT notification_email FROM public.generations','SELECT * FROM generation_email_outbox',"SELECT notification_profile_id('guest@example.com')"]:
                    with pytest.raises(psycopg.errors.InsufficientPrivilege):db.execute(sql)
                db.execute('RESET ROLE')
    finally:server.cleanup()
