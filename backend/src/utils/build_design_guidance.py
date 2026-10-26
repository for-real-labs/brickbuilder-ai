"""BrickBuilder product defaults shared by model-building entry points."""

BUILD_DESIGN_GUIDANCE = (
    "Create a three-dimensional LEGO model by default, with real depth, volume, "
    "and recognizable geometry when viewed from the front, sides, and back. "
    "For uploaded images, build the depicted subject in 3D: use its silhouette, "
    "colors, and defining features as reference and infer plausible unseen sides. "
    "A photograph, portrait, illustration, logo, or other flat reference image is "
    "not a request for a flat build. Only create a mosaic, pixel-art panel, relief, "
    "or other intentionally flat representation when the user explicitly asks "
    "for that format. Do not choose a mosaic as a shortcut for a difficult subject. "
    "Explicit user requests for those formats take precedence over the 3D default. "
    "When editing or resuming an existing model, preserve its established format "
    "unless the user asks to change it."
)


def guided_build_prompt(prompt: str | None) -> str:
    """Keep the user's request intact while supplying the app's design default."""
    return (BUILD_DESIGN_GUIDANCE + "\n\nUser request:\n"
            + (prompt or "Create a model from the reference image."))
