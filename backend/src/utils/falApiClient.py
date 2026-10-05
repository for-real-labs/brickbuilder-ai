"""
fal.ai API Client

This module contains the client for interacting with fal.ai APIs,
including Flux for text-to-image generation and Trellis for image-to-3D conversion.
"""

import base64
import logging
from typing import Optional, Callable
from fastapi import HTTPException
import fal_client

from .fal_provider_client import get_fal_client

# Configure logging
logger = logging.getLogger(__name__)


class FalApiClient:
    """Client for interacting with fal.ai APIs (Flux for text-to-image and Trellis for image-to-3D)"""
    
    @property
    def client(self):
        return get_fal_client()
        
    def upload_base64_image(self, base64_data: str) -> str:
        """Upload a base64 image to fal.ai storage and return the URL"""
        try:
            # Decode base64 to bytes
            image_bytes = base64.b64decode(base64_data)
            
            # Upload the image bytes to fal.ai storage
            file_url = self.client.upload(image_bytes, "image/jpeg")
            logger.info(f"Uploaded base64 image to fal.ai storage: {file_url}")
            return file_url
            
        except Exception as e:
            logger.error(f"Error uploading base64 image: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail="Failed to process image data"
            )
    
    def generate_image_from_text(self, prompt: str, model: str, status_callback: Optional[Callable[[str], None]] = None) -> str:
        """
        Generate an image from a text prompt using specified AI model
        
        Args:
            prompt: Text description of what to generate
            model: Model to use for generation
            status_callback: Optional callback function(status) for queue updates
            
        Returns:
            URL to the generated image
        """
        # Validate model selection
        if model not in ["flux-schnell", "nano-banana", "flux-2"]:
            raise ValueError(f"Unsupported model: {model}")
        
        last_logged_status = [None]  # Track to avoid repeated logs
        
        def on_queue_update(update):
            if isinstance(update, fal_client.Queued):
                if last_logged_status[0] != "queued":
                    logger.info("Image generation queued")
                    last_logged_status[0] = "queued"
                if status_callback:
                    status_callback("queued")
            elif isinstance(update, fal_client.InProgress):
                if last_logged_status[0] != "processing":
                    logger.info("Image generation in progress")
                    last_logged_status[0] = "processing"
                if status_callback:
                    status_callback("processing")
                for log in update.logs:
                    logger.debug(f"Generation progress: {log['message']}")
        
        try:
            logger.info(f"Generating image using model '{model}': {prompt[:100]}..." if len(prompt) > 100 else f"Generating image using model '{model}': {prompt}")
            
            # Select the appropriate endpoint based on model
            if model == "flux-schnell":
                endpoint = "fal-ai/flux-1/schnell"
            elif model == "flux-2":
                endpoint = "fal-ai/flux-2"
            else:  # nano-banana
                endpoint = "fal-ai/nano-banana"
            
            # Build arguments based on model
            arguments = {"prompt": prompt}
            if model == "flux-2":
                arguments["image_size"] = "square_hd"
                arguments["num_inference_steps"] = 28
                arguments["output_format"] = "png"
                arguments["enable_safety_checker"] = True
                arguments["guidance_scale"] = 2.5
                arguments["acceleration"] = "regular"
            
            result = self.client.subscribe(
                endpoint,
                arguments=arguments,
                with_logs=True,
                on_queue_update=on_queue_update,
            )
            
            # The result should contain the generated image
            if "images" not in result or not result["images"]:
                logger.error(f"No images in API response: {result}")
                raise HTTPException(
                    status_code=500,
                    detail="No images returned from API"
                )
            
            # Get the first image URL
            image_url = result["images"][0]["url"]
            logger.info(f"Successfully generated image using '{model}' model: {image_url}")
            return image_url
            
        except Exception as e:
            logger.error(f"Error calling image generation API: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail="Failed to generate"
            )

    def generate_3d_model(self, image_input: str, model: str, is_base64: bool = False, status_callback: Optional[Callable[[str], None]] = None) -> str:
        """
        Generate a 3D model from an image using specified AI model
        
        Args:
            image_input: Either a URL to an image or base64 encoded image data
            model: Model to use for generation
            is_base64: Whether the image_input is base64 encoded
            status_callback: Optional callback function(status) for queue updates
            
        Returns:
            URL to the generated mesh file
        """

        # Validate model selection
        if model not in ["trellis", "trellis-2", "sam3d"]:
            raise ValueError(f"Unsupported model: {model}")
        
        last_logged_status = [None]  # Track to avoid repeated logs
            
        def on_queue_update(update):
            if isinstance(update, fal_client.Queued):
                if last_logged_status[0] != "queued":
                    logger.info("3D model generation queued")
                    last_logged_status[0] = "queued"
                if status_callback:
                    status_callback("queued")
            elif isinstance(update, fal_client.InProgress):
                if last_logged_status[0] != "processing":
                    logger.info("3D model generation in progress")
                    last_logged_status[0] = "processing"
                if status_callback:
                    status_callback("processing")
                for log in update.logs:
                    logger.debug(f"3D model generation progress: {log['message']}")
        
        try:
            # Handle base64 images by uploading them first
            if is_base64:
                image_url = self.upload_base64_image(image_input)
            else:
                image_url = image_input
            
            logger.info(f"Generating 3D model using '{model}' from image: {image_url[:100]}..." if len(image_url) > 100 else f"Generating 3D model using '{model}' from image: {image_url}")
            
            # Select the appropriate endpoint and arguments based on model
            if model == "trellis-2":
                endpoint = "fal-ai/trellis-2"
                arguments = {
                    "image_url": image_url,
                    "resolution": 512,
                    "texture_size": 1024,
                }
                result_key = "model_glb"
            elif model == "trellis":
                endpoint = "fal-ai/trellis"
                arguments = {
                    "image_url": image_url,
                    "mesh_simplify": 0.95,
                    "texture_size": 512, 
                    # "ss_guidance_strength": 4.0,  # Lower to reduce shadow baking from input image
                    # "slat_guidance_strength": 5.0,  # Higher for more consistent material properties
                }
                result_key = "model_mesh"
            elif model == "sam3d":
                endpoint = "fal-ai/sam-3/3d-objects"
                arguments = {
                    "image_url": image_url,
                    "prompt": None,
                    "export_textured_glb": True,
                }
                result_key = "model_glb"
            
            result = self.client.subscribe(
                endpoint,
                arguments=arguments,
                with_logs=True,
                on_queue_update=on_queue_update,
            )
            
            # The result should contain the generated model mesh
            if result_key not in result:
                logger.error(f"No {result_key} in response: {result}")
                raise HTTPException(
                    status_code=500,
                    detail="Processing failed - invalid response from external service"
                )
            
            model_url = result[result_key]["url"]
            logger.info(f"Successfully generated 3D model using '{model}' model: {model_url}")
            return model_url
            
        except Exception as e:
            # Fallback: if sam3d fails, retry with trellis
            if model == "sam3d":
                logger.warning(f"SAM3D failed ({str(e)}), falling back to trellis")
                try:
                    fallback_endpoint = "fal-ai/trellis"
                    fallback_arguments = {
                        "image_url": image_url,
                        "mesh_simplify": 0.95,
                        "texture_size": 512,
                    }
                    fallback_result_key = "model_mesh"
                    
                    result = self.client.subscribe(
                        fallback_endpoint,
                        arguments=fallback_arguments,
                        with_logs=True,
                        on_queue_update=on_queue_update,
                    )
                    
                    if fallback_result_key not in result:
                        logger.error(f"No {fallback_result_key} in fallback response: {result}")
                        raise HTTPException(
                            status_code=500,
                            detail="Processing failed - invalid response from external service"
                        )
                    
                    model_url = result[fallback_result_key]["url"]
                    logger.info(f"Successfully generated 3D model using trellis fallback: {model_url}")
                    return model_url
                except Exception as fallback_e:
                    logger.error(f"Trellis fallback also failed: {str(fallback_e)}")
                    raise HTTPException(
                        status_code=500,
                        detail="Processing failed - unable to complete conversion"
                    )
            
            logger.error(f"Error calling 3D model generation API with '{model}' model: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail="Processing failed - unable to complete conversion"
            )

    async def download_mesh_file(self, url: str, output_path: str) -> None:
        """Download a mesh file from the given URL"""
        import httpx
        import aiofiles
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.get(url)
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail="Failed to download required file"
                )
            
            async with aiofiles.open(output_path, 'wb') as f:
                await f.write(response.content)
                
            logger.info(f"Downloaded mesh file to: {output_path}")
