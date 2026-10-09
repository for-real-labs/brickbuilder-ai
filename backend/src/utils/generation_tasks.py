"""Cancellable background jobs, with durable cancellation across API workers."""
import asyncio
import logging
from collections.abc import Coroutine
from contextlib import suppress
from typing import Any
from .generation_budget import GenerationUsage, current_generation_usage

logger = logging.getLogger(__name__)
ACTIVE_STATUSES = ("queued", "started", "processing", "ldr_processing", "resizing")
_tasks: dict[str, asyncio.Task] = {}


def cancel_local_task(generation_id: str) -> None:
    task = _tasks.get(generation_id)
    if task is not None:
        task.cancel()


def start_generation_task(generation_id: str, work: Coroutine[Any, Any, Any]) -> asyncio.Task:
    started = False

    async def run():
        nonlocal started
        from .generation_storage import generation_storage

        row = await generation_storage.get_generation(generation_id)
        if row and row.get("status") == "cancelled":
            raise asyncio.CancelledError
        started = True
        usage = GenerationUsage(generation_id)
        usage_token = current_generation_usage.set(usage)
        worker = asyncio.create_task(work)
        saved_call_count = 0

        async def save_usage_if_changed():
            nonlocal saved_call_count
            call_count = len(usage.calls)
            if call_count == saved_call_count:
                return
            try:
                await generation_storage.save_generation_usage(generation_id, usage.values())
            except Exception:
                logger.warning('Unable to save AI usage for %s', generation_id)
            else:
                saved_call_count = call_count

        async def watch_cancellation():
            while not worker.done():
                try:
                    row = await generation_storage.get_generation(generation_id)
                    if row and row.get("status") == "cancelled":
                        worker.cancel()
                        return
                except Exception:
                    logger.warning("Unable to check cancellation for %s", generation_id)
                # Preserve reported spend while long jobs are still running,
                # including before a process restart or deployment interrupts them.
                await save_usage_if_changed()
                await asyncio.sleep(1)

        watcher = asyncio.create_task(watch_cancellation())
        try:
            return await worker
        finally:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher
            try:
                await asyncio.shield(save_usage_if_changed())
            except Exception:
                logger.warning('Unable to save AI usage for %s', generation_id)
            finally:
                current_generation_usage.reset(usage_token)

    task = asyncio.create_task(run())
    _tasks[generation_id] = task

    def finished(done: asyncio.Task):
        if not started:
            work.close()
        if _tasks.get(generation_id) is done:
            _tasks.pop(generation_id, None)
        if not done.cancelled() and done.exception():
            logger.error("Generation task %s failed: %s", generation_id, done.exception())

    task.add_done_callback(finished)
    return task
