"""Short-lived, aggregate-only cache shared by visitors to an API process."""

import asyncio
import time
from collections.abc import Awaitable, Callable


class GenerationStatsCache:
    def __init__(
        self,
        ttl: float = 30,
        stale_ttl: float = 300,
        clock=time.monotonic,
        refresh_timeout: float = 5,
    ):
        self.ttl = ttl
        self.stale_ttl = stale_ttl
        self.clock = clock
        self.refresh_timeout = refresh_timeout
        self._value: dict[str, int] | None = None
        self._updated_at = float("-inf")
        self._retry_at = float("-inf")
        self._pending: asyncio.Task | None = None

    async def get(
        self, load: Callable[[], Awaitable[dict[str, int]]]
    ) -> dict[str, int]:
        age = self.clock() - self._updated_at
        if self._value is not None and age < self.ttl:
            return dict(self._value)
        if self.clock() < self._retry_at:
            if self._value is not None and age < self.stale_ttl:
                return dict(self._value)
            raise RuntimeError("Generation stats temporarily unavailable")
        if self._pending is None:
            self._pending = asyncio.create_task(self._refresh(load))
            self._pending.add_done_callback(
                lambda task: None if task.cancelled() else task.exception()
            )
        elif self._value is not None and age < self.stale_ttl:
            return dict(self._value)
        # A disconnected visitor must not cancel a refresh shared with others.
        try:
            return dict(
                await asyncio.wait_for(
                    asyncio.shield(self._pending), self.refresh_timeout
                )
            )
        except asyncio.TimeoutError:
            if (
                self._value is not None
                and self.clock() - self._updated_at < self.stale_ttl
            ):
                return dict(self._value)
            raise

    async def _refresh(self, load):
        try:
            value = await load()
            self._value = dict(value)
            self._updated_at = self.clock()
            return self._value
        except Exception:
            self._retry_at = self.clock() + 5
            if (
                self._value is not None
                and self.clock() - self._updated_at < self.stale_ttl
            ):
                return self._value
            raise
        finally:
            self._pending = None
