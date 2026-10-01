import asyncio

from src.requests import resizeModel as module
from src.requests.resizeModel import ResizeModelRequest

DESIGN_VOXELS = "\n".join(f"{x} {y} {z} 201 26 9" for x in range(4) for y in range(4) for z in range(2))


class FakeStorage:
    def __init__(self):
        self.stored = []
        self.statuses = []

    async def create_generation(self, **kwargs):
        self.created = kwargs
        return "resized-1"

    async def download_file_from_storage(self, url):
        assert url == "https://example.com/design.xyzrgb"
        return DESIGN_VOXELS.encode()

    async def store_model_file(self, generation_id, file_content, file_type, **_kwargs):
        self.stored.append((generation_id, file_type, file_content))

    async def update_status(self, generation_id, status, *_args):
        self.statuses.append((generation_id, status))


def test_resize_rescales_llm_design_voxels(monkeypatch):
    storage = FakeStorage()
    spawned = []

    async def fake_generation(_generation_id, _auth):
        return {"design_voxels_url": "https://example.com/design.xyzrgb", "model_used_3d": "claude-opus-5-5"}

    def fake_start_task(generation_id, coro):
        spawned.append(generation_id)
        coro.close()

    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "get_generation_or_404", fake_generation)
    monkeypatch.setattr(module, "handle_auth_and_tracking", lambda **_kwargs: {
        "user_email": "anon", "is_anonymous": True, "is_developer": False})
    monkeypatch.setattr(module, "start_generation_task", fake_start_task)

    response = asyncio.run(module.resize_model(
        ResizeModelRequest(generation_id="llm-1", detail_level=8), {"user_id": "anon-1"}))

    assert response.generation_id == "resized-1"
    cells = [tuple(map(int, line.split())) for line in response.xyzrgb_content.splitlines()]
    assert max(c[0] for c in cells) == 7 and max(c[2] for c in cells) == 3  # grown 2x on every axis
    assert ("resized-1", "xyzrgb", response.xyzrgb_content) in storage.stored
    assert ("resized-1", "resizing") in storage.statuses
    assert storage.created["model_3d"] == "claude-opus-5-5"
    assert spawned == ["resized-1"]


def test_resize_sources_are_carried_to_derived_generations():
    assert "design_voxels_url" in module.RESIZE_SOURCE_KEYS
    assert "sam3d_voxel_data_url" in module.RESIZE_SOURCE_KEYS
