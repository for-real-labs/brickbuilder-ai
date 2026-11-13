import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from src.requests import llmToBricks as basic
from src.requests.novaToBricks import NovaToBricksRequest
from src.utils.parts_limit import enforce_parts_limit

PART = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"


@pytest.mark.parametrize("request_type", [basic.LlmToBricksRequest, NovaToBricksRequest])
def test_limits_are_optional_strict_positive_integers(request_type):
    assert request_type(prompt="castle").max_parts is None
    assert request_type(prompt="castle", max_parts=12).max_parts == 12
    for value in [0, -1, 1.5, True, "12", 100001]:
        with pytest.raises(ValidationError):
            request_type(prompt="castle", max_parts=value)


def test_counts_root_physical_placements():
    model = f"0 FILE model.ldr\n{PART}\n{PART}\n0 FILE unused.ldr\n{PART}"
    enforce_parts_limit(model, None)
    enforce_parts_limit(model, 2)
    with pytest.raises(ValueError, match="2 physical parts; maximum is 1"):
        enforce_parts_limit(model, 1)


def test_explicit_limit_overrides_basic_edit_and_new_model_guidance():
    for source in [None, "previous"]:
        request = basic.LlmToBricksRequest(prompt="huge castle", generation_id=source, max_parts=20)
        assert "at most 20" in basic._model_size_guidance(request)
        assert "allow the brick count to grow" not in basic._model_size_guidance(request)


def test_basic_final_limit_blocks_storage_and_charging(monkeypatch):
    monkeypatch.setattr(basic, "_generate_ldr", AsyncMock(return_value=basic.LlmBuild(ldr=PART + "\n" + PART)))
    monkeypatch.setattr(basic.generation_storage, "update_status", AsyncMock())
    save = AsyncMock()
    charge = AsyncMock()
    monkeypatch.setattr(basic.generation_storage, "store_model_file", save)
    monkeypatch.setattr(basic, "deduct_credits", charge)
    monkeypatch.setattr(basic, "track_error", lambda **kwargs: None)
    request = basic.LlmToBricksRequest(prompt="castle", max_parts=1)
    asyncio.run(basic.process_llm_to_bricks_task("test", request, {"user_email": "test", "is_developer": False}, {}))
    save.assert_not_awaited()
    charge.assert_not_awaited()
    assert any(call.args[1] == "failed" for call in basic.generation_storage.update_status.call_args_list)
