"""
LDR Price Estimation API

This module estimates exact Brickwith catalog prices for LDraw placements.
"""
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator
from fastapi import HTTPException

from ..utils.brickowl_utils import map_ldraw_to_lego_color

import logging
logger = logging.getLogger(__name__)


class PartItem(BaseModel):
    """Individual part item in the parts list"""
    design_id: str  # LDraw part number (without PARTS/ prefix)
    color_id: Optional[int]   # LEGO color ID when a reference exists
    ldraw_color_id: int
    quantity: int


class EstimatePriceRequest(BaseModel):
    """Request model for estimating price from LDR"""
    ldr_content: str = Field(min_length=1, max_length=16 * 1024 * 1024)
    condition: str = "usedg"  # new, news, newc, newi, used, usedc, usedi, usedn, usedg, useda, other
    country: str = "US"  # shipping destination country
    user_email: str
    
    @field_validator('ldr_content')
    @classmethod
    def validate_ldr_content(cls, v):
        if not v or not v.strip():
            raise ValueError("LDR content cannot be empty")
        return v
    
    @field_validator('condition')
    @classmethod
    def validate_condition(cls, v):
        valid_conditions = [
            "new",      # New
            "news",     # New (Sealed)
            "newc",     # New (Complete)
            "newi",     # New (Incomplete)
            "used",     # Used
            "usedc",    # Used (Complete)
            "usedi",    # Used (Incomplete)
            "usedn",    # Used (Like New)
            "usedg",    # Used (Good)
            "useda",    # Used (Acceptable)
            "other"     # Other
        ]
        if v not in valid_conditions:
            raise ValueError(f"Condition must be one of: {valid_conditions}")
        return v
    
    @field_validator('user_email')
    @classmethod
    def validate_email(cls, v):
        if not v or not v.strip():
            raise ValueError("User email cannot be empty")
        # Basic email validation
        if '@' not in v or '.' not in v:
            raise ValueError("Invalid email format")
        return v


class EstimatePriceResponse(BaseModel):
    """Response model for price estimation"""
    cart_id: Optional[str]
    total_price: Optional[str]
    currency: Optional[str]
    parts_count: int
    mapped_parts: int
    unmapped_parts: int
    message: str
    parts_list: List[PartItem] = Field(default_factory=list)


async def estimate_price(request: EstimatePriceRequest, auth_info: dict):
    """Exact supplier subtotal for flat LDraw placements; no guessed prices."""
    from ..utils.parts_catalog import PartsUnavailable, flat_model_inventory
    from ..utils.supplier_catalog import get_supplier_catalog
    from ..utils.posthog_client import track_api_call

    user_email = auth_info.get('user_email', 'anonymous')
    track_api_call(endpoint='/estimatePrice', user_id=user_email,
                   request_data={'ldr_content_length': len(request.ldr_content)})
    try:
        catalog = get_supplier_catalog()
    except (OSError, ValueError):
        raise HTTPException(503, 'Supplier parts catalog is unavailable right now') from None
    try:
        inventory = flat_model_inventory(request.ldr_content)
        price, _ = catalog.quote(inventory)
    except (PartsUnavailable, ValueError) as exc:
        raise HTTPException(422, str(exc)) from None
    parts = [PartItem(design_id=part_id, color_id=map_ldraw_to_lego_color(color),
                      ldraw_color_id=color, quantity=quantity)
             for (part_id, color), quantity in inventory.items()]
    count = sum(inventory.values())
    return EstimatePriceResponse(cart_id=None, total_price=str(price), currency='USD',
        parts_count=count, mapped_parts=len(inventory), unmapped_parts=0, parts_list=parts,
        message=f'Parts estimate: ${price:.2f} USD for {count} parts. Catalog prices exclude shipping, tax and discounts.')
