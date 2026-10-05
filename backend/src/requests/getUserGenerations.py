import logging
from typing import Optional, List

from pydantic import BaseModel, Field
from fastapi import HTTPException, Request

from ..utils.generation_mode import GenerationMode, generation_mode
from ..utils.generation_storage import generation_storage
from ..utils.posthog_client import track_api_call, track_error

logger = logging.getLogger(__name__)


class OrderInfo(BaseModel):
    """Order information for a generation"""
    id: Optional[int] = None
    generation_id: str
    amount_paid: Optional[str] = None
    stripe_session_id: Optional[str] = None
    brickowl_cart_id: Optional[str] = None
    brickowl_cart_url: Optional[str] = None
    brickowl_wishlist_name: Optional[str] = None
    fulfilled: Optional[bool] = False
    created_at: Optional[str] = None
    image_url: Optional[str] = None  # Image URL from the generation
    prompt: Optional[str] = None  # Prompt from the generation
    shipping_info: Optional[dict] = None  # JSON object with shipping details


class GenerationWithOrder(BaseModel):
    """A generation record with optional order information"""
    id: str
    generation_id: str
    version: int
    user_id: str
    user_type: str
    prompt: str
    name: Optional[str] = None
    detail_level: float
    endpoint: str
    mode: GenerationMode = 'basic_bricks'
    created_at: str
    status: str
    error_message: Optional[str] = None
    ldr_url: Optional[str] = None
    xyzrgb_url: Optional[str] = None
    parts_list_csv_url: Optional[str] = None  # Parts list CSV URL
    original_image_url: Optional[str] = None  # Supabase storage copy
    processed_image_url: Optional[str] = None  # Supabase storage copy
    preview_image_url: Optional[str] = None  # User-uploaded preview image, if set
    external_image_url: Optional[str] = None  # fal.ai generated image URL
    external_glb_url: Optional[str] = None  # fal.ai generated GLB URL
    model_used_image: Optional[str] = None
    model_used_3d: Optional[str] = None
    ordered: Optional[bool] = False
    updated_at: Optional[str] = None
    # Order information (if exists)
    order: Optional[OrderInfo] = None


class GetUserGenerationsRequest(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)  # Offset for pagination (number of unique generations to skip)
    processing: Optional[bool] = None  # If True, return only processing/queued generations


class GetUserGenerationsResponse(BaseModel):
    generations: List[GenerationWithOrder]
    total_count: int
    total_user_generations: int = 0  # Total number of models by the user (not paginated)
    has_more: bool = False  # Whether there are more generations beyond the current page
    all_orders: List[OrderInfo] = []  # All orders for the user, regardless of filtering


async def get_user_generations(request: GetUserGenerationsRequest, auth_info: dict, fastapi_request: Request = None) -> GetUserGenerationsResponse:
    """
    Get all generations for the authenticated or anonymous user along with any associated orders
    
    Guest generations are claimed explicitly using proof of guest ownership.
    
    Args:
        request: GetUserGenerationsRequest containing optional limit
        auth_info: Authentication information (authenticated or anonymous)
        fastapi_request: FastAPI Request object to get IP hash for migration
        
    Returns:
        GetUserGenerationsResponse with list of generations and their orders
    """
    try:
        # Support both authenticated and anonymous users
        is_authenticated = auth_info.get("authenticated", False)
        user_id = auth_info.get("user_id")
        user_type = "authenticated" if is_authenticated else "anonymous"
        user_email = auth_info.get("user_email", user_id if not is_authenticated else "unknown")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="User ID not found")
        
        # Track API call
        track_api_call(
            endpoint="/getUserGenerations", 
            user_id=user_email, 
            request_data={"limit": request.limit, "offset": request.offset, "processing": request.processing, "user_type": user_type}
        )

        # NOTE: Anonymous generations are migrated to the authenticated account
        # via the explicit /claimGeneration endpoint (claimed by generation_id
        # that the client recorded when it created them). We intentionally do NOT
        # migrate by anonymous IP hash here: behind a reverse proxy the client IP
        # is shared across many users, so an IP-based sweep would vacuum other
        # users' anonymous generations into whoever loads this endpoint first.

        # Get the total number of generations for this user (unfiltered)
        total_user_generations = await generation_storage.count_user_generations(
            user_id=user_id,
            user_type=user_type,
        )

        # Get generations for the user (authenticated or anonymous)
        # Apply status filter at database level if processing filter is requested
        status_filter = ["processing", "queued", "started", "ldr_processing", "resizing"] if request.processing else None
        
        # Storage selects the highest version per model before applying pagination.
        # The activity feed still lists every active job, including simultaneous edits.
        rows = await generation_storage.get_user_generations(
            user_id=user_id, user_type=user_type, limit=request.limit + 1,
            status_filter=status_filter, offset=request.offset,
        )
        generations = rows[:request.limit]
        has_more = len(rows) > request.limit

        if not generations:
            return GetUserGenerationsResponse(
                generations=[],
                total_count=0,
                total_user_generations=total_user_generations,
                has_more=False,
                all_orders=[],
            )
        
        # Fetch ALL orders for this user using JOIN (single query, no duplication)
        all_orders_data = await generation_storage.get_user_orders(user_id=user_id, user_type=user_type)
        
        # Build a map of generation_id -> order for quick lookup
        orders_by_generation = {}
        all_orders = []
        
        for order_data in all_orders_data:
            gen_id = order_data.get("generation_id")
            if gen_id:
                orders_by_generation[gen_id] = order_data
                
                # Extract generation info from the join
                gen_info = order_data.get("generations", {})
                
                # Create OrderInfo with enriched data from the join
                order_info = OrderInfo(
                    **{k: v for k, v in order_data.items() if k != "generations"},
                    image_url=gen_info.get("processed_image_url") or gen_info.get("external_image_url"),
                    prompt=gen_info.get("prompt")
                )
                all_orders.append(order_info)
        
        # Combine generations with their orders
        generations_with_orders = []
        for gen in generations:
            # If this generation has an order, enrich it with generation data
            order_info = None
            if gen["id"] in orders_by_generation:
                order_data = orders_by_generation[gen["id"]]
                gen_info = order_data.get("generations", {})
                order_info = OrderInfo(
                    **{k: v for k, v in order_data.items() if k != "generations"},
                    image_url=gen_info.get("processed_image_url") or gen_info.get("external_image_url"),
                    prompt=gen_info.get("prompt")
                )
            
            gen_data = GenerationWithOrder(
                id=gen.get("id"),
                generation_id=gen.get("generation_id", gen["id"]),
                version=gen.get("version", 1),
                user_id=gen.get("user_id"),
                user_type=gen.get("user_type"),
                prompt=gen.get("prompt", ""),
                name=gen.get("name"),
                detail_level=gen.get("detail_level", 0),
                endpoint=gen.get("endpoint", ""),
                mode=generation_mode(gen.get("endpoint"), gen.get("mode")),
                created_at=gen.get("created_at", ""),
                status=gen.get("status", ""),
                error_message=gen.get("error_message"),
                ldr_url=gen.get("ldr_url"),
                xyzrgb_url=gen.get("xyzrgb_url"),
                parts_list_csv_url=gen.get("parts_list_csv_url"),
                original_image_url=gen.get("original_image_url"),
                processed_image_url=gen.get("processed_image_url"),
                preview_image_url=gen.get("preview_image_url"),
                external_image_url=gen.get("external_image_url"),
                external_glb_url=gen.get("external_glb_url"),
                model_used_image=gen.get("model_used_image"),
                model_used_3d=gen.get("model_used_3d"),
                ordered=gen.get("ordered", False),
                updated_at=gen.get("updated_at"),
                order=order_info
            )
            generations_with_orders.append(gen_data)
        
        logger.info(f"Retrieved {len(generations_with_orders)} generations for user {user_email}")
        
        return GetUserGenerationsResponse(
            generations=generations_with_orders,
            total_count=len(generations_with_orders),
            total_user_generations=total_user_generations,
            has_more=has_more,
            all_orders=all_orders
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get user generations")
        track_error(
            error_type=type(e).__name__, 
            error_message=str(e), 
            endpoint="/getUserGenerations", 
            user_id=auth_info.get("user_email", "unknown")
        )
        raise HTTPException(status_code=500, detail="Failed to retrieve user generations")


async def _get_orders_for_generations(generation_ids: List[str]) -> dict:
    """
    Fetch orders for a list of generation IDs
    
    Args:
        generation_ids: List of generation IDs to fetch orders for
        
    Returns:
        Dictionary mapping generation_id to order data
    """
    if not generation_ids:
        return {}
    
    try:
        # Query orders table for all matching generation_ids
        result = (generation_storage.client.table("orders")
                  .select("*")
                  .in_("generation_id", generation_ids)
                  .execute())
        
        # Map orders by generation_id
        orders_by_generation = {}
        if result.data:
            for order in result.data:
                gen_id = order.get("generation_id")
                if gen_id:
                    orders_by_generation[gen_id] = order
        
        return orders_by_generation
        
    except Exception as e:
        logger.error(f"Failed to fetch orders for generations: {e}")
        return {}
