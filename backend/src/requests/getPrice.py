"""Price a saved BOM using exact supplier part/color prices and weights."""
import logging
from decimal import Decimal, ROUND_HALF_UP

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator

from ..utils.authorization import require_generation_access
from ..utils.imported_kit import estimated_inventory, imported_inventory
from ..utils.generation_storage import generation_storage
from ..utils.parts_catalog import PartsUnavailable, normalize_part_id, parts_csv_inventory
from ..utils.posthog_client import track_api_call, track_error
from ..utils.supplier_catalog import get_supplier_catalog

from ..utils.order_pricing import COUNTRY_CODES, OrderPricing, get_member_discount_percent, price_order

logger = logging.getLogger(__name__)
# Hosted All Parts edits, per billing_reserve_generation (monthly plans v4).
IMPORT_CONVERSION_CREDITS = 20


class GetPriceRequest(BaseModel):
    generation_id: str
    shipping_country: str = "US"
    quantity: int = Field(default=1, ge=1, le=99, strict=True)

    @field_validator("shipping_country")
    @classmethod
    def valid_country(cls, value):
        value = value.upper()
        if value not in COUNTRY_CODES:
            raise ValueError("Unsupported shipping country")
        return value


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
    order_pricing: OrderPricing | None = None
    conversion_credits: int | None = None


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


async def load_imported_inventory(storage, generation) -> dict:
    url = generation.get('ldr_url')
    if not url or generation.get('status') != 'completed':
        raise HTTPException(409, 'Your imported model is not ready to price.')
    try:
        model = await storage.download_file_from_storage(url)
    except Exception:
        raise HTTPException(503, 'The imported model is unavailable right now.') from None
    return imported_inventory(model.decode('utf-8'))


async def price_imported_kit(request, generation, auth_info):
    require_generation_access(generation, auth_info)
    catalog = get_supplier_catalog()
    conversion_credits = None
    inventory = {}
    try:
        inventory = await load_imported_inventory(generation_storage, generation)
        inventory = {part: count * request.quantity for part, count in inventory.items()}
        total, breakdown, weight = calculate_price(inventory, catalog)
    except (PartsUnavailable, ValueError):
        conversion_credits = IMPORT_CONVERSION_CREDITS
        estimate = estimated_inventory(inventory, catalog) if inventory else None
        if not estimate:
            return GetPriceResponse(generation_id=request.generation_id, total_price=0,
                total_parts=sum(inventory.values()), total_weight=0, unique_part_types=len(inventory),
                message='Convert unavailable parts to get a kit price.', conversion_credits=conversion_credits)
        total, breakdown, weight = calculate_price(estimate, catalog)
    pricing = price_order(total, weight, request.shipping_country,
                          member_discount_percent=await get_member_discount_percent(auth_info))
    return GetPriceResponse(generation_id=request.generation_id, total_price=total,
        total_parts=sum(inventory.values()), total_weight=weight, unique_part_types=len(inventory),
        parts_breakdown=breakdown, price_source=catalog.name, order_pricing=pricing,
        message='Estimated after conversion' if conversion_credits else 'Exact catalog match',
        conversion_credits=conversion_credits)


async def get_price(request: GetPriceRequest, auth_info: dict) -> GetPriceResponse:
    user_email = auth_info.get("user_email", "anonymous") if isinstance(auth_info, dict) else "anonymous"
    track_api_call(endpoint="/getPrice", user_id=user_email, request_data={"generation_id": request.generation_id})
    try:
        generation = await generation_storage.get_generation(request.generation_id)
        if not generation:
            raise HTTPException(404, "Generation not found")
        if generation.get('endpoint') == 'uploadLdraw':
            return await price_imported_kit(request, generation, auth_info)
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
            inventory = {part: count * request.quantity for part, count in parts_csv_inventory(content).items()}
            total, breakdown, weight = calculate_price(inventory, catalog)
        except PartsUnavailable as exc:
            raise HTTPException(422, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        count = sum(inventory.values())
        pricing = price_order(total, weight, request.shipping_country,
                              member_discount_percent=await get_member_discount_percent(auth_info))
        return GetPriceResponse(generation_id=request.generation_id, total_price=total,
            total_parts=count, total_weight=weight, unique_part_types=len(inventory),
            parts_breakdown=breakdown, price_source=catalog.name, order_pricing=pricing,
            message=f"Parts estimate: ${total:.2f} USD for {count} parts. Catalog prices exclude shipping, tax and discounts.")
    except HTTPException:
        raise
    except (OSError, ValueError):
        raise HTTPException(503, "Supplier parts catalog is unavailable right now") from None
    except Exception as exc:
        logger.exception("Price calculation failed")
        track_error(error_type=type(exc).__name__, error_message=str(exc), endpoint="/getPrice", user_id=user_email)
        raise HTTPException(500, "Internal server error") from None
