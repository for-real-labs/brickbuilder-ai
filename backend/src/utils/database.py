"""Keep synchronous database transports off the API event loop."""

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol, TypeVar

import httpx
from supabase import Client, ClientOptions, create_client

Result = TypeVar("Result", covariant=True)
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="brickbuilder-db")


def create_database_client(url: str, key: str) -> Client:
    # Concurrent worker threads exposed a race in the HTTP/2 stream state,
    # leaving database requests stuck. Use independent HTTP/1.1 connections.
    transport = httpx.Client(http2=False, timeout=120, follow_redirects=True)
    try:
        return create_client(url, key, options=ClientOptions(httpx_client=transport))
    except Exception:
        transport.close()
        raise


class ExecutableQuery(Protocol[Result]):
    def execute(self) -> Result: ...


async def execute_query(query: ExecutableQuery[Result]) -> Result:
    # Both Supabase's HTTP client and the local adapter support worker threads.
    # A slow database read must not freeze health checks or other requests.
    # Bound database concurrency independently from CPU/file work using the
    # default executor. Cancelled queued requests never reach the database.
    context = contextvars.copy_context()
    return await asyncio.get_running_loop().run_in_executor(
        _executor, context.run, query.execute
    )
