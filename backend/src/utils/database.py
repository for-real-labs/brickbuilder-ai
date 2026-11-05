"""Keep synchronous database transports off the API event loop."""

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol, TypeVar

import httpx
from supabase import Client, create_client

Result = TypeVar("Result", covariant=True)
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="brickbuilder-db")


def create_database_client(url: str, key: str) -> Client:
    # Concurrent worker threads exposed a race in the HTTP/2 stream state,
    # leaving database requests stuck. Use independent HTTP/1.1 connections.
    client = create_client(url, key)
    postgrest = client.postgrest
    original = postgrest.session
    # Supabase shares ClientOptions.httpx_client with storage and auth, which
    # mutate its base URL. Give only PostgREST its own transport instead.
    postgrest.session = httpx.Client(
        base_url=original.base_url, headers=original.headers,
        timeout=original.timeout, http2=False, follow_redirects=True,
    )
    original.close()
    return client


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
