"""Price a saved BOM using exact supplier part/color prices and weights."""
import logging
from decimal import Decimal, ROUND_HALF_UP

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from ..utils.generation_storage import generation_storage
from ..utils.parts_catalog import PartsUnavailable, normalize_part_id, parts_csv_inventory
from ..utils.posthog_client import track_api_call, track_error
from ..utils.supplier_catalog import get_supplier_catalog

logger = logging.getLogger(__name__)


class GetPriceRequest(BaseModel):
    generation_id: str


class PartPriceDetail(BaseModel):
    part_id: str
    quantity: int
    unit_price: float
    total_price: float
    color_id: int
    sku: str


class GetPriceResponse(BaseModel):
    generation_id: str
    total_price: float
    total_parts: int
    total_weight: float
    unique_part_types: int
    currency: str = "USD"
    parts_breakdown: list[PartPriceDetail] = Field(default_factory=list)
    message: str
    price_source: str = "Brickwith catalog snapshot"


async def fetch_csv_content(url: str) -> str:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text


def calculate_price(inventory, catalog=None) -> tuple[float, list[PartPriceDetail], float]:
    catalog = catalog or get_supplier_catalog()
    price, weight = catalog.quote(inventory)
    details = []
    for (part_id, color), quantity in inventory.items():
        part = catalog.parts[(normalize_part_id(part_id), color)]
        details.append(PartPriceDetail(part_id=part.part_id + ".dat", color_id=color, sku=part.sku,
            quantity=quantity, unit_price=float(part.unit_price),
            total_price=float((part.unit_price * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))))
    details.sort(key=lambda part: part.total_price, reverse=True)
    return float(price), details, float(weight)


async def get_price(request: GetPriceRequest, auth_info: dict) -> GetPriceResponse:
    user_email = auth_info.get("user_email", "anonymous") if isinstance(auth_info, dict) else "anonymous"
    track_api_call(endpoint="/getPrice", user_id=user_email, request_data={"generation_id": request.generation_id})
    try:
        generation = await generation_storage.get_generation(request.generation_id)
        if not generation:
            raise HTTPException(404, "Generation not found")
        url = generation.get("parts_list_csv_url")
        if not url:
            raise HTTPException(400, "Parts list CSV not found")
        try:
            content = await fetch_csv_content(url)
        except httpx.HTTPError:
            raise HTTPException(503, "Parts list is unavailable right now") from None
        try:
            catalog = get_supplier_catalog()
        except (OSError, ValueError):
            raise HTTPException(503, "Supplier parts catalog is unavailable right now") from None
        try:
            inventory = parts_csv_inventory(content)
            total, breakdown, weight = calculate_price(inventory, catalog)
        except PartsUnavailable as exc:
            raise HTTPException(422, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        count = sum(inventory.values())
        return GetPriceResponse(generation_id=request.generation_id, total_price=total,
            total_parts=count, total_weight=weight, unique_part_types=len(inventory),
            parts_breakdown=breakdown, price_source=catalog.name,
            message=f"Parts estimate: ${total:.2f} USD for {count} parts. Catalog prices exclude shipping, tax and discounts.")
    except HTTPException:
        raise
    except (OSError, ValueError):
        raise HTTPException(503, "Supplier parts catalog is unavailable right now") from None
    except Exception as exc:
        logger.exception("Price calculation failed")
        track_error(error_type=type(exc).__name__, error_message=str(exc), endpoint="/getPrice", user_id=user_email)
        raise HTTPException(500, "Internal server error") from None
