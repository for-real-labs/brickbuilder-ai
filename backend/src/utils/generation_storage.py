"""
Clean and elegant generation storage system for Supabase
Stores all generation data using Supabase Storage for files and database for metadata
"""
import os
import uuid
import time
import logging
import requests
import tempfile
import base64
from typing import Optional, Dict, Any, Union, List
from datetime import datetime
from supabase import Client
from .auth import supabase_client
from .community_likes import is_community_likes_schema_error
from .image_processing import convert_base64_to_png
from .brickowl_utils import parse_ldr_file, generate_parts_list_csv

logger = logging.getLogger(__name__)


# Generation columns holding voxel sources that derived (resized/edited) generations must keep so
# they can be resized again.
RESIZE_SOURCE_KEYS = ("sam3d_voxel_data_url", "design_voxels_url")

class GenerationStorage:
    """Handles storing and retrieving generation data in Supabase Storage + Database"""
    
    def __init__(self):
        self.client: Client = supabase_client
        if not self.client:
            raise ValueError("Supabase client not initialized")
        self.bucket_name = "generations"  # Supabase storage bucket
    
    async def create_generation(
        self,
        user_id: str,
        user_type: str,  # "authenticated" or "anonymous"
        prompt: str,
        detail_level: float,
        endpoint: str = "textToBricks",
        image_model: Optional[str] = None,
        model_3d: Optional[str] = None
    ) -> str:
        """
        Create a new generation record and return the generation ID
        
        Args:
            user_id: User ID (either supabase user ID or anonymous hash)
            user_type: "authenticated" or "anonymous" 
            prompt: The text prompt used
            detail_level: Detail level for brick generation
            endpoint: API endpoint used
            image_model: Model used for image generation (e.g., "flux-schnell", "nano-banana")
            model_3d: Model used for 3D generation (e.g., "trellis", "sam3d")
            
        Returns:
            generation_id: UUID string for this generation
        """
        generation_id = str(uuid.uuid4())
        
        try:
            generation_data = {
                "id": generation_id,
                "user_id": user_id,
                "user_type": user_type,
                "prompt": prompt,
                "detail_level": detail_level,
                "endpoint": endpoint,
                "created_at": datetime.utcnow().isoformat(),
                "status": "started"
            }
            
            # Add model information if provided
            if image_model:
                generation_data["model_used_image"] = image_model
            if model_3d:
                generation_data["model_used_3d"] = model_3d
                
            result = self.client.table("generations").insert(generation_data).execute()
            
            logger.info(f"Created generation record: {generation_id}")
            return generation_id
            
        except Exception as e:
            logger.error(f"Failed to create generation record")
            raise
    
    async def _upload_file_to_storage(
        self,
        file_content: Union[str, bytes],
        file_path: str,
        content_type: str = "application/octet-stream"
    ) -> str:
        """
        Upload a file to Supabase Storage and return the public URL
        
        Args:
            file_content: File content as string or bytes
            file_path: Path within the bucket (e.g., "generations/uuid/file.png")
            content_type: MIME type of the file
            
        Returns:
            Public URL to the uploaded file
        """
        try:
            # Convert string content to bytes if needed
            if isinstance(file_content, str):
                file_content = file_content.encode('utf-8')
            
            # Upload to Supabase Storage with upsert to allow overwriting existing files
            result = self.client.storage.from_(self.bucket_name).upload(
                path=file_path,
                file=file_content,
                file_options={"content-type": content_type, "upsert": "true"}
            )
            
            # Check if upload failed
            if hasattr(result, 'error') and result.error:
                logger.error(f"Supabase storage upload failed: {result.error}")
                raise Exception(f"Storage upload failed: {result.error}")
            
            # Also check for error in response path (newer supabase-py versions)
            if hasattr(result, 'path') and result.path is None:
                error_msg = getattr(result, 'message', 'Unknown upload error')
                logger.error(f"Supabase storage upload failed: {error_msg}")
                raise Exception(f"Storage upload failed: {error_msg}")
            
            # Get public URL
            public_url = self.client.storage.from_(self.bucket_name).get_public_url(file_path)
            logger.info(f"Uploaded file to storage: {public_url}")
            return public_url
            
        except Exception as e:
            logger.error(f"Failed to upload file to storage")
            raise
    
    async def _download_and_upload_from_url(
        self,
        source_url: str,
        file_path: str,
        content_type: str = "application/octet-stream"
    ) -> str:
        """
        Download a file from external URL and upload to Supabase Storage
        
        Args:
            source_url: External URL to download from
            file_path: Path within the bucket
            content_type: MIME type of the file
            
        Returns:
            Public URL to the uploaded file in Supabase Storage
        """
        try:
            # Handle data: URIs by decoding the base64 payload inline
            if source_url.startswith("data:"):
                import base64 as _b64
                logger.info("Source is a data: URI — decoding inline for Supabase upload")
                _header, b64_data = source_url.split(",", 1)
                file_content = _b64.b64decode(b64_data)
            else:
                # Download file from external URL
                response = requests.get(source_url, timeout=30)
                response.raise_for_status()
                file_content = response.content
            
            # Upload to Supabase Storage
            return await self._upload_file_to_storage(
                file_content=file_content,
                file_path=file_path,
                content_type=content_type
            )
            
        except Exception as e:
            logger.error(f"Failed to download and upload file from {source_url[:80]}")
            raise

    async def download_file_from_storage(self, storage_url: str) -> bytes:
        """
        Download a file from a storage URL.

        When using the local embedded storage fallback, the URL points back at
        this same server (``/local-storage/...``). Fetching it over HTTP would
        deadlock the event loop (the server can't serve its own request while
        blocked on it), so we read those files directly from disk instead.

        Args:
            storage_url: Full storage URL

        Returns:
            File content as bytes
        """
        try:
            # Local storage: read straight from disk to avoid a self-HTTP call.
            if "/local-storage/" in storage_url:
                rel = storage_url.split("/local-storage/", 1)[1]
                bucket, _, path = rel.partition("/")
                return self.client.storage.from_(bucket).download(path)

            response = requests.get(storage_url, timeout=30)
            response.raise_for_status()
            return response.content
        except Exception as e:
            logger.error(f"Failed to download file from storage URL {storage_url}")
            raise

    async def _upload_base64_image(
        self,
        base64_data: str,
        generation_id: str,
        filename: str = "input-image.png"
    ) -> Optional[str]:
        """
        Upload a base64 encoded image to Supabase Storage as PNG
        
        Args:
            base64_data: Base64 encoded image data
            generation_id: The generation ID for file organization
            filename: Name of the file (default: "input-image.png")
            
        Returns:
            Public URL to the uploaded file, or None if upload failed
        """
        temp_png_path = None
        try:
            # Create temporary PNG file from base64
            temp_png_path = f"/tmp/{generation_id}_{filename}"
            convert_base64_to_png(base64_data, temp_png_path)
            
            # Read the PNG file and upload to Supabase Storage
            with open(temp_png_path, 'rb') as f:
                png_data = f.read()
            
            file_path = f"generations/{generation_id}/{filename}"
            result = self.client.storage.from_("generations").upload(
                path=file_path,
                file=png_data,
                file_options={"content-type": "image/png"}
            )
            
            if hasattr(result, 'error') and result.error:
                logger.error(f"Failed to upload PNG image: {result.error}")
                return None
            else:
                # Get public URL
                public_url_response = self.client.storage.from_("generations").get_public_url(file_path)
                logger.info(f"Successfully uploaded base64 image as PNG to: {public_url_response}")
                return public_url_response
                
        except Exception as e:
            logger.error(f"Failed to process base64 image")
            return None
        finally:
            # Clean up temporary PNG file
            if temp_png_path and os.path.exists(temp_png_path):
                try:
                    os.unlink(temp_png_path)
                except Exception as e:
                    logger.warning(f"Failed to clean up temp PNG file")

    async def store_images(
        self,
        generation_id: str,
        original_image_url: Optional[str] = None,
        processed_image_url: Optional[str] = None,
        input_image_name: Optional[str] = None
    ) -> None:
        """
        Download images from external URLs and store in Supabase Storage
        
        Args:
            generation_id: The generation ID to update
            original_image_url: External URL of the original generated image
            processed_image_url: External URL of the processed image
            input_image_name: Name of input image if provided by user
        """
        # First, save external URLs to database immediately (before attempting storage uploads)
        external_data = {}
        # Don't update external_image_url here - it's already set during the pipeline
        # if original_image_url:
        #     external_data["external_image_url"] = original_image_url
        if input_image_name:
            external_data["input_image_name"] = input_image_name
        
        if external_data:
            try:
                self.client.table("generations").update(external_data).eq("id", generation_id).execute()
                logger.info(f"Saved external image URL for generation {generation_id}")
            except Exception as e:
                logger.error(f"Failed to save external image URL for generation {generation_id}")
        
        # Now attempt to download and upload images to Supabase Storage
        try:
            update_data = {}
            
            # Download and upload original image to Supabase Storage (timestamp for unique URL to bust CDN cache)
            timestamp = int(time.time())
            if original_image_url:
                storage_url = await self._download_and_upload_from_url(
                    source_url=original_image_url,
                    file_path=f"generations/{generation_id}/original_image_{timestamp}.png",
                    content_type="image/png"
                )
                update_data["original_image_url"] = storage_url
            
            # Download and upload processed image to Supabase Storage  
            if processed_image_url:
                storage_url = await self._download_and_upload_from_url(
                    source_url=processed_image_url,
                    file_path=f"generations/{generation_id}/processed_image_{timestamp}.png",
                    content_type="image/png"
                )
                update_data["processed_image_url"] = storage_url
                
            if update_data:
                result = self.client.table("generations").update(update_data).eq("id", generation_id).execute()
                logger.info(f"Updated generation {generation_id} with image data")
                
        except Exception as e:
            logger.error(f"Failed to store image data for generation {generation_id}")
            # Don't raise - this shouldn't break the main flow

    async def store_reference_images(
        self,
        generation_id: str,
        reference_images: Dict[str, str],
    ) -> Dict[str, str]:
        """Copy directional references into generation storage and persist their URLs."""
        timestamp = int(time.time())
        stored_images: Dict[str, str] = {}
        for view_name, source_url in reference_images.items():
            stored_images[view_name] = await self._download_and_upload_from_url(
                source_url=source_url,
                file_path=(
                    f"generations/{generation_id}/reference_"
                    f"{view_name}_{timestamp}.png"
                ),
                content_type="image/png",
            )

        generation = await self.get_generation(generation_id)
        if not generation:
            raise ValueError(f"Generation {generation_id} was not found")
        merged_images = {
            **(generation.get("reference_images") or {}),
            **stored_images,
        }
        result = (
            self.client.table("generations")
            .update({"reference_images": merged_images})
            .eq("id", generation_id)
            .execute()
        )
        if not result.data:
            raise ValueError(f"Generation {generation_id} was not found")
        logger.info("Stored %d reference views for generation %s", len(stored_images), generation_id)
        return stored_images
    
    async def store_model_file(
        self,
        generation_id: str,
        file_content: Union[str, bytes],
        file_type: str,  # "glb", "ldr", "mpd"
        external_url: Optional[str] = None,
        raise_on_error: bool = False,
        use_external_url: bool = False
    ) -> Optional[str]:
        """
        Store model file in Supabase Storage and save URL to database
        
        Args:
            generation_id: The generation ID to update
            file_content: File content (string for text files, bytes for binary)
            file_type: Type of file ("glb", "ldr", "mpd")
            external_url: Optional external URL (e.g., from fal.ai)
            raise_on_error: If True, raise exceptions instead of swallowing them
            use_external_url: If True, save the external_url as the main URL instead of uploading to Supabase storage
            
        Returns:
            The storage URL if successful, None if failed (when raise_on_error=False)
        """
        try:
            update_data = {}
            
            # Store external URL for reference (e.g., fal.ai GLB URL)
            if external_url:
                update_data[f"external_{file_type}_url"] = external_url
            
            # If use_external_url is True, skip Supabase upload and use external URL directly
            if use_external_url and external_url:
                update_data[f"{file_type}_url"] = external_url
                result = self.client.table("generations").update(update_data).eq("id", generation_id).execute()
                logger.info(f"Updated generation {generation_id} with external {file_type} URL (skipped Supabase upload)")
                return external_url
            
            # Determine file extension and content type
            file_extensions = {
                "glb": ".glb",
                "ldr": ".ldr", 
                "mpd": ".mpd",
                "ply": ".ply",
                "ply_ldr_colors": ".ply",
                "vox": ".vox",
                "xyzrgb": ".xyzrgb",
                "unconverted_xyzrgb": ".xyzrgb",
                "problematic_xyzrgb": ".xyzrgb",
                "design_voxels": ".xyzrgb",
                "sam3d_voxel_data": ".json"
            }
            
            content_types = {
                "glb": "model/gltf-binary",
                "ldr": "text/plain",
                "mpd": "text/plain",
                "ply": "model/ply",
                "ply_ldr_colors": "model/ply",
                "vox": "application/octet-stream",
                "xyzrgb": "text/plain",
                "unconverted_xyzrgb": "text/plain",
                "problematic_xyzrgb": "text/plain",
                "design_voxels": "text/plain",
                "sam3d_voxel_data": "application/json"
            }
            
            file_extension = file_extensions.get(file_type, f".{file_type}")
            content_type = content_types.get(file_type, "application/octet-stream")
            
            # Upload file to Supabase Storage (timestamp for unique URL to bust CDN cache)
            timestamp = int(time.time())
            file_path = f"generations/{generation_id}/{file_type}_model_{timestamp}{file_extension}"
            storage_url = await self._upload_file_to_storage(
                file_content=file_content,
                file_path=file_path,
                content_type=content_type
            )
            
            # Store the Supabase Storage URL in database
            update_data[f"{file_type}_url"] = storage_url
                
            result = self.client.table("generations").update(update_data).eq("id", generation_id).execute()
            logger.info(f"Updated generation {generation_id} with {file_type} file URL")
            return storage_url
            
        except Exception as e:
            logger.error(f"Failed to store {file_type} file for generation {generation_id}")
            if raise_on_error:
                raise
            # Don't raise - this shouldn't break the main flow
            return None

    async def store_parts_list_csv(
        self,
        generation_id: str,
        ldr_content: str,
        raise_on_error: bool = False
    ) -> Optional[str]:
        """
        Generate and store a parts list CSV from LDR content in Supabase Storage
        
        Args:
            generation_id: The generation ID to update
            ldr_content: The LDR file content as string
            raise_on_error: If True, raise exceptions instead of swallowing them
            
        Returns:
            The storage URL if successful, None if failed (when raise_on_error=False)
        """
        try:
            # Generate the parts list CSV
            csv_content = generate_parts_list_csv(ldr_content)
            brick_count = sum(parse_ldr_file(ldr_content).values())
            
            # Upload to Supabase Storage (timestamp for unique URL to bust CDN cache)
            timestamp = int(time.time())
            file_path = f"generations/{generation_id}/parts_list_{timestamp}.csv"
            storage_url = await self._upload_file_to_storage(
                file_content=csv_content,
                file_path=file_path,
                content_type="text/csv"
            )
            
            # Keep the aggregate-friendly count beside the generated artifact so
            # public stats never need to download and parse every parts-list CSV.
            update_data = {
                "parts_list_csv_url": storage_url,
                "brick_count": brick_count,
            }
            result = self.client.table("generations").update(update_data).eq("id", generation_id).execute()
            logger.info(
                "Updated generation %s with parts_list_csv_url and brick_count=%s",
                generation_id,
                brick_count,
            )
            return storage_url
            
        except Exception as e:
            logger.error(f"Failed to store parts list CSV for generation {generation_id}: {e}")
            if raise_on_error:
                raise
            # Don't raise - this shouldn't break the main flow
            return None

    async def get_generation_stats(self) -> Dict[str, int]:
        """Return public, aggregate-only generation statistics."""
        try:
            rpc = getattr(self.client, "rpc", None)
            if callable(rpc):
                try:
                    result = rpc("get_generation_stats").execute()
                    if result.data:
                        row = result.data[0] if isinstance(result.data, list) else result.data
                        return {
                            "generation_count": int(row.get("generation_count") or 0),
                            "brick_count": int(row.get("brick_count") or 0),
                        }
                except Exception as exc:
                    # This also makes local development and rolling deploys work
                    # before the production database migration has been applied.
                    logger.warning("Generation stats RPC unavailable; using query fallback: %s", exc)

            result = self.client.table("generations").select(
                "brick_count", count="exact"
            ).execute()
            return {
                "generation_count": int(result.count or 0),
                "brick_count": sum(
                    int(row.get("brick_count") or 0) for row in (result.data or [])
                ),
            }
        except Exception as exc:
            logger.error("Failed to retrieve generation stats: %s", exc)
            raise
    
    async def update_status(
        self,
        generation_id: str,
        status: str,
        error_message: Optional[str] = None,
        external_image_url: Optional[str] = None,
        prompt_enhancement: Optional[str] = None
    ) -> None:
        """
        Update the status of a generation
        
        Args:
            generation_id: The generation ID to update
            status: New status ("started", "queued", "processing", "completed", "failed")
            error_message: Optional error message if status is "failed"
            external_image_url: Optional URL of the generated/edited image from nano-banana
            prompt_enhancement: Optional prompt enhancement text that was used
        """
        try:
            update_data = {
                "status": status,
                "updated_at": datetime.utcnow().isoformat()
            }
            if error_message:
                update_data["error_message"] = error_message
            if external_image_url:
                update_data["external_image_url"] = external_image_url
            if prompt_enhancement:
                update_data["prompt_enhancement"] = prompt_enhancement
                
            result = self.client.table("generations").update(update_data).eq("id", generation_id).execute()
            # logger.info(f"Updated generation {generation_id} status to: {status}")
            
        except Exception as e:
            logger.error(f"Failed to update status for generation {generation_id}: {e}")
            # Don't raise - this shouldn't break the main flow
    
    async def update_detail_level(self, generation_id: str, detail_level: float) -> None:
        """Record the model's actual size so the resize slider starts at it."""
        try:
            self.client.table("generations").update({
                "detail_level": detail_level,
                "updated_at": datetime.utcnow().isoformat(),
            }).eq("id", generation_id).execute()
        except Exception as e:
            logger.error(f"Failed to update detail level for generation {generation_id}: {e}")

    async def update_payment_status(
        self,
        generation_id: str,
        amount_paid: int,
        stripe_session_id: Optional[str] = None,
        stripe_payment_intent: Optional[str] = None,
        brickowl_cart_id: Optional[str] = None,
        brickowl_cart_url: Optional[str] = None,
        brickowl_wishlist_name: Optional[str] = None,
        parts_list_csv_url: Optional[str] = None,
        shipping_info: Optional[dict] = None
    ) -> Optional[int]:
        """
        Update the payment status of a generation by creating an order record and updating generation
        
        Args:
            generation_id: The generation ID to update
            amount_paid: Amount paid in cents
            stripe_session_id: Optional Stripe session ID for reference
            stripe_payment_intent: Optional Stripe payment intent ID
            brickowl_cart_id: Optional BrickOwl cart ID
            brickowl_cart_url: Optional BrickOwl cart URL
            brickowl_wishlist_name: Optional BrickOwl wishlist name
            parts_list_csv_url: Optional URL to the parts list CSV
            shipping_info: Optional dict with shipping details (name, email, address, etc.)
            
        Returns:
            Order ID if successful, None otherwise
        """
        try:
            # Create order record with just generation_id (foreign key)
            order_data = {
                "generation_id": generation_id,
                "amount_paid": f"{amount_paid/100:.2f}",
                "stripe_session_id": stripe_session_id,
            }
            
            # Add payment intent if provided
            if stripe_payment_intent:
                order_data["stripe_payment_intent"] = stripe_payment_intent
            
            # Add BrickOwl fields if provided
            if brickowl_cart_id:
                order_data["brickowl_cart_id"] = brickowl_cart_id
            if brickowl_cart_url:
                order_data["brickowl_cart_url"] = brickowl_cart_url
            if brickowl_wishlist_name:
                order_data["brickowl_wishlist_name"] = brickowl_wishlist_name
            if parts_list_csv_url:
                order_data["parts_list_csv_url"] = parts_list_csv_url
            
            # Add shipping information if provided
            if shipping_info:
                order_data["shipping_info"] = shipping_info
            
            # Insert into orders table
            order_result = self.client.table("orders").insert(order_data).execute()
            
            if not order_result.data:
                logger.error(f"Failed to create order record for generation {generation_id}")
                return None
            
            # Get the order ID from the inserted record
            order_id = order_result.data[0].get("id") if order_result.data else None
            
            # Update generation table to mark as ordered
            generation_update = {
                "ordered": True,
                "updated_at": datetime.utcnow().isoformat()
            }
            
            generation_result = self.client.table("generations").update(generation_update).eq("id", generation_id).execute()
            
            if generation_result.data:
                logger.info(f"Created order {order_id} and updated generation {generation_id}: ${amount_paid/100:.2f} paid")
                return order_id
            else:
                logger.warning(f"No generation found with ID {generation_id} for order update")
                return None
            
        except Exception as e:
            logger.error(f"Failed to create order for generation {generation_id}: {e}")
            return None
    
    async def get_generation(self, generation_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a generation record by ID
        
        Args:
            generation_id: The generation ID to retrieve
            
        Returns:
            Generation data dictionary or None if not found
        """
        try:
            result = self.client.table("generations").select("*").eq("id", generation_id).execute()
            if result.data:
                return result.data[0]
            return None
            
        except Exception as e:
            logger.error(f"Failed to retrieve generation {generation_id}")
            return None
    
    async def get_user_generations(
        self,
        user_id: str,
        user_type: str,
        limit: int = 10,
        status_filter: Optional[List[str]] = None,
        offset: int = 0
    ) -> list[Dict[str, Any]]:
        """
        Retrieve generations for a specific user
        
        Args:
            user_id: User ID to filter by
            user_type: "authenticated" or "anonymous"
            limit: Maximum number of records to return
            status_filter: Optional list of statuses to filter by (e.g., ["processing", "queued", "started"])
            offset: Number of records to skip (for pagination)
            
        Returns:
            List of generation data dictionaries
        """
        try:
            query = (self.client.table("generations")
                     .select("*")
                     .eq("user_id", user_id)
                     .eq("user_type", user_type))
            
            # Apply status filter if provided
            if status_filter:
                query = query.in_("status", status_filter)
            
            result = (query.order("created_at", desc=True)
                     .range(offset, offset + limit - 1)
                     .execute())
            
            return result.data or []
            
        except Exception as e:
            logger.error(f"Failed to retrieve generations for user {user_id}")
            return []

    async def count_user_generations(
        self,
        user_id: str,
        user_type: str,
        status_filter: Optional[List[str]] = None,
    ) -> int:
        """
        Count total generations for a specific user.

        Args:
            user_id: User ID to filter by
            user_type: "authenticated" or "anonymous"
            status_filter: Optional list of statuses to filter by

        Returns:
            Total number of generations matching the filters (0 on error)
        """
        try:
            query = (self.client.table("generations")
                     .select("id", count="exact")
                     .eq("user_id", user_id)
                     .eq("user_type", user_type))

            if status_filter:
                query = query.in_("status", status_filter)

            result = query.execute()
            return result.count or 0

        except Exception as e:
            logger.error(f"Failed to count generations for user {user_id}: {e}")
            return 0

    async def get_community_generations(
        self,
        limit: int = 10,
        status_filter: Optional[List[str]] = None,
        offset: int = 0,
        sort: str = "recent",
    ) -> list[Dict[str, Any]]:
        """
        Retrieve generations flagged as community (is_community = true)

        Args:
            limit: Maximum number of records to return
            status_filter: Optional list of statuses to filter by
            offset: Number of records to skip (for pagination)

        Returns:
            List of generation data dictionaries
        """
        try:
            def build_query(sort_order: str):
                query = (
                    self.client.table("generations")
                    .select("*")
                    .eq("is_community", True)
                )

                if status_filter:
                    query = query.in_("status", status_filter)

                if sort_order == "top":
                    query = query.order("like_count", desc=True).order("created_at", desc=True)
                else:
                    query = query.order("created_at", desc=True)

                return query

            try:
                result = build_query(sort).range(offset, offset + limit - 1).execute()
            except Exception as error:
                if sort == "top" and is_community_likes_schema_error(error):
                    logger.warning(
                        "Community likes schema unavailable; falling back to recent community generations"
                    )
                    result = build_query("recent").range(offset, offset + limit - 1).execute()
                else:
                    raise

            return result.data or []

        except Exception as e:
            logger.error(f"Failed to retrieve community generations: {e}")
            return []

    async def get_generations_by_image_url(
        self,
        processed_image_url: str,
        user_id: str,
        user_type: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all generations for a specific processed_image_url and user
        Ordered by created_at descending (newest first)
        
        Args:
            processed_image_url: The processed image URL to filter by
            user_id: User ID to filter by
            user_type: "authenticated" or "anonymous"
            
        Returns:
            List of generation data dictionaries
        """
        try:
            result = (self.client.table("generations")
                     .select("*")
                     .eq("processed_image_url", processed_image_url)
                     .eq("user_id", user_id)
                     .eq("user_type", user_type)
                     .order("created_at", desc=True)
                     .execute())
            
            return result.data or []
            
        except Exception as e:
            logger.error(f"Failed to retrieve generations for processed_image_url {processed_image_url}: {e}")
            return []

    async def get_parts_list(self, generation_id: str) -> Optional[Dict[str, Any]]:
        """
        Get the parts list for a generation by downloading and parsing its LDR file
        
        Args:
            generation_id: The generation ID to get parts for
            
        Returns:
            Parsed parts list from parse_ldr_file, or None if failed
        """
        try:
            # Get the generation record
            generation = await self.get_generation(generation_id)
            if not generation:
                logger.error(f"Generation {generation_id} not found")
                return None
            
            # Get the LDR URL
            ldr_url = generation.get("ldr_url")
            if not ldr_url:
                logger.error(f"No LDR URL found for generation {generation_id}")
                return None
            
            # Download the LDR file content
            ldr_content = await self.download_file_from_storage(ldr_url)
            if not ldr_content:
                logger.error(f"Failed to download LDR file from {ldr_url}")
                return None
            
            # Convert bytes to string for parsing
            ldr_text = ldr_content.decode('utf-8')
            
            # Parse the LDR file using brickowl_utils
            parts_list = parse_ldr_file(ldr_text)
            
            logger.info(f"Successfully parsed parts list for generation {generation_id}")
            return parts_list
            
        except Exception as e:
            logger.error(f"Failed to get parts list for generation {generation_id}: {e}")
            return None
    
    async def get_user_orders(
        self,
        user_id: str,
        user_type: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieve all orders for a user by joining with generations table
        Uses generation_id as foreign key - no data duplication
        
        Args:
            user_id: The user ID (authenticated or anonymous hash)
            user_type: "authenticated" or "anonymous"
            
        Returns:
            List of order records
        """
        try:
            # Join orders with generations to filter by user_id
            # Select orders.* and include generation data for enrichment
            result = (self.client.table("orders")
                     .select("*, generations!inner(user_id, user_type, processed_image_url, external_image_url, prompt)")
                     .eq("generations.user_id", user_id)
                     .eq("generations.user_type", user_type)
                     .order("created_at", desc=True)
                     .execute())
            
            return result.data if result.data else []
            
        except Exception as e:
            logger.error(f"Failed to fetch orders for user {user_id}: {e}")
            return []

    async def store(
        self,
        user_id: str,
        user_type: str,
        prompt: str,
        detail_level: float,
        endpoint: str,
        original_image_url: str,
        model_url: str,
        mesh_path: str,
        ldr_content: str,
        processed_image_url: Optional[str] = None
    ) -> str:
        """
        Consolidated storage function - creates generation and stores all data
        
        Args:
            user_id: User ID (either supabase user ID or anonymous hash)
            user_type: "authenticated" or "anonymous"
            prompt: The text prompt used
            detail_level: Detail level for brick generation
            endpoint: API endpoint used
            original_image_url: URL of original image OR base64 data (auto-detected)
            processed_image_url: URL of processed image (optional, used when edit_image=True)
            model_url: URL of GLB model from fal.ai
            mesh_path: Local path to GLB file
            ldr_content: LDR file content as string
            
        Returns:
            generation_id: UUID string for this generation
        """
        try:
            # Create generation record
            generation_id = await self.create_generation(
                user_id=user_id,
                user_type=user_type,
                prompt=prompt,
                detail_level=detail_level,
                endpoint=endpoint
            )
            
            # Auto-detect if original_image_url is base64 data
            def is_base64_data(data: str) -> bool:
                """Check if string appears to be base64 encoded image data"""
                if not data:
                    return False
                # Check for data URL prefix
                if data.startswith('data:image'):
                    return True
                # Check if it looks like base64 (no http/https and contains base64 chars)
                if not data.startswith(('http://', 'https://')):
                    try:
                        # Try to decode a small portion to see if it's valid base64
                        base64.b64decode(data[:100])
                        return True
                    except:
                        pass
                return False
            
            # Handle base64 image upload if detected
            final_original_image_url = original_image_url
            if is_base64_data(original_image_url):
                final_original_image_url = await self._upload_base64_image(
                    base64_data=original_image_url,
                    generation_id=generation_id
                )
            
            # Store images
            await self.store_images(
                generation_id=generation_id,
                original_image_url=final_original_image_url,
                processed_image_url=processed_image_url
            )
            
            # Store GLB file - use fal.ai URL directly instead of uploading to Supabase
            # Keep the file read in case we want to revert to uploading to Supabase storage
            with open(mesh_path, 'rb') as f:
                glb_content = f.read()
            await self.store_model_file(
                generation_id=generation_id,
                file_content=glb_content,
                file_type="glb",
                external_url=model_url,
                use_external_url=True  # Use fal.ai URL directly instead of uploading to Supabase
            )
            
            # Store LDR file
            await self.store_model_file(
                generation_id=generation_id,
                file_content=ldr_content,
                file_type="ldr"
            )
            
            # Update status to completed
            await self.update_status(generation_id, "completed")
            
            logger.info(f"Successfully stored all generation data: {generation_id}")
            return generation_id
            
        except Exception as e:
            logger.error(f"Failed to store generation data")
            # Don't raise - this shouldn't break the main flow
            return ""


# Global instance for easy import. Supabase is optional: when it is not
# configured the storage layer is unavailable and this is left as None so the
# app can still boot in anonymous mode.
generation_storage: Optional["GenerationStorage"] = (
    GenerationStorage() if supabase_client else None
)
