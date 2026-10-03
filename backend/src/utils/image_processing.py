import os
import logging
import time
import traceback
import requests
import base64
from io import BytesIO
from PIL import Image, ImageOps

from .fal_provider_client import get_fal_client

# Configure logging
logger = logging.getLogger(__name__)


# Background removal backend: "fal" (fal.ai BiRefNet v2, GPU) or "rembg" (local CPU)
BACKGROUND_REMOVAL_BACKEND = "fal"

# Module-level cache for rembg sessions to avoid reloading the model on every request
_rembg_sessions: dict = {}


def _get_rembg_session(model_name: str = 'u2net'):
    """Get or create a cached rembg session."""
    if model_name not in _rembg_sessions:
        from rembg import new_session
        logger.info(f"Creating rembg session for model '{model_name}' (first use, will be cached)")
        _rembg_sessions[model_name] = new_session(model_name)
    return _rembg_sessions[model_name]


def remove_background_from_url(image_url: str, temp_dir: str, model_name: str = 'u2net') -> str:
    """
    Remove background from an image URL.
    Uses fal.ai BiRefNet v2 (GPU) or local rembg (CPU) based on BACKGROUND_REMOVAL_BACKEND.
    
    Args:
        image_url: URL of the image to process
        temp_dir: Temporary directory for processing
        model_name: rembg model to use when backend is 'rembg'
    """
    import numpy as np

    try:
        # --- Load image (shared by both backends) ---
        if image_url.startswith("data:"):
            logger.info("Image is a data: URI — decoding inline")
            _header, b64_data = image_url.split(",", 1)
            image_bytes = base64.b64decode(b64_data)
            input_image = Image.open(BytesIO(image_bytes))
        else:
            response = requests.get(image_url, timeout=30)
            response.raise_for_status()
            input_image = Image.open(BytesIO(response.content))

        input_image = ImageOps.exif_transpose(input_image)

        # --- Remove background ---
        if BACKGROUND_REMOVAL_BACKEND == "fal":
            # Upload data: URIs to fal.ai storage so BiRefNet can access them
            if image_url.startswith("data:"):
                image_url = get_fal_client().upload(image_bytes, "image/png")

            logger.info(f"Calling fal.ai BiRefNet v2 for background removal: {image_url[:80]}...")
            result = get_fal_client().subscribe(
                "fal-ai/birefnet/v2",
                arguments={"image_url": image_url},
            )
            result_url = result["image"]["url"]
            logger.info(f"BiRefNet returned: {result_url[:80]}...")

            resp = requests.get(result_url, timeout=30)
            resp.raise_for_status()
            output_image = Image.open(BytesIO(resp.content)).convert("RGBA")
        else:
            # Local rembg (CPU)
            from rembg import remove
            session = _get_rembg_session(model_name)
            output_image = remove(input_image, session=session)

        # --- Auto-crop transparent pixels ---
        alpha = output_image.split()[-1]
        alpha_np = np.array(alpha)
        alpha_np[alpha_np < 10] = 0
        thresholded = output_image.copy()
        thresholded.putalpha(Image.fromarray(alpha_np))
        bbox = thresholded.getbbox()
        if bbox:
            original_size = output_image.size
            output_image = output_image.crop(bbox)
            logger.info(f"Auto-cropped image from {original_size} to {output_image.size}")

        # --- Save and upload to fal.ai storage ---
        processed_path = os.path.join(temp_dir, "processed_image.png")
        output_image.save(processed_path)

        max_retries = 3
        processed_url = None
        with open(processed_path, 'rb') as f:
            img_bytes = f.read()
        for attempt in range(max_retries):
            try:
                processed_url = get_fal_client().upload(img_bytes, "image/png")
                break
            except Exception as upload_err:
                if attempt < max_retries - 1:
                    wait = 2 ** attempt
                    logger.warning(f"fal.ai upload attempt {attempt + 1}/{max_retries} failed: {upload_err}. Retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise

        logger.info(f"Background removed ({BACKGROUND_REMOVAL_BACKEND}). Processed: {processed_url[:80]}...")

        try:
            os.unlink(processed_path)
        except Exception:
            pass

        return processed_url

    except ImportError:
        logger.error("rembg not installed, skipping background removal")
        return image_url
    except Exception as e:
        err_msg = str(e)
        if len(err_msg) > 200:
            err_msg = err_msg[:200] + "...[truncated]"
        logger.error(f"Background removal failed: {err_msg}")
        return image_url


def convert_base64_to_png(base64_data: str, output_path: str) -> str:
    """
    Convert base64 image data to PNG file
    
    Args:
        base64_data: Base64 encoded image data
        output_path: Path where to save the PNG file
    
    Returns:
        Path to the saved PNG file
    """
    try:
        # Decode base64 data
        image_data = base64.b64decode(base64_data)
        
        # Load image with PIL
        image = Image.open(BytesIO(image_data))
        
        # Apply EXIF orientation to fix rotated images from phones
        image = ImageOps.exif_transpose(image)
        
        # Convert to RGB if necessary (for PNG compatibility)
        if image.mode in ('RGBA', 'LA', 'P'):
            # Keep transparency for these modes
            if image.mode == 'P':
                image = image.convert('RGBA')
        elif image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Save as PNG
        image.save(output_path, 'PNG')
        logger.info(f"Successfully converted base64 image to PNG: {output_path}")
        
        return output_path
        
    except Exception as e:
        logger.error(f"Failed to convert base64 to PNG: {e}")
        raise


# The edit_image function has been moved to generate_image.py and renamed to generate_image_from_image
