"""Local developer connections. Provider credentials never leave the backend.

Native subscription sign-ins remain in the official CLIs' credential stores.
Only actual API keys are attached to this project's ignored backend/.env.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import shutil
import signal
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException, Request


@dataclass(frozen=True)
class Provider:
    label: str
    executable: str
    env_key: str
    install_hint: str
    auth_hosts: frozenset[str]


PROVIDERS = {
    "openai": Provider("ChatGPT / OpenAI", "codex", "OPENAI_API_KEY",
                       "npm install -g @openai/codex",
                       frozenset({"auth.openai.com", "chatgpt.com"})),
    "anthropic": Provider("Claude / Anthropic", "claude", "ANTHROPIC_API_KEY",
                          "npm install -g @anthropic-ai/claude-code",
                          frozenset({"claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"})),
    "fal": Provider("fal.ai", "fal", "FAL_KEY", "uv tool install fal",
                    frozenset({"fal.ai", "auth.fal.ai"})),
}
PROJECT_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
_env_lock = threading.Lock()
_ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def local_providers_enabled() -> bool:
    return os.getenv("BRICKBUILDER_LOCAL_PROVIDERS", "").lower() == "true"


def _loopback(host: str | None) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def _loopback_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        # Accessing .port validates malformed ports as well.
        _ = parsed.port
        return (parsed.scheme in {"http", "https"} and _loopback(parsed.hostname)
                and not parsed.username and not parsed.password and not parsed.query
                and not parsed.fragment and parsed.path in {"", "/"})
    except ValueError:
        return False


def require_local_development(request: Request) -> None:
    """Do not trust proxy headers: only the TCP peer and browser origin count."""
    if not local_providers_enabled():
        raise HTTPException(status_code=404, detail="Local provider connections are disabled")
    host = request.headers.get("host", "")
    origin = request.headers.get("origin")
    if (not request.client or not _loopback(request.client.host)
            or not _loopback_url(f"http://{host}")
            or (origin is not None and not _loopback_url(origin))):
        raise HTTPException(status_code=403, detail="Provider connections require a local browser and backend")


def provider_config(provider: str) -> Provider:
    if provider not in PROVIDERS:
        raise ValueError("Unknown provider")
    return PROVIDERS[provider]


def native_cli_environment() -> dict[str, str]:
    """Reuse native credential stores, excluding application API secrets."""
    keys = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR",
            "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
            "FAL_HOME_DIR", "FAL_CONFIG_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR")
    environment = {key: os.environ[key] for key in keys if key in os.environ}
    environment.update(TERM="dumb", NO_COLOR="1", PYTHONUNBUFFERED="1", DISABLE_AUTOUPDATER="1",
                       FAL_FORCE_AUTH_BY_USER="1", COLUMNS="4096")
    return environment


def attach_api_key(provider: str, api_key: str | None) -> None:
    """Atomically write a private dotenv file and refresh the running process."""
    config = provider_config(provider)
    if api_key is not None:
        api_key = api_key.strip()
        if not re.fullmatch(r"[A-Za-z0-9._:/+=-]{8,4096}", api_key):
            raise ValueError("Enter a valid API key without spaces or line breaks")
        if provider == "fal" and ":" not in api_key:
            raise ValueError("A fal API key must contain its key ID and secret separated by a colon")
    path = PROJECT_ENV_PATH
    with _env_lock:
        if path.is_symlink():
            raise ValueError("The project's .env must be a regular file")
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        key_pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(config.env_key)}\s*=")
        lines = [line for line in current.splitlines() if not key_pattern.match(line)]
        if api_key is not None:
            lines.append(f"{config.env_key}='{api_key}'")
        descriptor, temporary_name = tempfile.mkstemp(prefix=".provider-env-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write("\n".join(lines) + ("\n" if lines else ""))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, path)
        finally:
            Path(temporary_name).unlink(missing_ok=True)
        if api_key is None:
            os.environ.pop(config.env_key, None)
        else:
            os.environ[config.env_key] = api_key


async def stop_process(process: asyncio.subprocess.Process) -> None:
    """Cancel the entire private process group, including CLI helper children."""
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), 3)
    except asyncio.TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


async def _command_output(command: list[str], *, timeout: int = 15) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *command, env=native_cli_environment(), stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        umask=0o077,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
        return process.returncode, output.decode("utf-8", errors="replace")
    finally:
        await stop_process(process)


_connection_cache: dict[str, tuple[float, bool]] = {}


async def cli_connected(provider: str, *, refresh: bool = False) -> bool:
    config = provider_config(provider)
    executable = shutil.which(config.executable)
    if not executable:
        return False
    cached = _connection_cache.get(provider)
    if not refresh and cached and time.monotonic() - cached[0] < 8:
        return cached[1]
    command = [executable, "login", "status"] if provider == "openai" else (
        [executable, "auth", "status", "--json"] if provider == "anthropic" else [executable, "auth", "whoami"])
    try:
        code, output = await _command_output(command)
        if provider == "openai":
            connected = code == 0 and "logged in using chatgpt" in output.lower()
        elif provider == "anthropic":
            data = json.loads(output)
            connected = (code == 0 and isinstance(data, dict) and data.get("loggedIn") is True
                         and data.get("authMethod") not in {"api_key", "apiKey", "none"})
        else:
            connected = code == 0
    except (OSError, ValueError, asyncio.TimeoutError):
        connected = False
    _connection_cache[provider] = (time.monotonic(), connected)
    return connected


def login_url(provider: str, output: str) -> str | None:
    config = provider_config(provider)
    clean = _ansi.sub("", output)
    # A read can stop halfway through a URL. Publish it only once the CLI has
    # emitted a delimiter; a wide console prevents Rich from wrapping fal URLs.
    for url in re.findall(r"https://[^\s<>\"\x1b]+(?=[\s<>\"\x1b])", clean):
        url = url.rstrip(".,)'\r")
        parsed = urlsplit(url)
        if parsed.hostname in config.auth_hosts and not parsed.username and not parsed.password:
            return url
    return None


@dataclass
class LoginSession:
    status: str = "starting"
    url: str | None = None
    code: str | None = None
    message: str | None = None
    expires_at: float = field(default_factory=lambda: time.time() + 900)
    task: asyncio.Task | None = field(default=None, repr=False)
    process: asyncio.subprocess.Process | None = field(default=None, repr=False)

    def public(self) -> dict:
        values = {"status": self.status, "url": self.url, "code": self.code,
                  "message": self.message, "expires_at": self.expires_at}
        return {key: value for key, value in values.items() if value is not None}


class LocalProviderConnections:
    def __init__(self) -> None:
        self.sessions: dict[str, LoginSession] = {}
        self.locks: dict[str, asyncio.Lock] = {}

    async def status(self, provider: str) -> dict:
        config = provider_config(provider)
        available = bool(shutil.which(config.executable))
        session = self.sessions.get(provider)
        pending = session and session.status in {"starting", "pending"}
        connected = await cli_connected(provider) if not pending else False
        login = session.public() if session else {"status": "connected" if connected else "disconnected"}
        if session and session.status == "connected" and not connected:
            login = {"status": "disconnected", "message": "The CLI session is no longer connected. Sign in again."}
        elif session and session.status in {"error", "expired"} and connected and provider != "fal":
            # A terminal/browser can finish sign-in after this server's runner
            # exits. Prefer the official CLI's current state over stale errors.
            login = {"status": "connected"}
        return {"id": provider, "label": config.label,
                "api_key_configured": bool(os.getenv(config.env_key)), "cli_available": available,
                "cli_connected": connected, "login": login,
                "capabilities": ["api_key", "browser_login"], "install_hint": config.install_hint}

    async def start(self, provider: str, *, restart: bool = False, connection: str = "google") -> dict:
        config = provider_config(provider)
        if not shutil.which(config.executable):
            raise ValueError(f"Install the provider CLI: {config.install_hint}")
        async with self.locks.setdefault(provider, asyncio.Lock()):
            session = self.sessions.get(provider)
            if session and session.status in {"starting", "pending"} and not restart:
                return await self.status(provider)
            await self.cancel(provider)
            if provider != "fal" and not restart and await cli_connected(provider, refresh=True):
                return await self.status(provider)
            session = LoginSession()
            self.sessions[provider] = session
            session.task = asyncio.create_task(self._login(provider, session, connection))
            return await self.status(provider)

    async def cancel(self, provider: str) -> None:
        provider_config(provider)
        session = self.sessions.pop(provider, None)
        if session and session.task and not session.task.done():
            session.task.cancel()
            await asyncio.gather(session.task, return_exceptions=True)

    async def shutdown(self) -> None:
        for provider in list(self.sessions):
            await self.cancel(provider)

    async def submit_code(self, provider: str, code: str) -> None:
        session = self.sessions.get(provider)
        if provider != "anthropic" or not session or session.status != "pending" or not session.process:
            raise ValueError("No Claude sign-in is awaiting a code")
        if not re.fullmatch(r"[A-Za-z0-9_#./+=-]{8,2048}", code):
            raise ValueError("Invalid authorization code")
        try:
            session.process.stdin.write((code + "\n").encode())
            await session.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            raise ValueError("Claude sign-in closed. Start a new login") from None

    async def _attach_fal_key(self) -> None:
        if os.getenv("FAL_KEY"):
            return
        code, output = await _command_output(
            [shutil.which("fal"), "keys", "create", "--scope", "API", "--desc", "BrickBuilderAI local development"],
            timeout=60,
        )
        # Rich can wrap a long key in the non-interactive CLI's console output.
        match = re.search(r"FAL_KEY=['\"]([A-Za-z0-9._:/+=\s-]+)['\"]", _ansi.sub("", output))
        if code != 0 or not match:
            raise ValueError("fal key creation failed")
        attach_api_key("fal", re.sub(r"\s+", "", match.group(1)))

    async def _login(self, provider: str, session: LoginSession, connection: str) -> None:
        process = None
        try:
            if provider == "fal" and await cli_connected(provider, refresh=True):
                await self._attach_fal_key()
            else:
                executable = shutil.which(provider_config(provider).executable)
                arguments = ["login"] if provider == "openai" else ["auth", "login"]
                if provider == "fal":
                    arguments.extend(["--connection", connection])
                process = await asyncio.create_subprocess_exec(
                    executable, *arguments, env=native_cli_environment(), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True,
                    umask=0o077,
                )
                session.process = process
                async def observe() -> None:
                    buffer = ""
                    selected_account = False
                    while chunk := await process.stdout.read(4096):
                        buffer = (buffer + chunk.decode("utf-8", errors="replace"))[-65536:]
                        if url := login_url(provider, buffer):
                            session.url = url
                            session.status = "pending"
                        if provider == "fal" and not selected_account and "Select an account by number" in buffer:
                            # fal lists the personal account first. Existing team selection is
                            # preserved when an already-authenticated session is reused above.
                            process.stdin.write(b"1\n")
                            await process.stdin.drain()
                            selected_account = True
                    await process.wait()
                await asyncio.wait_for(observe(), 900)
                if process.returncode != 0 or not await cli_connected(provider, refresh=True):
                    raise ValueError("Provider sign-in did not complete")
                if provider == "fal":
                    await self._attach_fal_key()
            session.status = "connected"
            session.url = None
            session.code = None
            session.message = "Connected. The fal API key is attached to this project." if provider == "fal" else "Connected through the official CLI. Select native sign-in for agent builds."
        except asyncio.TimeoutError:
            session.status = "expired"
            session.message = "Sign-in expired. Start a new login."
            session.url = None
        except asyncio.CancelledError:
            raise
        except Exception:
            # Provider stderr and exception messages may contain secrets.
            session.status = "error"
            session.message = "Sign-in did not complete. Retry or connect an API key."
            session.url = None
        finally:
            if process:
                await stop_process(process)


local_provider_connections = LocalProviderConnections()
