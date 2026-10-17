import asyncio
import threading

from src.utils.database import execute_query


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
