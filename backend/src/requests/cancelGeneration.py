import logging

from fastapi import HTTPException

from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import ACTIVE_STATUSES, cancel_local_task

logger = logging.getLogger(__name__)


async def cancel_generation(generation_id: str, auth_info: dict) -> dict:
    if generation_storage is None:
        raise HTTPException(status_code=404, detail="Generation not found")
    row = await generation_storage.get_generation(generation_id)
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    # Community visibility never grants permission to cancel someone else's build.
    require_generation_access(row, auth_info)
    if row.get("status") == "cancelled":
        return {"generation_id": generation_id, "status": "cancelled"}
    if row.get("status") not in ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="This generation has already finished")
    try:
        cancelled = await generation_storage.cancel_generation(generation_id)
    except Exception as error:
        # Return a handled response with CORS headers, and keep the worker running
        # unless cancellation was durably saved. Never log database row contents.
        logger.error("Unable to persist generation cancellation (%s)", type(error).__name__)
        raise HTTPException(status_code=503, detail="Unable to cancel this build. Please try again.") from error
    if not cancelled:
        raise HTTPException(status_code=409, detail="This generation has already finished")
    cancel_local_task(generation_id)
    return {"generation_id": generation_id, "status": "cancelled"}
