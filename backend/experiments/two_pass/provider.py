"""Two vision calls with a per-design budget, using native provider token counts."""

import base64
from io import BytesIO
import os
import httpx
from PIL import Image, ImageOps

MODELS = {"astra": "gpt-6.2-astra", "fable": "claude-fable-5-2"}
# Standard synchronous pricing in USD per million tokens; no optional caching.
INPUT = 8
OUTPUT = 40


def encode(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((1150, 1150))
        buf = BytesIO()
        im.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


def invoke(arm, instructions, text, images, budget):
    model = MODELS[arm]
    pictures = [encode(p) for p in images]
    if arm == "astra":
        base = "https://api.openai.com/v1/responses"
        headers = {"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}
        blocks = [{"type": "input_text", "text": text}] + [
            {
                "type": "input_image",
                "detail": "high",
                "image_url": "data:image/jpeg;base64," + im,
            }
            for im in pictures
        ]
        data = {
            "model": model,
            "instructions": instructions,
            "input": [{"role": "user", "content": blocks}],
        }
        count_url = base + "/input_tokens"
    else:
        base = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
        }
        blocks = [{"type": "text", "text": text}] + [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": im},
            }
            for im in pictures
        ]
        data = {
            "model": model,
            "system": instructions,
            "messages": [{"role": "user", "content": blocks}],
        }
        count_url = base + "/count_tokens"

    def post(url, body):
        response = httpx.post(url, headers=headers, json=body, timeout=300)
        if response.is_error:
            raise ValueError(
                f"{model}: {response.status_code} "
                + str(response.json().get("error", {}).get("message", ""))[:250]
            )
        return response.json()

    n = post(count_url, data)["input_tokens"]
    # Reserve a token-estimation margin, including provider-side wrappers.
    ceiling = int((budget * 1e6 - INPUT * (n * 1.04 + 160)) / OUTPUT)
    if ceiling < 128:
        raise ValueError("Remaining budget insufficient")
    if arm == "astra":
        data.update(
            store=False,
            service_tier="default",
            reasoning={"effort": "low"},
            max_output_tokens=ceiling,
        )
    else:
        data.update(max_tokens=ceiling, output_config={"effort": "low"})
    response = post(base, data)
    u = response["usage"]
    out = u["output_tokens"]
    if arm == "astra":
        cached = u.get("input_tokens_details", {}).get("cached_tokens", 0)
        cost = (
            INPUT * (u["input_tokens"] - cached) + 0.4 * cached + OUTPUT * out
        ) / 1e6
        answer = "".join(
            x["text"]
            for m in response["output"]
            for x in m.get("content", [])
            if x["type"] == "output_text"
        )
    else:
        cost = (
            INPUT * u["input_tokens"]
            + 10 * u.get("cache_creation_input_tokens", 0)
            + 0.2 * u.get("cache_read_input_tokens", 0)
            + OUTPUT * out
        ) / 1e6
        answer = "".join(x["text"] for x in response["content"] if x["type"] == "text")
    return answer, {
        "model": model,
        "input_count": n,
        "output_limit": ceiling,
        "usage": u,
        "cost": cost,
    }
