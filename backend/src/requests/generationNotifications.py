"""Owner-scoped completion notifications and resumable edit links."""
from fastapi import HTTPException

from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage


def _owned_query(auth_info: dict):
    user_id = auth_info.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Account or guest session required")
    return (generation_storage.client.table("generations").select("*")
            .eq("user_id", user_id)
            .eq("user_type", "authenticated" if auth_info.get("authenticated") else "anonymous"))


def _summary(row: dict) -> dict:
    return {"id": row["id"], "prompt": row.get("name") or row.get("prompt") or "Your model",
            "status": row.get("status"), "seen": bool(row.get("notification_seen", True)),
            "updated_at": row.get("updated_at") or row.get("created_at"),
            "image_url": row.get("preview_image_url") or row.get("processed_image_url"),
            "is_edit": bool(row.get("source_generation_id")) or row.get("endpoint") in
            ("updateModel", "promptEditModel", "resizeModel")}


async def list_generation_notifications(auth_info: dict) -> dict:
    # Keep unread entries even when they are older than the recent read history.
    unread = (_owned_query(auth_info).eq("status", "completed")
              .eq("notification_seen", False).order("updated_at", desc=True).execute().data or [])
    recent = (_owned_query(auth_info).eq("status", "completed")
              .order("updated_at", desc=True).limit(30).execute().data or [])
    active = (_owned_query(auth_info).in_("status", ["queued", "started", "processing", "ldr_processing", "resizing"])
              .order("created_at", desc=True).execute().data or [])
    rows = {row["id"]: row for row in [*unread, *recent]}
    return {"notifications": [_summary(row) for row in sorted(rows.values(),
            key=lambda row: row.get("updated_at") or row.get("created_at") or "", reverse=True)],
            "unread_count": len(unread), "active": [_summary(row) for row in active]}


async def mark_generation_viewed(generation_id: str, auth_info: dict) -> dict:
    row = await generation_storage.get_generation(generation_id)
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    require_generation_access(row, auth_info)
    if row.get("status") != "completed":
        raise HTTPException(status_code=409, detail="The model is still processing")
    (generation_storage.client.table("generations").update({"notification_seen": True})
     .eq("id", generation_id).eq("user_id", row["user_id"]).eq("user_type", row["user_type"]).execute())
    return {"generation_id": generation_id, "seen": True}


async def latest_generation_edit(generation_id: str, auth_info: dict) -> dict:
    row = await generation_storage.get_generation(generation_id)
    if not row:
        raise HTTPException(status_code=404, detail="Generation not found")
    require_generation_access(row, auth_info)
    edits = (_owned_query(auth_info).eq("source_generation_id", generation_id)
             .in_("status", ["queued", "started", "processing", "ldr_processing", "resizing", "completed"])
             .order("created_at", desc=True).limit(1).execute().data or [])
    return {"generation_id": edits[0]["id"] if edits else None}
