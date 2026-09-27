import logging
from typing import Optional, List
from datetime import datetime

from pydantic import BaseModel
from fastapi import HTTPException, Request

from ..utils.generation_storage import generation_storage
from ..utils.posthog_client import track_api_call, track_error

logger = logging.getLogger(__name__)


def _filter_duplicate_glb_generations(generations: List[dict]) -> List[dict]:
    """
    Filter out generations with duplicate processed_image_url, keeping only the most recent one
    This is to only show the latest edits of a model instead of every generation associated with edits.
    Args:
        generations: List of generation dictionaries
        
    Returns:
        List of filtered generations with duplicates removed
    """
    if not generations:
        return generations
    
    # Group generations by processed_image_url
    image_url_groups = {}
    generations_without_image = []
    
    for gen in generations:
        processed_image_url = gen.get("processed_image_url")
        if processed_image_url:
            if processed_image_url not in image_url_groups:
                image_url_groups[processed_image_url] = []
            image_url_groups[processed_image_url].append(gen)
        else:
            # Keep all generations without processed_image_url
            generations_without_image.append(gen)
    
    # For each group, keep only the most recent generation
    filtered_generations = []
    for image_url, group in image_url_groups.items():
        if len(group) == 1:
            filtered_generations.extend(group)
        else:
            # Sort by created_at descending and take the most recent
            try:
                most_recent = max(group, key=lambda x: datetime.fromisoformat(x.get("created_at", "")))
                filtered_generations.append(most_recent)
                logger.info(f"Filtered {len(group)-1} duplicate generation(s) for processed image URL: {image_url}")
            except (ValueError, TypeError) as e:
                # If date parsing fails, take the first one
                logger.warning(f"Failed to parse dates for processed image URL {image_url}, keeping first generation: {e}")
                filtered_generations.append(group[0])
    
    # Add back generations without processed image URLs
    filtered_generations.extend(generations_without_image)
    
    return filtered_generations


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
    user_id: str
    user_type: str
    prompt: str
    name: Optional[str] = None
    detail_level: float
    endpoint: str
    created_at: str
    status: str
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
    limit: int = 50
    offset: int = 0  # Offset for pagination (number of unique generations to skip)
    processing: Optional[bool] = None  # If True, return only processing/queued generations


class GetUserGenerationsResponse(BaseModel):
    generations: List[GenerationWithOrder]
    total_count: int
    total_user_generations: int = 0  # Total number of generations by the user (unfiltered, not paginated)
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
        status_filter = ["processing", "queued", "started", "ldr_processing"] if request.processing else None
        
        # Fetch generations in batches until we have enough unique processed_image_url generations
        # or we run out of generations to fetch
        all_fetched_generations = []
        unique_generations = []
        seen_image_urls = set()
        offset = 0
        # Need to skip `request.offset` unique generations, then collect `request.limit` more
        # Fetch one extra to determine if there are more pages
        target_count = request.offset + request.limit + 1
        batch_size = target_count * 2  # Fetch more than needed to account for duplicates
        max_iterations = 10  # Safety limit to prevent infinite loops
        
        for _ in range(max_iterations):
            generations_batch = await generation_storage.get_user_generations(
                user_id=user_id,
                user_type=user_type,
                limit=batch_size,
                status_filter=status_filter,
                offset=offset
            )
            
            if not generations_batch:
                break  # No more generations to fetch
            
            all_fetched_generations.extend(generations_batch)
            
            # Process batch for unique processed_image_urls
            for gen in generations_batch:
                processed_image_url = gen.get("processed_image_url")
                # Every active job must remain visible, even when two builds
                # or edits share the same source image.
                if processed_image_url and not request.processing:
                    if processed_image_url not in seen_image_urls:
                        seen_image_urls.add(processed_image_url)
                        unique_generations.append(gen)
                else:
                    # Keep all generations without processed_image_url
                    unique_generations.append(gen)
                
                # Stop if we have enough unique generations (offset + limit)
                if len(unique_generations) >= target_count:
                    break
            
            # Stop if we have enough unique generations (offset + limit)
            if len(unique_generations) >= target_count:
                break
            
            # Stop if this batch returned fewer than requested (no more data)
            if len(generations_batch) < batch_size:
                break
            
            offset += batch_size
        
        # Apply offset and limit for pagination
        generations = unique_generations[request.offset:request.offset + request.limit]
        
        if not generations:
            return GetUserGenerationsResponse(
                generations=[],
                total_count=0,
                total_user_generations=total_user_generations,
                has_more=False,
                all_orders=[],
            )
        
        # Check if there are more generations beyond this page
        has_more = len(unique_generations) > (request.offset + request.limit)
        
        logger.info(f"Retrieved {len(generations)} unique generations for user {user_email} (fetched {len(all_fetched_generations)} total, offset={request.offset}, has_more={has_more})" + 
                   (f" (filtered by status: {status_filter})" if status_filter else ""))
        
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
                user_id=gen.get("user_id"),
                user_type=gen.get("user_type"),
                prompt=gen.get("prompt", ""),
                name=gen.get("name"),
                detail_level=gen.get("detail_level", 0),
                endpoint=gen.get("endpoint", ""),
                created_at=gen.get("created_at", ""),
                status=gen.get("status", ""),
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
