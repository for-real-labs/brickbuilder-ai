import asyncio
import json
from pathlib import Path

import pytest

from src.utils import local_provider_agent as module


class Input:
    def __init__(self):
        self.payload = b""
    def write(self, payload):
        self.payload += payload
    async def drain(self):
        pass
    def close(self):
        pass


class Process:
    def __init__(self, events, exit_code=0):
        self.stdin = Input()
        self.stdout = asyncio.StreamReader()
        for event in events:
            self.stdout.feed_data(json.dumps(event).encode() + b"\n")
        self.stdout.feed_eof()
        self.returncode = exit_code
    async def wait(self):
        return self.returncode


@pytest.fixture
def runtime(monkeypatch):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    monkeypatch.setattr(module.shutil, "which", lambda binary: "/fake/" + binary)
    async def ready(_provider):
        return True
    monkeypatch.setattr(module, "cli_connected", ready)


def test_openai_native_turn_preserves_model_disables_shell_and_returns_only_final_answer(runtime, monkeypatch, tmp_path):
    invocations = []
    async def spawn(*command, **kwargs):
        invocations.append((command, kwargs))
        Path(command[command.index("--output-last-message") + 1]).write_text('{"tool_calls":[],"text":"Ready"}')
        return Process([{"type": "item.completed", "item": {"type": "agent_message", "text": "Earlier text"}}])
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spawn)
    result = asyncio.run(module.run_cli_agent("openai", tmp_path, "Design a castle", "gpt-5.6-sol"))
    assert result == '{"tool_calls":[],"text":"Ready"}'
    command, kwargs = invocations[0]
    assert command[command.index("--model") + 1] == "gpt-5.6-sol"
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert "--ignore-user-config" in command and "shell_tool" in command and "code_mode_host" in command
    assert "--dangerously-bypass-approvals-and-sandbox" not in command
    assert kwargs["start_new_session"] is True
    assert not list(tmp_path.glob(".native-turn-*"))


def test_claude_receives_images_as_stdin_content_with_native_tools_disabled(runtime, monkeypatch, tmp_path):
    captures = []
    async def spawn(*command, **kwargs):
        process = Process([{"type": "result", "result": "result JSON", "is_error": False}])
        captures.append((command, process))
        return process
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spawn)
    image = tmp_path / "view.png"
    image.write_bytes(b"image-pixels")
    assert asyncio.run(module.run_cli_agent("anthropic", tmp_path, "Review", "claude-opus-5", image_paths=[image])) == "result JSON"
    command, process = captures[0]
    assert command[command.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in command and "--no-chrome" in command
    content = json.loads(process.stdin.payload)["message"]["content"]
    assert content[0] == {"type": "text", "text": "Review"}
    assert content[1]["source"]["media_type"] == "image/png"
    assert str(image) not in process.stdin.payload.decode()


def test_native_inference_requires_local_opt_in(monkeypatch, tmp_path):
    monkeypatch.delenv("BRICKBUILDER_LOCAL_PROVIDERS", raising=False)
    with pytest.raises(ValueError, match="local development"):
        asyncio.run(module.run_cli_agent("openai", tmp_path, "prompt"))


def test_native_inference_requires_subscription_login(runtime, monkeypatch, tmp_path):
    async def disconnected(_provider):
        return False
    monkeypatch.setattr(module, "cli_connected", disconnected)
    with pytest.raises(ValueError, match="Sign in"):
        asyncio.run(module.run_cli_agent("openai", tmp_path, "prompt"))


def test_native_errors_do_not_relay_provider_runtime_error_content(runtime, monkeypatch, tmp_path):
    async def spawn(*_command, **_kwargs):
        return Process([{"type": "result", "result": "access_token=secret", "is_error": True}])
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(ValueError) as error:
        asyncio.run(module.run_cli_agent("anthropic", tmp_path, "prompt"))
    assert "secret" not in str(error.value)


def test_native_inference_timeout_terminates_the_process(runtime, monkeypatch, tmp_path):
    terminated = []
    async def spawn(*_command, **_kwargs):
        process = Process([])
        process.stdout = asyncio.StreamReader()
        return process
    async def stop(process):
        terminated.append(process)
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(module, "stop_process", stop)
    monkeypatch.setattr(module, "CLI_TURN_TIMEOUT_SECONDS", 0.01)
    with pytest.raises(ValueError, match="too long"):
        asyncio.run(module.run_cli_agent("openai", tmp_path, "prompt"))
    assert len(terminated) == 1


def test_native_inference_cancellation_terminates_the_process(runtime, monkeypatch, tmp_path):
    terminated = []
    async def spawn(*_command, **_kwargs):
        process = Process([])
        process.stdout = asyncio.StreamReader()
        return process
    async def stop(process):
        terminated.append(process)
    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(module, "stop_process", stop)
    async def cancel():
        task = asyncio.create_task(module.run_cli_agent("openai", tmp_path, "prompt"))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(cancel())
    assert len(terminated) == 1
