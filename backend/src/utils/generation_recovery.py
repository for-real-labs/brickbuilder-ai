"""Reconcile Nova jobs whose API worker has stopped sending heartbeats."""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from .database import execute_query

logger = logging.getLogger(__name__)
STALE_AFTER = timedelta(minutes=15)
INTERRUPTED = "This build was interrupted before completion. Start a new build or continue from its saved session."
ACTIVE = ("started", "queued", "processing")


async def recover_stale_generations(storage) -> int:
    cutoff = (datetime.now(timezone.utc) - STALE_AFTER).isoformat()
    result = await execute_query(
        storage.client.table("generations").select(
            "id,status,updated_at,ldr_url,parts_list_csv_url,generation_duration_seconds"
        ).eq("endpoint", "novaToBricks").in_("status", ACTIVE)
        .lt("updated_at", cutoff).order("updated_at").limit(100)
    )
    recovered = 0
    for row in result.data:
        try:
            bucket = storage.client.storage.from_("generation-output")
            try:
                data = await asyncio.to_thread(bucket.download, f"{row['id']}/llm-output.json")
                snapshot = json.loads(data)
            except Exception as exc:
                # An outage must not turn valid builds into failures. Only a
                # confirmed missing snapshot means this job never recorded output.
                if (not isinstance(exc, FileNotFoundError)
                        and getattr(exc, "code", None) not in {"NoSuchKey", "not_found"}
                        and str(getattr(exc, "status", "")) != "404"):
                    raise
                snapshot = {}
            complete = (snapshot.get("status") == "completed" and row.get("ldr_url")
                        and row.get("parts_list_csv_url")
                        and row.get("generation_duration_seconds") is not None)
            values = {
                "status": "completed" if complete else "failed",
                "error_message": None if complete else (snapshot.get("error") or INTERRUPTED),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            # Compare the exact heartbeat we inspected: another worker, a
            # cancellation, or a finishing build always wins over recovery.
            changed = await execute_query(
                storage.client.table("generations").update(values)
                .eq("id", row["id"]).eq("status", row["status"])
                .eq("updated_at", row["updated_at"])
            )
            if changed.data:
                recovered += 1
                logger.info("Recovered stale Nova generation %s as %s", row["id"], values["status"])
        except Exception:
            logger.warning("Unable to reconcile Nova generation %s", row["id"], exc_info=True)
    return recovered


def start_recovery_worker(storage):
    if storage is None:
        return None

    async def run():
        while True:
            try:
                await recover_stale_generations(storage)
            except Exception:
                logger.warning("Unable to scan stale Nova generations", exc_info=True)
            await asyncio.sleep(60)

    return asyncio.create_task(run())
