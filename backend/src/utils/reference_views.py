"""Generate consistent directional reference images for semantic voxel rendering."""

import asyncio
import logging
import os
from typing import Dict, Iterable, List

from fastapi import HTTPException

from .fal_provider_client import get_fal_client


logger = logging.getLogger(__name__)

REFERENCE_VIEW_NAMES = ("front", "back", "side", "top")
NANO_BANANA_LITE_EDIT_MODEL = "google/nano-banana-lite/edit"

_VIEW_DESCRIPTIONS = {
    "front": "a straight-on front view",
    "back": "a straight-on rear view",
    "side": "a straight-on left-side profile view",
    "top": "a straight-down top view",
}


def _valid_reference_views(value: object) -> Dict[str, str]:
    """Return only supported view names with public HTTP(S) image URLs."""
    if not isinstance(value, dict):
        return {}
    return {
        name: url.strip()
        for name, url in value.items()
        if name in REFERENCE_VIEW_NAMES
        and isinstance(url, str)
        and url.strip().startswith(("http://", "https://"))
    }


def _view_prompt(view_name: str) -> str:
    return (
        f"Create {_VIEW_DESCRIPTIONS[view_name]} of the exact same subject shown in "
        "the reference images. Preserve its identity, proportions, geometry, materials, "
        "colors, markings, and small details. Rotate only the camera/object to reveal the "
        "requested direction. Show the complete subject centered at the same scale, with "
        "neutral even lighting and the same clean background. Do not add, remove, redesign, "
        "mirror, crop, or stylize anything. Output one image only."
    )


def _generate_reference_view(view_name: str, image_urls: Iterable[str]) -> str:
    if not os.getenv("FAL_KEY"):
        raise HTTPException(
            status_code=503,
            detail="FAL_KEY not configured; it is required to generate missing reference views.",
        )

    result = get_fal_client().subscribe(
        NANO_BANANA_LITE_EDIT_MODEL,
        arguments={
            "prompt": _view_prompt(view_name),
            "image_urls": list(dict.fromkeys(image_urls)),
            "num_images": 1,
            "output_format": "png",
            "aspect_ratio": "auto",
        },
        with_logs=True,
    )
    images = result.get("images") if isinstance(result, dict) else None
    image_url = images[0].get("url") if images and isinstance(images[0], dict) else None
    if not isinstance(image_url, str) or not image_url.startswith(("http://", "https://")):
        logger.error("Nano Banana Lite returned no usable image for %s: %r", view_name, result)
        raise HTTPException(
            status_code=502,
            detail=f"Nano Banana Lite did not return a usable {view_name} reference image.",
        )
    return image_url


async def generate_missing_reference_views(
    primary_reference_url: str,
    existing_views: object,
) -> Dict[str, str]:
    """Generate only absent front/back/side/top views and return the complete map."""
    complete_views = _valid_reference_views(existing_views)
    missing = [name for name in REFERENCE_VIEW_NAMES if name not in complete_views]
    if not missing:
        return complete_views

    source_urls: List[str] = [primary_reference_url, *complete_views.values()]
    generated_urls = await asyncio.gather(
        *(
            asyncio.to_thread(_generate_reference_view, view_name, source_urls)
            for view_name in missing
        )
    )
    complete_views.update(dict(zip(missing, generated_urls)))
    return complete_views
