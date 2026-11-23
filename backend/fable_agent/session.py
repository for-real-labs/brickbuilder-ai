"""Durable state of one build: the frozen prompt, an append-only transcript and files.

A session can be resumed for a follow-up edit. The system prompt and tool list are
stored with it and reused verbatim, and messages are only ever appended, because the
model's earlier reasoning is valid only against the history that produced it.
"""

from __future__ import annotations

import base64
import copy
import json
import os
import re
import time
import uuid
from pathlib import Path

SESSION_FILE = "session.json"
TRANSCRIPT_FILE = "transcript.json"
SCRIPT_FILE = "build.py"
MODEL_FILE = "model.ldr"
_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


class SessionError(ValueError):
    pass


def _write_atomic(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


class Session:
    def __init__(self, directory: Path, meta: dict, messages: list[dict]):
        self.directory = directory
        self.meta = meta
        self.messages = messages
        self._inflated: dict[str, dict] = {}

    # ----- lifecycle -----------------------------------------------------

    @classmethod
    def create(cls, directory: Path | str, *, system: str, tools: list[dict], model: str, settings: dict) -> Session:
        directory = Path(directory)
        if (directory / SESSION_FILE).exists():
            raise SessionError(f"{directory} already holds a session; use edit to continue it")
        directory.mkdir(parents=True, exist_ok=True)
        meta = {
            "id": str(uuid.uuid4()), "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "model": model, "system": system, "tools": tools, "settings": settings,
            "revision": 0, "built": None, "rendered_revision": None, "published": [], "usage": [],
            "status": "new",
        }
        session = cls(directory, meta, [])
        session.save()
        return session

    @classmethod
    def load(cls, directory: Path | str) -> Session:
        directory = Path(directory)
        try:
            meta = json.loads((directory / SESSION_FILE).read_text(encoding="utf-8"))
            messages = json.loads((directory / TRANSCRIPT_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise SessionError(f"No resumable session in {directory}") from None
        if not isinstance(meta, dict) or not isinstance(messages, list):
            raise SessionError(f"The session in {directory} is damaged")
        return cls(directory, meta, messages)

    def save(self) -> None:
        _write_atomic(self.directory / TRANSCRIPT_FILE, json.dumps(self.messages))
        _write_atomic(self.directory / SESSION_FILE, json.dumps(self.meta, indent=1))

    # ----- transcript ----------------------------------------------------

    def append(self, role: str, content) -> None:
        self.messages.append({"role": role, "content": content})
        self.save()

    def path(self, relative: str) -> Path:
        """A file inside this session; rejects anything that would escape it."""
        target = (self.directory / relative).resolve()
        if not target.is_relative_to(self.directory.resolve()):
            raise SessionError("Path leaves the session directory")
        return target

    def image_block(self, file: Path) -> dict:
        """Reference a picture kept in the session instead of storing base64 in the transcript."""
        relative = file.resolve().relative_to(self.directory.resolve()).as_posix()
        media = _MEDIA.get(file.suffix.lower())
        if media is None:
            raise SessionError("Only PNG and JPEG pictures can be attached")
        return {"type": "image", "source": {"type": "session_file", "path": relative, "media_type": media}}

    def _inflate(self, block: dict) -> dict:
        source = block["source"]
        key = source["path"]
        if key not in self._inflated:
            data = base64.b64encode(self.path(key).read_bytes()).decode()
            self._inflated[key] = {"type": "image", "source": {
                "type": "base64", "media_type": source["media_type"], "data": data}}
        return self._inflated[key]

    def inflate(self, value):
        """Content as the API expects it, with file references replaced by the pictures themselves."""
        if isinstance(value, dict):
            if value.get("type") == "image" and value.get("source", {}).get("type") == "session_file":
                return self._inflate(value)
            return {key: self.inflate(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.inflate(item) for item in value]
        return value

    def api_messages(self) -> list[dict]:
        """The transcript as the API expects it. Files are read as-is, so bytes stay stable."""
        return self.inflate(copy.deepcopy(self.messages))

    # ----- files ---------------------------------------------------------

    def unique_file(self, folder: str, stem: str, suffix: str) -> Path:
        """Pictures are never overwritten: a transcript entry must always read the same bytes."""
        safe = re.sub(r"[^a-z0-9-]", "-", stem.lower())[:40] or "file"
        target_dir = self.path(folder)
        target_dir.mkdir(parents=True, exist_ok=True)
        count = len(list(target_dir.glob("*")))
        while True:
            count += 1
            candidate = target_dir / f"{count:03d}-{safe}{suffix}"
            if not candidate.exists():
                return candidate

    @property
    def script(self) -> str:
        file = self.directory / SCRIPT_FILE
        return file.read_text(encoding="utf-8") if file.is_file() else ""

    def write_script(self, code: str) -> int:
        self.meta["revision"] += 1
        revision = self.meta["revision"]
        _write_atomic(self.directory / SCRIPT_FILE, code)
        history = self.path("scripts")
        history.mkdir(exist_ok=True)
        (history / f"{revision:03d}.py").write_text(code, encoding="utf-8")
        return revision
