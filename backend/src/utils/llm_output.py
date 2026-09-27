"""Replayable output snapshots shared by background jobs and SSE observers.

Uses a private generation-output storage bucket, so reconnects and other workers
can read the output without a database schema change. Text and Claude's exposed
thinking deltas are recorded; signatures and redacted blocks are never published.
"""
import asyncio
import json
import logging

from .generation_storage import generation_storage
from .authorization import require_generation_access

logger = logging.getLogger(__name__)
MAX_OUTPUT_CHARS = 128_000


async def write_output(generation_id: str, snapshot: dict) -> None:
    bucket = generation_storage.client.storage.from_("generation-output")
    await asyncio.to_thread(
        bucket.upload, path=f"{generation_id}/llm-output.json",
        file=json.dumps(snapshot).encode(),
        file_options={"content-type": "application/json", "upsert": "true", "cache-control": "0"},
    )


async def read_output(generation_id: str) -> dict | None:
    bucket = generation_storage.client.storage.from_("generation-output")
    try:
        data = await asyncio.to_thread(bucket.download, f"{generation_id}/llm-output.json")
        return json.loads(data)
    except Exception as exc:
        # Older jobs and newly started jobs may not have a snapshot yet.
        if (str(getattr(exc, "status", getattr(exc, "status_code", ""))) == "404"
                or getattr(exc, "code", "") in {"NoSuchKey", "not_found"}):
            return None
        raise


class OutputRecorder:
    def __init__(self, generation_id: str):
        self.generation_id = generation_id
        self.text = ""
        self.dirty = False
        self.stopped = asyncio.Event()

    async def append(self, delta: str) -> None:
        self.text = (self.text + delta)[-MAX_OUTPUT_CHARS:]
        self.dirty = True

    async def flush(self, status: str = "processing", error: str | None = None) -> None:
        text = self.text
        try:
            await write_output(self.generation_id, {"text": text, "status": status, "error": error})
            self.dirty = self.text != text
        except Exception:
            # An output outage must never fail the build or consume another credit.
            logger.warning("Unable to save output for %s", self.generation_id, exc_info=True)

    async def run(self) -> None:
        while not self.stopped.is_set():
            if self.dirty:
                await self.flush()
            try:
                await asyncio.wait_for(self.stopped.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass


async def run_with_output(generation_id: str, generate, *args) -> None:
    recorder = OutputRecorder(generation_id)
    writer = asyncio.create_task(recorder.run())
    error = None
    try:
        error = await generate(generation_id, *args, recorder.append)
    except Exception as exc:
        error = str(exc) or "Generation failed"
        raise
    finally:
        # Let an in-flight upload finish before writing the final snapshot.
        recorder.stopped.set()
        await writer
        await recorder.flush("failed" if error else "completed", error)


async def output_events(generation_id: str, auth_info: dict):
    previous = None
    final_retries = 0
    while True:
        # Recheck every snapshot so ownership changes revoke existing observers.
        generation = await generation_storage.get_generation(generation_id)
        if not generation:
            return
        require_generation_access(generation, auth_info)
        snapshot = await read_output(generation_id) or {"text": ""}
        terminal = generation["status"] in {"completed", "failed"}
        if terminal and snapshot.get("status") not in {"completed", "failed"} and final_retries < 3:
            final_retries += 1
            await asyncio.sleep(1)
            continue
        snapshot["status"] = generation["status"]
        snapshot["error"] = generation.get("error_message")
        event = json.dumps({"type": "output", **snapshot})
        if event != previous:
            yield f"data: {event}\n\n"
            previous = event
        else:
            yield ": keep-alive\n\n"
        if terminal:
            return
        await asyncio.sleep(1)
