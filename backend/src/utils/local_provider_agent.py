"""Text/image inference through official signed-in CLIs for local agent builds.

The application owns the JEB tool loop. Native CLI tools, MCP connections and
shell execution are disabled; a model only returns the next structured turn.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import tempfile
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path

from .local_provider_connections import (
    cli_connected, local_providers_enabled, native_cli_environment, provider_config, stop_process,
)

MAX_OUTPUT_BYTES = 8_000_000
MAX_IMAGE_BYTES = 6_000_000
MAX_IMAGES_PER_TURN = 13  # User reference plus all twelve possible tool previews.
MAX_TOTAL_IMAGE_BYTES = 32_000_000
CLI_TURN_TIMEOUT_SECONDS = 600
OutputCallback = Callable[[str], Awaitable[None]]


def _image_content(image_paths: Sequence[Path]) -> list[dict]:
    content = []
    total_bytes = 0
    for path in image_paths:
        data = Path(path).read_bytes()
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("The native agent reference image is too large")
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_IMAGE_BYTES:
            raise ValueError("The native agent images exceed the total image size limit")
        suffix = Path(path).suffix.lower()
        media_type = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(suffix)
        if media_type is None:
            raise ValueError("Native agent reference images must be PNG, JPEG or WebP")
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type,
                                                  "data": base64.b64encode(data).decode("ascii")}})
    return content


def _native_command(provider: str, model: str | None, response_path: Path, image_paths: Sequence[Path]) -> list[str]:
    executable = shutil.which(provider_config(provider).executable)
    if not executable:
        raise ValueError("Install the official provider CLI before using native sign-in")
    if provider == "openai":
        command = [executable, "exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
                   "--ephemeral", "--sandbox", "read-only", "--json", "--color", "never",
                   "--output-last-message", str(response_path), "-c", 'web_search="disabled"']
        for feature in ("shell_tool", "unified_exec", "code_mode", "code_mode_host", "apps",
                        "computer_use", "browser_use", "browser_use_external", "image_generation", "hooks"):
            command.extend(["--disable", feature])
        for path in image_paths:
            command.extend(["--image", str(Path(path).resolve())])
    else:
        command = [executable, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
                   "--verbose", "--tools", "", "--permission-mode", "dontAsk", "--setting-sources", "",
                   "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--no-session-persistence", "--disable-slash-commands", "--no-chrome"]
    if model:
        command.extend(["--model", model])
    return command


async def run_cli_agent(
    provider: str,
    workspace: Path,
    prompt: str,
    model: str | None = None,
    on_output: OutputCallback | None = None,
    image_paths: Sequence[Path] = (),
) -> str:
    """Run one inference turn; caller supplies an app-owned tool transcript."""
    if not local_providers_enabled():
        raise ValueError("Native provider sign-in is available only in local development")
    if provider not in {"openai", "anthropic"}:
        raise ValueError("Native agent inference supports ChatGPT and Claude")
    if model and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", model):
        raise ValueError("Invalid native model ID")
    if len(prompt.encode("utf-8")) > MAX_OUTPUT_BYTES or len(image_paths) > MAX_IMAGES_PER_TURN:
        raise ValueError("The native agent context is too large")
    if not await cli_connected(provider):
        raise ValueError("Sign in to the provider before starting a native agent build")
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    # Validate images before spawning either CLI. Claude receives pixels via
    # stdin rather than a Read tool or broad access to the host filesystem.
    images = _image_content(image_paths)
    if on_output:
        await on_output("Reasoning about the next build step.\n")
    with tempfile.TemporaryDirectory(prefix=".native-turn-", dir=workspace) as turn_directory:
        response_path = Path(turn_directory) / "response.txt"
        command = _native_command(provider, model, response_path, image_paths)
        if provider == "anthropic":
            payload = json.dumps({"type": "user", "message": {"role": "user", "content": [
                {"type": "text", "text": prompt}, *images]}}).encode("utf-8") + b"\n"
        else:
            payload = prompt.encode("utf-8")
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *command, cwd=workspace, env=native_cli_environment(), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True, limit=MAX_OUTPUT_BYTES + 1, umask=0o077,
            )
            async def collect() -> str:
                process.stdin.write(payload)
                await process.stdin.drain()
                process.stdin.close()
                size = 0
                result = ""
                failed = False
                while line := await process.stdout.readline():
                    size += len(line)
                    if size > MAX_OUTPUT_BYTES:
                        raise ValueError("The native agent response is too large")
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if provider == "anthropic" and event.get("type") == "result":
                        failed = bool(event.get("is_error"))
                        result = event.get("result", "")
                    if provider == "openai" and event.get("type") == "item.completed":
                        item = event.get("item", {})
                        if item.get("type") == "agent_message":
                            result = item.get("text", "")
                await process.wait()
                if process.returncode != 0 or failed:
                    raise ValueError("The native provider request failed. Check sign-in, model access and usage limits")
                if provider == "openai" and response_path.exists():
                    if response_path.stat().st_size > MAX_OUTPUT_BYTES:
                        raise ValueError("The native agent response is too large")
                    result = response_path.read_text(encoding="utf-8")
                if not isinstance(result, str) or not result.strip():
                    raise ValueError("The native provider returned no build instructions")
                return result
            return await asyncio.wait_for(collect(), CLI_TURN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            raise ValueError("The native provider took too long. Retry the build") from None
        except OSError:
            raise ValueError("The native provider CLI could not start") from None
        finally:
            if process:
                await stop_process(process)
