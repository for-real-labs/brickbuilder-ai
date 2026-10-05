"""Replayable output snapshots shared by background jobs and SSE observers.

Uses a private generation-output storage bucket, so reconnects and other workers
can read the output without a database schema change. Text and Claude's exposed
thinking deltas are recorded; signatures and redacted blocks are never published.
"""
import asyncio
import json
import logging
from urllib.parse import urlsplit

import httpx

from .generation_storage import generation_storage
from .authorization import require_generation_access
from .auth import LOCAL_DB_ENABLED, SUPABASE_URL
from .generation_progress import (
    MAX_PROGRESS_INPUT_CHARS, has_summary_input, summarize_progress,
)

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
        path = f"{generation_id}/llm-output.json"
        if LOCAL_DB_ENABLED:
            data = await asyncio.to_thread(bucket.download, path)
        else:
            # Smart CDN can replay an upserted object for up to a minute even
            # with cache-control=0. A fresh short-lived signature gets a unique
            # cache key. It stays on the server; clients only receive snapshots.
            signed = await asyncio.to_thread(bucket.create_signed_url, path, 30)
            url = signed.get("signedURL") or signed.get("signedUrl") or ""
            target = urlsplit(url)
            if (target.scheme != "https" or target.hostname != urlsplit(SUPABASE_URL or "").hostname
                    or target.path.lstrip("/") != f"storage/v1/object/sign/generation-output/{path}"):
                raise ValueError("Unexpected private output storage URL")
            async with httpx.AsyncClient(timeout=8) as client:
                response = await client.get(url)
                response.raise_for_status()
                data = response.content
        return json.loads(data)
    except Exception as exc:
        # Older jobs and newly started jobs may not have a snapshot yet.
        if (str(getattr(exc, "status", getattr(exc, "status_code", ""))) == "404"
                or isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404
                or getattr(exc, "code", "") in {"NoSuchKey", "not_found"}):
            return None
        raise


class OutputRecorder:
    def __init__(self, generation_id: str, design_context: str = ""):
        self.generation_id = generation_id
        self.design_context = design_context[:500]
        self.text = ""
        self.summary = ""
        self.pending = ""
        self.summary_ready = asyncio.Event()
        self.dirty = False
        self.stopped = asyncio.Event()

    async def append(self, delta: str) -> None:
        self.text = (self.text + delta)[-MAX_OUTPUT_CHARS:]
        self.pending = (self.pending + delta)[-MAX_PROGRESS_INPUT_CHARS:]
        if has_summary_input(self.pending, end_of_block=delta.endswith("\n\n")):
            self.summary_ready.set()
        self.dirty = True

    async def set_progress(self, phase: str) -> None:
        # Nova already produces progress events; no extra model request is needed.
        self.summary = " ".join(phase.split())[:200]
        self.dirty = True

    async def flush(self, status: str = "processing", error: str | None = None) -> None:
        text = self.text
        summary = self.summary
        try:
            await write_output(self.generation_id, {"text": text, "summary": summary, "status": status, "error": error})
            self.dirty = self.text != text or self.summary != summary
        except Exception:
            # An output outage must never fail the build or consume another credit.
            logger.warning("Unable to save output for %s", self.generation_id, exc_info=True)

    async def run_summaries(self) -> None:
        # Independent of both generation and storage: slow summaries cannot stall
        # model streaming. Coalesce deltas and never replay earlier input.
        while not self.stopped.is_set() or self.pending.strip():
            if not self.stopped.is_set():
                await self.summary_ready.wait()
            self.summary_ready.clear()
            text, self.pending = self.pending, ""
            if text.strip():
                try:
                    # Keep the subject and most recent thought as context while
                    # summarizing only the new output, including JSON fragments.
                    thought = self.text.rsplit("\n\nDesign output (", 1)[0][-1_000:]
                    summary = await summarize_progress(text, previous_summary=self.summary,
                                                       design_context=thought + "\nSubject: " + self.design_context)
                    if summary:
                        self.summary = summary
                        self.dirty = True
                except Exception:
                    logger.warning("Unable to summarize progress for %s", self.generation_id)

    async def run(self) -> None:
        while not self.stopped.is_set():
            if self.dirty:
                await self.flush()
            try:
                await asyncio.wait_for(self.stopped.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass


async def run_with_output(generation_id: str, generate, *args, native_progress: bool = False) -> None:
    recorder = OutputRecorder(generation_id, getattr(args[0], "prompt", "") or "" if args else "")
    writer = asyncio.create_task(recorder.run())
    summarizer = None if native_progress else asyncio.create_task(recorder.run_summaries())
    error = None
    cancelled = False
    try:
        kwargs = {"on_progress": recorder.set_progress} if native_progress else {}
        error = await generate(generation_id, *args, recorder.append, **kwargs)
    except asyncio.CancelledError:
        cancelled = True
        raise
    except Exception as exc:
        error = str(exc) or "Generation failed"
        raise
    finally:
        # Let an in-flight upload finish before writing the final snapshot.
        recorder.stopped.set()
        recorder.summary_ready.set()
        if summarizer:
            if cancelled:
                summarizer.cancel()
            await asyncio.gather(summarizer, return_exceptions=True)
        await writer
        await recorder.flush("cancelled" if cancelled else "failed" if error else "completed", error)


async def output_events(generation_id: str, auth_info: dict):
    previous = None
    final_retries = 0
    while True:
        # Recheck every snapshot so ownership changes revoke existing observers.
        generation = await generation_storage.get_generation(generation_id)
        if not generation:
            return
        require_generation_access(generation, auth_info)
        snapshot = await read_output(generation_id) or {"text": "", "summary": ""}
        terminal = generation["status"] in {"completed", "failed", "cancelled"}
        if terminal and snapshot.get("status") not in {"completed", "failed", "cancelled"} and final_retries < 3:
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
