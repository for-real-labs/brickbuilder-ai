import asyncio
from unittest.mock import AsyncMock

import pytest

from src.utils.generation_stats_cache import GenerationStatsCache


def test_concurrent_visitors_share_one_query_and_refresh_after_ttl():
    async def run():
        now = [0]
        cache = GenerationStatsCache(clock=lambda: now[0])
        load = AsyncMock(return_value={"generation_count": 12, "brick_count": 100})
        results = await asyncio.gather(*(cache.get(load) for _ in range(100)))
        assert all(row == results[0] for row in results)
        load.assert_awaited_once()
        results[0]["brick_count"] = -1
        assert (await cache.get(load))["brick_count"] == 100
        now[0] = 30
        await asyncio.gather(*(cache.get(load) for _ in range(100)))
        assert load.await_count == 2

    asyncio.run(run())


def test_transient_failure_uses_recent_totals_and_backs_off_without_caching_zeros():
    async def run():
        now = [0]
        cache = GenerationStatsCache(clock=lambda: now[0])
        load = AsyncMock(return_value={"generation_count": 12, "brick_count": 100})
        await cache.get(load)
        load.side_effect = RuntimeError("offline")
        now[0] = 30
        assert (await cache.get(load))["generation_count"] == 12
        await cache.get(load)
        assert load.await_count == 2
        now[0] = 301
        with pytest.raises(RuntimeError):
            await cache.get(load)
        with pytest.raises(RuntimeError):
            await cache.get(load)
        assert load.await_count == 3

    asyncio.run(run())


def test_disconnected_visitor_does_not_cancel_shared_refresh():
    async def run():
        finish = asyncio.Event()

        async def load():
            await finish.wait()
            return {"generation_count": 1, "brick_count": 2}

        cache = GenerationStatsCache()
        cancelled = asyncio.create_task(cache.get(load))
        remaining = asyncio.create_task(cache.get(load))
        await asyncio.sleep(0)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        finish.set()
        assert await remaining == {"generation_count": 1, "brick_count": 2}

    asyncio.run(run())


def test_slow_refresh_serves_recent_totals_and_continues_without_duplicate_queries():
    async def run():
        now = [0]
        cache = GenerationStatsCache(clock=lambda: now[0], refresh_timeout=0.01)
        load = AsyncMock(return_value={"generation_count": 1, "brick_count": 2})
        await cache.get(load)
        finish = asyncio.Event()

        async def slow():
            await finish.wait()
            return {"generation_count": 2, "brick_count": 4}

        load.side_effect = slow
        now[0] = 30
        assert await cache.get(load) == {"generation_count": 1, "brick_count": 2}
        assert await cache.get(load) == {"generation_count": 1, "brick_count": 2}
        assert load.await_count == 2
        finish.set()
        await asyncio.sleep(0)
        assert await cache.get(load) == {"generation_count": 2, "brick_count": 4}

    asyncio.run(run())
