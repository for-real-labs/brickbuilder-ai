import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from src.requests import cancelGeneration as endpoint
from src.utils import generation_tasks, generation_storage, llm_output
from src.utils.generation_storage import GenerationStorage


def test_cancel_without_storage_returns_not_found(monkeypatch):
    monkeypatch.setattr(endpoint, "generation_storage", None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint.cancel_generation("job", {"user_id": "owner"}))
    assert error.value.status_code == 404


@pytest.mark.parametrize("auth,row,status", [
    ({"authenticated": True, "user_id": "other"}, {"user_id": "owner", "user_type": "authenticated", "is_community": True}, 404),
    ({"user_id": "other"}, {"user_id": "owner", "user_type": "anonymous"}, 404),
    ({"authenticated": True, "user_id": "owner"}, None, 404),
    ({"authenticated": True, "user_id": "owner"}, {"user_id": "owner", "user_type": "authenticated", "status": "completed"}, 409),
])
def test_cancel_requires_ownership_and_an_active_job(monkeypatch, auth, row, status):
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row), cancel_generation=AsyncMock())
    monkeypatch.setattr(endpoint, "generation_storage", storage)
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint.cancel_generation("job", auth))
    assert error.value.status_code == status
    storage.cancel_generation.assert_not_awaited()


@pytest.mark.parametrize("owner_type", ["authenticated", "anonymous"])
def test_owner_can_cancel_and_repeated_cancels_are_idempotent(monkeypatch, owner_type):
    row = {"user_id": "owner", "user_type": owner_type, "status": "processing"}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row), cancel_generation=AsyncMock(return_value=True))
    stop = Mock()
    monkeypatch.setattr(endpoint, "generation_storage", storage)
    monkeypatch.setattr(endpoint, "cancel_local_task", stop)
    auth = {"user_id": "owner", "authenticated": owner_type == "authenticated"}
    assert asyncio.run(endpoint.cancel_generation("job", auth))["status"] == "cancelled"
    storage.cancel_generation.assert_awaited_once_with("job")
    stop.assert_called_once_with("job")
    row["status"] = "cancelled"
    assert asyncio.run(endpoint.cancel_generation("job", auth))["status"] == "cancelled"
    assert storage.cancel_generation.await_count == 1


def test_completion_racing_with_cancellation_is_not_overwritten(monkeypatch):
    monkeypatch.setattr(endpoint, "generation_storage", SimpleNamespace(
        get_generation=AsyncMock(return_value={"user_id": "owner", "user_type": "anonymous", "status": "processing"}),
        cancel_generation=AsyncMock(return_value=False)))
    stop = Mock()
    monkeypatch.setattr(endpoint, "cancel_local_task", stop)
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint.cancel_generation("job", {"user_id": "owner"}))
    assert error.value.status_code == 409
    stop.assert_not_called()


def test_worker_observes_durable_cancellation_from_another_api_worker(monkeypatch):
    row = {"status": "processing"}
    async def read(_id):
        return row.copy()
    monkeypatch.setattr(generation_storage, "generation_storage", SimpleNamespace(get_generation=read))
    async def run():
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def work():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        task = generation_tasks.start_generation_task("job", work())
        await started.wait()
        row["status"] = "cancelled"
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert stopped.is_set()
        await asyncio.sleep(0)
        assert "job" not in generation_tasks._tasks
    asyncio.run(run())


def test_cancel_before_the_task_starts_closes_unstarted_work(monkeypatch):
    async def run():
        work = asyncio.sleep(100)
        task = generation_tasks.start_generation_task("job", work)
        generation_tasks.cancel_local_task("job")
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        assert inspect.getcoroutinestate(work) == inspect.CORO_CLOSED
        assert "job" not in generation_tasks._tasks
    asyncio.run(run())


@pytest.mark.parametrize("disconnect", [False, True])
def test_llm_stream_ends_on_cancellation_but_survives_observer_disconnect(monkeypatch, disconnect):
    from src.requests import llmToBricks as module
    storage = SimpleNamespace(
        create_generation=AsyncMock(return_value="stream-job"),
        get_generation=AsyncMock(return_value={"status": "processing"}),
    )
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(generation_storage, "generation_storage", storage)
    monkeypatch.setattr(module, "handle_auth_and_tracking", lambda **kwargs: {
        "is_anonymous": True, "is_developer": False, "user_email": "anon",
    })
    async def run():
        release = asyncio.Event()
        completed = asyncio.Event()
        async def generate(_id, _request, _user, _auth, on_text):
            await on_text("Adding the roof")
            await release.wait()
            completed.set()
        monkeypatch.setattr(module, "process_llm_to_bricks_task", generate)
        stream = await module.llm_to_bricks_stream(module.LlmToBricksRequest(prompt="house"), {"user_id": "anon"})
        assert '"type": "started"' in await anext(stream)
        assert "Adding the roof" in await anext(stream)
        task = generation_tasks._tasks["stream-job"]
        if disconnect:
            await stream.aclose()
            assert not task.done()
            release.set()
            await asyncio.wait_for(task, 1)
            assert completed.is_set()
        else:
            generation_tasks.cancel_local_task("stream-job")
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(anext(stream), 1)
            assert task.cancelled()
            assert not completed.is_set()
    asyncio.run(run())


def test_cancellation_finishes_the_output_observer_without_reporting_success(monkeypatch):
    write = AsyncMock()
    monkeypatch.setattr(llm_output, "write_output", write)
    async def run():
        started = asyncio.Event()
        async def generate(_id, on_text):
            await on_text("Building the roof")
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(llm_output.run_with_output("job", generate))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())
    assert write.await_args.args[1]["status"] == "cancelled"


def test_storage_cancellation_is_atomic_and_late_completion_cannot_revive_it():
    query = Mock()
    query.update.return_value = query
    query.eq.return_value = query
    query.in_.return_value = query
    query.neq.return_value = query
    query.execute.return_value = SimpleNamespace(data=[{"status": "cancelled"}])
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=Mock(return_value=query))
    assert asyncio.run(storage.cancel_generation("job")) is True
    query.in_.assert_called_once_with("status", list(generation_tasks.ACTIVE_STATUSES))
    assert query.update.call_args.args[0]["status"] == "cancelled"
    asyncio.run(storage.update_status("job", "completed"))
    query.neq.assert_called_once_with("status", "cancelled")
