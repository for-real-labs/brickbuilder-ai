import asyncio
from types import SimpleNamespace

from src.utils import reference_views
from src.utils.generation_storage import GenerationStorage


def test_generate_missing_reference_views_returns_complete_existing_map(monkeypatch):
    existing = {
        name: f"https://example.com/{name}.png"
        for name in reference_views.REFERENCE_VIEW_NAMES
    }

    def unexpected_generation(*_args):
        raise AssertionError("complete reference maps must not call the image model")

    monkeypatch.setattr(reference_views, "_generate_reference_view", unexpected_generation)

    result = asyncio.run(
        reference_views.generate_missing_reference_views(
            "https://example.com/primary.png",
            existing,
        )
    )

    assert result == existing


def test_generate_missing_reference_views_generates_only_absent_views(monkeypatch):
    existing = {
        "front": "https://example.com/front.png",
        "unknown": "https://example.com/unknown.png",
        "top": "not-a-url",
    }
    calls = []

    def fake_generation(view_name, image_urls):
        calls.append((view_name, image_urls))
        return f"https://generated.example/{view_name}.png"

    monkeypatch.setattr(reference_views, "_generate_reference_view", fake_generation)

    result = asyncio.run(
        reference_views.generate_missing_reference_views(
            "https://example.com/primary.png",
            existing,
        )
    )

    assert set(result) == set(reference_views.REFERENCE_VIEW_NAMES)
    assert result["front"] == existing["front"]
    assert {view_name for view_name, _ in calls} == {"back", "side", "top"}
    assert all(
        image_urls == ["https://example.com/primary.png", existing["front"]]
        for _, image_urls in calls
    )


def test_generate_reference_view_uses_nano_banana_lite_edit(monkeypatch):
    captured = {}
    monkeypatch.setenv("FAL_KEY", "test-key")

    def fake_subscribe(model, **kwargs):
        captured["model"] = model
        captured.update(kwargs)
        return {"images": [{"url": "https://example.com/generated.png"}]}

    monkeypatch.setattr(reference_views, "get_fal_client", lambda: SimpleNamespace(subscribe=fake_subscribe))

    result = reference_views._generate_reference_view(
        "back",
        ["https://example.com/primary.png"],
    )

    assert result == "https://example.com/generated.png"
    assert captured["model"] == "google/nano-banana-lite/edit"
    assert captured["arguments"]["image_urls"] == ["https://example.com/primary.png"]
    assert "rear view" in captured["arguments"]["prompt"]


def test_store_reference_images_merges_existing_generation_views(monkeypatch):
    storage = object.__new__(GenerationStorage)
    uploaded_paths = []

    async def fake_upload(source_url, file_path, content_type):
        uploaded_paths.append((source_url, file_path, content_type))
        return f"https://supabase.example/{file_path}"

    async def fake_get_generation(_generation_id):
        return {"reference_images": {"front": "https://supabase.example/front.png"}}

    class FakeResult:
        data = [{"id": "generation"}]

    class FakeQuery:
        def __init__(self):
            self.payload = None

        def update(self, payload):
            self.payload = payload
            return self

        def eq(self, *_args):
            return self

        def execute(self):
            observed["payload"] = self.payload
            return FakeResult()

    class FakeClient:
        def table(self, name):
            assert name == "generations"
            return FakeQuery()

    observed = {}
    storage.client = FakeClient()
    monkeypatch.setattr(storage, "_download_and_upload_from_url", fake_upload)
    monkeypatch.setattr(storage, "get_generation", fake_get_generation)

    stored = asyncio.run(
        storage.store_reference_images(
            "generation",
            {"back": "https://fal.example/back.png"},
        )
    )

    assert set(stored) == {"back"}
    assert observed["payload"]["reference_images"] == {
        "front": "https://supabase.example/front.png",
        "back": stored["back"],
    }
    assert uploaded_paths[0][0] == "https://fal.example/back.png"
    assert "/reference_back_" in uploaded_paths[0][1]
