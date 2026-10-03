"""
Image Generation Functions

This module contains functions for generating images from text prompts using AI services,
specifically Flux for text-to-image generation with background removal preprocessing.
"""

import os
import json
import logging
import tempfile
import asyncio
import shutil
import base64
import requests
from io import BytesIO
from typing import Tuple, Optional, Callable
from PIL import Image, ImageOps
import fal_client
import httpx

from .falApiClient import FalApiClient
from .fal_provider_client import get_fal_client
from .image_processing import remove_background_from_url

# Configure logging
logger = logging.getLogger(__name__)

# Load prompt enhancements from files
def _load_prompt_enhancement(filename: str) -> str:
    """Load prompt enhancement text from file"""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    file_path = os.path.join(current_dir, filename)
    try:
        with open(file_path, 'r') as f:
            return f.read().strip()
    except Exception as e:
        logger.warning(f"Failed to load {filename}, using default: {e}")
        return "Failed to load prompt enhancement."

# Prompt enhancements for different model tiers (can be selected via model_option parameter)
PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_A = _load_prompt_enhancement("prompt_enhancement_3D_regular_option_a.txt")
PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_B = _load_prompt_enhancement("prompt_enhancement_3D_regular_option_b.txt")
PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_C = _load_prompt_enhancement("prompt_enhancement_3D_regular_option_c.txt")
PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_A = _load_prompt_enhancement("prompt_enhancement_3D_premium_option_a.txt")
PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_B = _load_prompt_enhancement("prompt_enhancement_3D_premium_option_b.txt")
PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_C = _load_prompt_enhancement("prompt_enhancement_3D_premium_option_c.txt")

PROMPT_ENHANCEMENT_REFERENCE_IMAGE = (
    "rendered in the same voxelized way as the objects in this reference image. All patterns on the object should be voxelized with same sized voxels. White background. No shadows. Isometric view."
)


async def generate_image_from_text_simple_streaming(
    prompt: str,
    model_option: str = "a",
    prompt_option: str = "a",
) -> Tuple[str, str, str]:
    """
    Generate an image using flux-2 streaming endpoint, but wait for final result
    without forwarding intermediate frames. This is used in non-streaming 3D mode
    to ensure consistent image generation using the same flux-2/stream endpoint.
    
    Args:
        prompt: Text description of what to generate
        model_option: "a" for regular, "b" for premium, "c" for sam3d
        prompt_option: "a", "b", or "c" to select prompt enhancement version
    
    Returns:
        Tuple of (original_image_url, processed_image_url, enhanced_prompt)
    """
    fal_key = os.getenv("FAL_KEY")
    if not fal_key:
        raise ValueError("FAL_KEY environment variable is required")

    # Select prompt enhancement (same logic as streaming path)
    if model_option.lower() == "b":
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_A
    else:
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_A

    enhanced_prompt = f"{prompt}, {prompt_enhancement}"
    logger.info(f"Enhanced prompt for flux-2 streaming: {enhanced_prompt}")

    stream_url = "https://fal.run/fal-ai/flux-2/stream"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Key {fal_key}",
    }
    payload = {
        "prompt": enhanced_prompt,
        "image_size": "square_hd",
        "num_inference_steps": 28,
        "output_format": "png",
        "enable_safety_checker": True,
        "guidance_scale": 2.5,
        "acceleration": "regular",
    }

    original_image_url = None
    sse_buffer = ""

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
        async with client.stream("POST", stream_url, headers=headers, json=payload) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                raise Exception(f"Flux-2 stream error ({response.status_code}): {error_body.decode()}")

            async for chunk in response.aiter_bytes():
                sse_buffer += chunk.decode("utf-8", errors="replace")

                while "\n\n" in sse_buffer:
                    block, sse_buffer = sse_buffer.split("\n\n", 1)

                    for line in block.split("\n"):
                        line = line.strip()
                        if not line.startswith("data: "):
                            continue
                        raw_data = line[6:]

                        try:
                            parsed = json.loads(raw_data)
                        except json.JSONDecodeError:
                            continue

                        # Extract image URL
                        image_url = None
                        if "images" in parsed and parsed["images"]:
                            image_url = parsed["images"][0].get("url")
                        elif "output" in parsed and isinstance(parsed.get("output"), dict):
                            output = parsed["output"]
                            if "images" in output and output["images"]:
                                image_url = output["images"][0].get("url")
                        elif "image" in parsed and isinstance(parsed.get("image"), dict):
                            image_url = parsed["image"].get("url")
                        elif "url" in parsed and isinstance(parsed.get("url"), str):
                            image_url = parsed["url"]

                        if image_url:
                            # Keep updating to get the final image
                            original_image_url = image_url
                        elif parsed.get("status") == "error" or parsed.get("type") == "error" or parsed.get("event") == "error":
                            error_msg = parsed.get("message") or parsed.get("error") or "Flux-2 error"
                            raise Exception(error_msg)

    if not original_image_url:
        raise Exception("Flux-2 stream completed without producing an image")

    logger.info(f"Flux-2 final image: {original_image_url[:80] + '...' if len(original_image_url) > 80 else original_image_url}")

    # Handle data: URIs by uploading to fal.ai storage
    if original_image_url.startswith("data:"):
        logger.info("Flux-2 stream returned a data: URI — uploading to fal.ai storage")
        try:
            header, b64_data = original_image_url.split(",", 1)
            image_bytes = base64.b64decode(b64_data)
            uploaded_url = get_fal_client().upload(image_bytes, "image/png")
            logger.info(f"Uploaded data-URI image to fal.ai: {uploaded_url[:80]}...")
            original_image_url = uploaded_url
        except Exception as e:
            logger.error(f"Failed to upload data-URI image to fal.ai: {e}")
            raise Exception("Failed to convert streaming image data URI to a URL") from e

    # Background removal
    temp_dir = tempfile.mkdtemp()
    try:
        loop = asyncio.get_running_loop()
        processed_image_url = await loop.run_in_executor(
            None, remove_background_from_url, original_image_url, temp_dir
        )
    finally:
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass

    logger.info(f"Image generation complete: original={original_image_url[:80]}..., processed={processed_image_url[:80]}...")
    return original_image_url, processed_image_url, enhanced_prompt

async def generate_image_from_text(prompt: str, model: str, status_callback: Optional[Callable[[str], None]] = None, model_option: str = "a", prompt_option: str = "a") -> Tuple[str, str, str]:
    """
    Generate an image from a text prompt using specified AI model with background removal.
    
    Args:
        prompt: Text description of what to generate
        model: Model to use for generation
        status_callback: Optional callback function(status) for queue updates
        model_option: "a" for trellis, "b" for trellis-2 (premium), "c" for sam3d
        prompt_option: "a", "b", or "c" to select prompt enhancement version (defaults to "a")
    
    Returns:
        Tuple containing:
        - original_image_url: URL to the image generated from text
        - processed_image_url: URL to the background-removed image
        - prompt_enhancement: The prompt enhancement text that was used
    
    Raises:
        HTTPException: If any step in the process fails
    """
    logger.info(f"Starting image generation from text prompt: {prompt}")
    
    # Initialize the fal.ai API client
    fal_ai_client = FalApiClient()
    
    # Create temporary directory for background removal processing
    temp_dir = tempfile.mkdtemp()
    
    # Step 1: Generate image from text using specified model
    # Enhance the prompt for better 3D generation results
    # Select prompt enhancement based on model_option (a=regular, b/c=premium) and prompt_option (a, b, or c)
    if model_option.lower() == "b":
        # Premium (trellis-2)
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_A
    else:
        # Regular (trellis or sam3d)
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_A
    
    enhanced_prompt = f"{prompt}, {prompt_enhancement}"
    logger.info(f"Enhanced prompt: {enhanced_prompt}")
    
    logger.info("Generating image from text")
    original_image_url = await asyncio.get_event_loop().run_in_executor(
        None, fal_ai_client.generate_image_from_text, enhanced_prompt, model, status_callback
    )
    
    # Step 2: Remove background from generated image (preprocessing for better 3D generation)
    logger.info("Removing background from generated image")
    processed_image_url = await asyncio.get_event_loop().run_in_executor(
        None, remove_background_from_url, original_image_url, temp_dir
    )
    
    # Clean up temporary directory
    try:
        shutil.rmtree(temp_dir)
    except Exception as e:
        logger.warning(f"Failed to clean up temporary directory: {e}")
    
    logger.info("Successfully completed image generation and processing")
    return original_image_url, processed_image_url, enhanced_prompt


def generate_image_from_image(image_input: str, is_base64: bool = False, edit_prompt: str = None, model_option: str = "a", prompt_option: str = "a", status_callback: Optional[Callable[[str], None]] = None) -> tuple[str, str, str]:
    """
    Generate an edited image from an existing image using the fal.ai nano banana edit endpoint.
    Resizes the image to 700px height while maintaining aspect ratio and applies low-poly 3D videogame style.
    
    Args:
        image_input: Either a URL to an image or base64 encoded image data
        is_base64: Whether the image_input is base64 encoded data
        edit_prompt: Optional custom prompt for editing. If None, uses default 3D style prompt
        model_option: "a" for trellis, "b" for trellis-2 (premium), "c" for sam3d
        prompt_option: "a", "b", or "c" to select prompt enhancement version (defaults to "a")
        status_callback: Optional callback function(status) for queue updates
    
    Returns:
        Tuple of (resized_original_url, edited_image_url, prompt_enhancement)
        - resized_original_url: URL of the resized original image uploaded to fal.ai
        - edited_image_url: URL of the edited image from nano banana endpoint
        - prompt_enhancement: The prompt text that was used for editing
    """
    try:
        # Step 1: Handle image input and resize to 700px height with aspect ratio maintained
        if is_base64:
            # Decode base64 image
            # Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
            base64_data = image_input
            if base64_data.startswith('data:'):
                base64_data = base64_data.split(',', 1)[1] if ',' in base64_data else base64_data
            
            # Decode and load image
            image_data = base64.b64decode(base64_data)
            image = Image.open(BytesIO(image_data))
        else:
            # Download image from URL
            response = requests.get(image_input, timeout=30)
            response.raise_for_status()
            image = Image.open(BytesIO(response.content))
        
        # Apply EXIF orientation to fix rotated images from phones
        # This respects the EXIF orientation tag and rotates the image accordingly
        image = ImageOps.exif_transpose(image)
        
        # Resize image to 700px height while maintaining aspect ratio
        original_width, original_height = image.size
        new_height = 700
        new_width = int((original_width * new_height) / original_height)
        image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        # Convert to RGB if necessary
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Save to bytes for uploading
        img_buffer = BytesIO()
        image.save(img_buffer, format='JPEG', quality=95)
        img_buffer.seek(0)
        
        # Upload resized image to fal.ai storage
        resized_image_url = get_fal_client().upload(img_buffer.read(), "image/jpeg")
        
        # Step 2: Call fal.ai nano banana edit endpoint with shared prompt enhancement
        def on_queue_update(update):
            if isinstance(update, fal_client.Queued):
                if status_callback:
                    status_callback("queued")
            elif isinstance(update, fal_client.InProgress):
                if status_callback:
                    status_callback("processing")
                for log in update.logs:
                    logger.debug(f"Nano banana edit progress: {log['message']}")
        
        # Select prompt enhancement based on model_option (a=regular, b=premium) and prompt_option (a, b, or c)
        if model_option.lower() == "b":
            # Premium (trellis-2)
            if prompt_option.lower() == "c":
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_C
            elif prompt_option.lower() == "b":
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_B
            else:
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_A
        else:
            # Regular (trellis or sam3d)
            if prompt_option.lower() == "c":
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_C
            elif prompt_option.lower() == "b":
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_B
            else:
                prompt_enhancement_base = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_A

        # Use custom edit_prompt when provided, but still pass it through the
        # selected prompt enhancement so image-to-bricks keeps the same style
        # controls as text-to-bricks.
        if edit_prompt:
            prompt = f"{edit_prompt.strip()}, {prompt_enhancement_base}"
        else:
            prompt = f"Detect the main subject in this image. {prompt_enhancement_base}"
        
        logger.info(f"Submitting image to nano banana edit API with prompt: {prompt}")
        
        result = get_fal_client().subscribe(
            "fal-ai/nano-banana/edit",
            arguments={
                "prompt": prompt,
                "image_urls": [resized_image_url]
            },
            with_logs=True,
            on_queue_update=on_queue_update,
        )
        
        # Extract the edited image URL from the result
        if "images" not in result or not result["images"]:
            logger.error(f"No images in nano banana edit response: {result}")
            raise Exception("No images returned from nano banana edit endpoint")
        
        edited_image_url = result["images"][0]["url"]
        logger.info(f"Successfully edited image. Resized original URL: {resized_image_url[:50]}..., Edited URL: {edited_image_url[:50]}...")
        
        return resized_image_url, edited_image_url, prompt
        
    except Exception as e:
        logger.error(f"Error in generate_image_from_image: {str(e)}")
        raise Exception(f"Failed to edit image: {str(e)}")


def generate_image_from_text_with_reference_image(prompt: str) -> str:
    """
    Generate an image from a text prompt using the nano banana edit endpoint with a reference image.
    Uses the reference image at src/images/references.png to guide the style.
    
    Args:
        prompt: Text description of what to generate
    
    Returns:
        str: URL of the generated image that matches the reference style
    """
    try:
        import os
        
        # Get the reference image path
        current_dir = os.path.dirname(os.path.abspath(__file__))
        reference_image_path = os.path.join(current_dir, "..", "images", "references.png")
        reference_image_path = os.path.normpath(reference_image_path)
        
        if not os.path.exists(reference_image_path):
            raise Exception(f"Reference image not found at: {reference_image_path}")
        
        # Upload reference image to fal.ai storage
        with open(reference_image_path, 'rb') as img_file:
            reference_image_url = get_fal_client().upload(img_file.read(), "image/png")
        
        # Call fal.ai nano banana edit endpoint with reference image enhancement
        def on_queue_update(update):
            if isinstance(update, fal_client.InProgress):
                for log in update.logs:
                    logger.debug(f"Nano banana edit progress: {log['message']}")
        
        enhanced_prompt = f"{prompt}, {PROMPT_ENHANCEMENT_REFERENCE_IMAGE}"
        
        logger.info(f"Submitting text prompt with reference image to nano banana edit API with prompt: {enhanced_prompt}")
        
        result = get_fal_client().subscribe(
            "fal-ai/nano-banana/edit",
            arguments={
                "prompt": enhanced_prompt,
                "image_urls": [reference_image_url]
            },
            with_logs=True,
            on_queue_update=on_queue_update,
        )
        
        # Extract the generated image URL from the result
        if "images" not in result or not result["images"]:
            logger.error(f"No images in nano banana edit response: {result}")
            raise Exception("No images returned from nano banana edit endpoint")
        
        generated_image_url = result["images"][0]["url"]
        logger.info(f"Successfully generated image with reference style. Generated URL: {generated_image_url[:50]}...")
        
        return generated_image_url
        
    except Exception as e:
        logger.error(f"Error in generate_image_from_text_with_reference_image: {str(e)}")
        raise Exception(f"Failed to generate")


async def generate_image_from_text_streaming(
    prompt: str,
    queue: asyncio.Queue,
    model_option: str = "a",
    prompt_option: str = "a",
) -> Tuple[str, str, str]:
    """
    Generate an image using fal-ai/flux-2 streaming endpoint, forwarding
    intermediate diffusion frames as SSE events through the queue.
    The stream endpoint handles the full lifecycle — intermediate frames
    are forwarded for visual feedback, and the final event contains the
    completed image URL that feeds into background removal.

    Args:
        prompt: Text description of what to generate
        queue: asyncio.Queue to push SSE events onto for the streaming response
        model_option: "a" for regular, "b" for premium, "c" for sam3d
        prompt_option: "a", "b", or "c" to select prompt enhancement version

    Returns:
        Tuple of (original_image_url, processed_image_url, enhanced_prompt)
    """
    fal_key = os.getenv("FAL_KEY")
    if not fal_key:
        raise ValueError("FAL_KEY environment variable is required")

    # Select prompt enhancement (same logic as non-streaming path)
    if model_option.lower() == "b":
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_PREMIUM_OPTION_A
    else:
        if prompt_option.lower() == "c":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_C
        elif prompt_option.lower() == "b":
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_B
        else:
            prompt_enhancement = PROMPT_ENHANCEMENT_3D_REGULAR_OPTION_A

    enhanced_prompt = f"{prompt}, {prompt_enhancement}"
    logger.info(f"Enhanced prompt for flux-2 streaming: {enhanced_prompt}")

    stream_url = "https://fal.run/fal-ai/flux-2/stream"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Key {fal_key}",
    }
    payload = {
        "prompt": enhanced_prompt,
        "image_size": "square_hd",
        "num_inference_steps": 28,
        "output_format": "png",
        "enable_safety_checker": True,
        "guidance_scale": 2.5,
        "acceleration": "regular",
    }

    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_generation', 'status': 'starting', 'message': 'Starting generation...', 'progress': 0})}\n\n"
    )

    original_image_url = None
    sse_buffer = ""

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
        async with client.stream("POST", stream_url, headers=headers, json=payload) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                raise Exception(f"Flux-2 stream error ({response.status_code}): {error_body.decode()}")

            async for chunk in response.aiter_bytes():
                sse_buffer += chunk.decode("utf-8", errors="replace")

                while "\n\n" in sse_buffer:
                    block, sse_buffer = sse_buffer.split("\n\n", 1)

                    for line in block.split("\n"):
                        line = line.strip()
                        if not line.startswith("data: "):
                            continue
                        raw_data = line[6:]

                        try:
                            parsed = json.loads(raw_data)
                        except json.JSONDecodeError:
                            continue

                        # Extract image URL — try every shape fal might use
                        image_url = None
                        if "images" in parsed and parsed["images"]:
                            image_url = parsed["images"][0].get("url")
                        elif "output" in parsed and isinstance(parsed.get("output"), dict):
                            output = parsed["output"]
                            if "images" in output and output["images"]:
                                image_url = output["images"][0].get("url")
                        elif "image" in parsed and isinstance(parsed.get("image"), dict):
                            image_url = parsed["image"].get("url")
                        elif "url" in parsed and isinstance(parsed.get("url"), str):
                            image_url = parsed["url"]

                        if image_url:
                            original_image_url = image_url
                            progress = parsed.get("progress", 0)
                            partial = parsed.get("partial", True)
                            await queue.put(
                                f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_generation', 'status': 'streaming', 'message': 'Processing input...', 'image_url': image_url, 'progress': progress, 'partial': partial})}\n\n"
                            )
                        elif parsed.get("status") == "error" or parsed.get("type") == "error" or parsed.get("event") == "error":
                            error_msg = parsed.get("message") or parsed.get("error") or "Flux-2 error"
                            raise Exception(error_msg)
                        else:
                            msg = parsed.get("message") or parsed.get("status") or "Processing..."
                            await queue.put(
                                f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_generation', 'status': 'processing', 'message': msg})}\n\n"
                            )

    if not original_image_url:
        raise Exception("Flux-2 stream completed without producing an image")

    logger.info(f"Flux-2 final image from stream: {original_image_url[:80] + '...' if len(original_image_url) > 80 else original_image_url}")

    # If the streaming endpoint returned a data: URI instead of an HTTPS URL,
    # decode the base64 payload and upload to fal.ai to get a proper CDN URL.
    if original_image_url.startswith("data:"):
        logger.info("Flux-2 stream returned a data: URI — uploading to fal.ai storage")
        try:
            # Strip the data:image/...;base64, prefix
            header, b64_data = original_image_url.split(",", 1)
            image_bytes = base64.b64decode(b64_data)
            uploaded_url = get_fal_client().upload(image_bytes, "image/png")
            logger.info(f"Uploaded data-URI image to fal.ai: {uploaded_url[:80]}...")
            original_image_url = uploaded_url
        except Exception as e:
            logger.error(f"Failed to upload data-URI image to fal.ai: {e}")
            raise Exception("Failed to convert streaming image data URI to a URL") from e

    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_generation', 'status': 'completed', 'message': 'Image generated!', 'image_url': original_image_url, 'progress': 100})}\n\n"
    )

    # --- Background removal ---
    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'background_removal', 'message': 'Processing environment...', 'progress': 0})}\n\n"
    )

    temp_dir = tempfile.mkdtemp()
    try:
        loop = asyncio.get_running_loop()
        processed_image_url = await loop.run_in_executor(
            None, remove_background_from_url, original_image_url, temp_dir
        )
    finally:
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass

    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'background_removal', 'message': 'Background removed', 'progress': 100, 'image_url': processed_image_url})}\n\n"
    )

    logger.info(f"Streaming image generation complete: original={original_image_url[:80]}..., processed={processed_image_url[:80]}...")
    return original_image_url, processed_image_url, enhanced_prompt


async def generate_image_from_image_streaming(
    image_url: str,
    queue: asyncio.Queue,
    is_base64: bool = False,
    model_option: str = "a",
    prompt_option: str = "a",
    edit_prompt: Optional[str] = None,
) -> Tuple[str, str, str]:
    """
    Streaming version of generate_image_from_image that sends SSE events
    for fal.ai queue status (queued, processing, completed) through the queue.
    Uses the nano-banana edit endpoint to preprocess images for 3D generation.

    Args:
        image_url: URL or base64 data of the image to edit
        queue: asyncio.Queue to push SSE events onto for the streaming response
        is_base64: Whether image_url is base64 encoded data
        model_option: "a" for regular, "b" for premium, "c" for sam3d
        prompt_option: "a", "b", or "c" to select prompt enhancement version
        edit_prompt: Optional custom prompt to combine with the selected enhancement

    Returns:
        Tuple of (resized_original_url, edited_image_url, prompt_enhancement)
    """
    loop = asyncio.get_running_loop()

    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_editing', 'status': 'starting', 'message': 'Processing image...', 'progress': 0})}\n\n"
    )

    last_status = [None]

    def status_callback(status: str):
        """Sync callback that forwards fal.ai queue status to SSE stream."""
        if status == last_status[0]:
            return
        last_status[0] = status
        if status == "queued":
            event = {'type': 'pipeline', 'stage': 'image_editing', 'status': 'queued', 'message': 'Queued for image processing...'}
        else:
            event = {'type': 'pipeline', 'stage': 'image_editing', 'status': 'processing', 'message': 'Processing image...'}
        asyncio.run_coroutine_threadsafe(
            queue.put(f"data: {json.dumps(event)}\n\n"),
            loop,
        )

    resized_original_url, edited_image_url, prompt_enhancement = await loop.run_in_executor(
        None,
        generate_image_from_image,
        image_url,
        is_base64,
        edit_prompt,
        model_option,
        prompt_option,
        status_callback,
    )

    await queue.put(
        f"data: {json.dumps({'type': 'pipeline', 'stage': 'image_editing', 'status': 'completed', 'message': 'Image editing complete!', 'image_url': edited_image_url, 'progress': 100})}\n\n"
    )

    logger.info(f"Streaming image editing complete: resized={resized_original_url[:80]}..., edited={edited_image_url[:80]}...")
    return resized_original_url, edited_image_url, prompt_enhancement
