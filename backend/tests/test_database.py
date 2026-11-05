import asyncio
import threading

import httpx

from src.utils import database
from src.utils.database import execute_query


def test_supabase_queries_use_http1_and_preserve_authenticated_requests(monkeypatch):
    client = database.create_database_client('https://project.example.test', 'test-service-key')
    transport = client.postgrest.session
    try:
        assert transport._transport._pool._http2 is False
        assert transport.timeout.read == 120
        # Opening storage must not redirect subsequent table queries there.
        client.storage.from_('generations').get_public_url('example.ldr')
        assert client.storage.session is not transport
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json=[{'enabled': True}])

        monkeypatch.setattr(transport, '_transport', httpx.MockTransport(respond))

        async def run():
            return await asyncio.gather(*[
                execute_query(client.table('billing_settings').select('*'))
                for _ in range(16)
            ])

        assert all(result.data == [{'enabled': True}] for result in asyncio.run(run()))
        assert len(requests) == 16
        assert all(request.url.path == '/rest/v1/billing_settings' for request in requests)
        assert all(request.headers['apikey'] == 'test-service-key' for request in requests)
        assert all(request.headers['authorization'] == 'Bearer test-service-key' for request in requests)
    finally:
        transport.close()


def test_slow_database_query_does_not_block_other_requests():
    entered = threading.Event()
    release = threading.Event()

    class Query:
        def execute(self):
            entered.set()
            assert release.wait(2)
            return {"result": "ready"}

    async def run():
        pending = asyncio.create_task(execute_query(Query()))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            # A health check can finish while the database is still blocked.
            assert (
                await asyncio.wait_for(asyncio.sleep(0, result="healthy"), 0.1)
                == "healthy"
            )
            assert not pending.done()
        finally:
            release.set()
        assert await pending == {"result": "ready"}

    asyncio.run(run())


def test_query_workers_are_bounded_and_cancelled_queued_reads_never_execute():
    entered = threading.Event()
    release = threading.Event()
    lock = threading.Lock()
    executions = []

    class Query:
        def __init__(self, id):
            self.id = id

        def execute(self):
            with lock:
                executions.append(self.id)
                if len(executions) == 8:
                    entered.set()
            assert release.wait(2)
            return self.id

    async def run():
        pending = [asyncio.create_task(execute_query(Query(id))) for id in range(8)]
        abandoned = None
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            abandoned = asyncio.create_task(execute_query(Query("abandoned")))
            await asyncio.sleep(0)
            abandoned.cancel()
            await asyncio.gather(abandoned, return_exceptions=True)
            assert len(executions) == 8
        finally:
            release.set()
            await asyncio.gather(*pending)
        assert "abandoned" not in executions

    asyncio.run(run())
