import base64
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

from src.utils import fal_provider_client as module
from src.utils.falApiClient import FalApiClient
from src.utils import generate_image, image_processing, reference_views


@pytest.fixture
def sdk(monkeypatch):
    operations = []
    clients = []
    class Client:
        def __init__(self, key):
            self.key = key
            clients.append(self)
        def upload(self, data, content_type):
            operations.append((self.key, "upload", content_type))
            return "https://example.com/uploaded.png"
        def subscribe(self, endpoint, **kwargs):
            operations.append((self.key, "subscribe", endpoint))
            return {"images": [{"url": "https://example.com/generated.png"}],
                    "image": {"url": "https://example.com/background.png"},
                    "model_glb": {"url": "https://example.com/model.glb"},
                    "model_mesh": {"url": "https://example.com/model.glb"}}
    monkeypatch.setattr(module.fal_client, "SyncClient", Client)
    return operations, clients


def png_bytes():
    buffer = BytesIO()
    Image.new("RGBA", (10, 10), (255, 0, 0, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def test_new_clients_capture_current_project_key_without_mutating_existing_client(sdk, monkeypatch):
    monkeypatch.setenv("FAL_KEY", "first-id:first-secret")
    first = module.get_fal_client()
    monkeypatch.setenv("FAL_KEY", "second-id:second-secret")
    second = module.get_fal_client()
    assert first is not second
    assert first.key == "first-id:first-secret" and second.key == "second-id:second-secret"
    monkeypatch.delenv("FAL_KEY")
    with pytest.raises(ValueError, match="not configured"):
        module.get_fal_client()


@pytest.mark.parametrize("model", ["sam3d", "trellis", "trellis-2"])
def test_reused_3d_facade_uses_updated_key_for_each_request(sdk, monkeypatch, model):
    facade = FalApiClient()
    monkeypatch.setenv("FAL_KEY", "first-id:first-secret")
    facade.generate_3d_model("https://example.com/input.png", model)
    monkeypatch.setenv("FAL_KEY", "second-id:second-secret")
    facade.generate_3d_model("https://example.com/input.png", model)
    assert [entry[0] for entry in sdk[0]] == ["first-id:first-secret", "second-id:second-secret"]


def test_text_and_upload_facade_operations_use_updated_key(sdk, monkeypatch):
    facade = FalApiClient()
    monkeypatch.setenv("FAL_KEY", "first-id:first-secret")
    facade.upload_base64_image(base64.b64encode(png_bytes()).decode())
    monkeypatch.setenv("FAL_KEY", "second-id:second-secret")
    facade.generate_image_from_text("a castle", "flux-schnell")
    assert [entry[0] for entry in sdk[0]] == ["first-id:first-secret", "second-id:second-secret"]


def test_image_edit_upload_and_subscription_follow_project_key_changes(sdk, monkeypatch):
    source = base64.b64encode(png_bytes()).decode()
    for key in ["first-id:first-secret", "second-id:second-secret"]:
        monkeypatch.setenv("FAL_KEY", key)
        generate_image.generate_image_from_image(source, is_base64=True)
    assert [entry[0] for entry in sdk[0]] == ["first-id:first-secret"] * 2 + ["second-id:second-secret"] * 2


def test_background_removal_uploads_and_subscription_follow_key_changes(sdk, monkeypatch, tmp_path):
    data = png_bytes()
    source = "data:image/png;base64," + base64.b64encode(data).decode()
    monkeypatch.setattr(image_processing.requests, "get", lambda *_args, **_kwargs: SimpleNamespace(
        content=data, raise_for_status=lambda: None))
    for key in ["first-id:first-secret", "second-id:second-secret"]:
        monkeypatch.setenv("FAL_KEY", key)
        assert image_processing.remove_background_from_url(source, str(tmp_path)) == "https://example.com/uploaded.png"
    assert [entry[0] for entry in sdk[0]] == ["first-id:first-secret"] * 3 + ["second-id:second-secret"] * 3


def test_directional_reference_generation_follows_key_changes(sdk, monkeypatch):
    for key in ["first-id:first-secret", "second-id:second-secret"]:
        monkeypatch.setenv("FAL_KEY", key)
        reference_views._generate_reference_view("back", ["https://example.com/input.png"])
    assert [entry[0] for entry in sdk[0]] == ["first-id:first-secret", "second-id:second-secret"]
