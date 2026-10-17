"""Input origin is independent of the rendering pipeline and composer mode."""
INPUT_TYPES = frozenset({'text', 'image', 'glb', 'ldraw', 'unknown'})
ENTRY_PAGES = frozenset({'/', '/image-to-lego', '/photo-to-lego', '/glb-to-lego',
                         '/use-ai-to-edit-ldraw', '/generated-model',
                         '/image-to-3d', '/image-to-glb', '/image-to-obj'})


def infer_input_type(endpoint: str) -> str:
    return {'textToBricks': 'text', 'imageToBricks': 'image',
            'glbToBricks': 'glb', 'uploadLdraw': 'ldraw'}.get(endpoint, 'unknown')


def normalize_entry_page(value: str | None) -> str | None:
    # Store a known pathname only, never query strings, tokens, or arbitrary URLs.
    return value if value in ENTRY_PAGES else None
