"""Install catalog discovery and a hard publication gate around the Nova fork.

The authoritative catalog is outside the sandbox in protected provider config.
Workspace CSVs are convenient references, never the source of authorization.
"""
from __future__ import annotations

import asyncio
import json
import os
import pwd
import re
import subprocess
import tempfile
from functools import wraps
from functools import lru_cache
from pathlib import Path

from .parts_catalog import PartsCatalog, PartsUnavailable, flat_model_inventory, reject_custom_parts

CHAT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


@lru_cache(maxsize=16)
def _load_catalog(path: str, modified: int) -> PartsCatalog:
    return PartsCatalog.load(Path(path))


class ChatPartsPolicy:
    def __init__(self, config_dir: Path):
        self.root = config_dir / "parts-catalogs"

    def path(self, chat_id: str) -> Path:
        if not CHAT_ID.fullmatch(chat_id):
            raise ValueError("Invalid Nova session identity")
        return self.root / (chat_id + ".csv")

    def load(self, chat_id: str) -> PartsCatalog | None:
        path = self.path(chat_id)
        return _load_catalog(str(path), path.stat().st_mtime_ns) if path.exists() else None

    def configure(self, store, chat_id: str, content: str) -> PartsCatalog:
        catalog = PartsCatalog.from_csv(content)
        path = self.path(chat_id)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(content, encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)
        from sandbox import give_to_agent
        work = store.work_dir(chat_id)
        work.mkdir(parents=True, exist_ok=True)
        reference = work / "allowed-parts.csv"
        # A previous agent may have replaced its reference with a symlink.
        if reference.is_symlink():
            reference.unlink()
        reference.write_text(content, encoding="utf-8")
        give_to_agent(reference)
        return catalog


def expanded_inventory(source: Path, toolkit_dir: Path, ldraw_dir: Path) -> dict:
    """Let Nova resolve assemblies, inherited colors and physical parts."""
    reject_custom_parts(source.read_text(encoding='utf-8'))
    account = pwd.getpwnam(os.environ["LDRAW_NOVA_AGENT_USER"])
    with tempfile.TemporaryDirectory(prefix="nova-parts-check-") as directory:
        root = Path(directory)
        os.chown(root, 0, account.pw_gid)
        root.chmod(0o750)
        model = root / "model.mpd"
        model.write_bytes(source.read_bytes())
        model.chmod(0o644)
        output_dir = root / "output"
        output_dir.mkdir()
        os.chown(output_dir, account.pw_uid, account.pw_gid)
        output = output_dir / "physical.ldr"
        subprocess.run([str(toolkit_dir / ".venv/bin/python"), str(Path(__file__).with_name("flatten.py")),
                        str(model), str(output), str(ldraw_dir), "--instructions"],
                       cwd=toolkit_dir, user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                       env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": str(toolkit_dir),
                            "PYTHONDONTWRITEBYTECODE": "1", "HOME": str(output_dir)},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=120)
        if output.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Physical model exceeds the parts validation limit")
        return flat_model_inventory(output.read_text(encoding="utf-8"))


def install_parts_restrictions(agent, tools, settings, policy: ChatPartsPolicy):
    original_prompt, original_command = agent.system_prompt, tools.run_command

    @wraps(original_prompt)
    def system_prompt(store, chat_id):
        prompt = original_prompt(store, chat_id)
        if policy.load(chat_id) is not None:
            prompt += ("\n\nMANDATORY PARTS POLICY: Use only exact LDraw part/color pairs in the allowed catalog. "
                       "Search list_allowed_parts before choosing components and colors; output/allowed-parts.csv "
                       "is also available to generators. The catalog's color_id is an LDraw ID. "
                       "No custom geometry or custom colors. Honor max_quantity where supplied. "
                       "Check candidates with check_model_parts and repair every violation. publish_model "
                       "will refuse unavailable combinations. This policy also applies to all edits, including old models.")
        return prompt

    async def validate(ctx, source):
        catalog = policy.load(ctx.chat_id)
        if catalog is None:
            return None
        inventory = await asyncio.to_thread(expanded_inventory, source, settings.TOOLKIT_DIR, settings.LDRAW_DIR)
        catalog.validate(inventory)
        try:
            price, _ = catalog.quote(inventory)
        except PartsUnavailable:
            price = None  # A pure allowlist need not contain pricing information.
        return {"valid": True, "physical_parts": sum(inventory.values()),
                "parts_subtotal": str(price) if price is not None else None, "currency": "USD"}

    @wraps(original_command)
    async def run_command(ctx, argv, *args, **kwargs):
        # Upstream has already captured source_bytes for publication before it
        # calls validate on publication/<revision>/model.mpd. A raised ToolError
        # stops publication; exit code 1 alone would only produce a warning.
        if len(argv) >= 3 and argv[1] == "validate" and "--geometry" in argv:
            source = Path(argv[2])
            if source.parent.parent == ctx.work_dir / "publication":
                try:
                    await validate(ctx, source)
                except (ValueError, OSError, subprocess.SubprocessError):
                    raise tools.ToolError("Catalog validation blocked publication. Run check_model_parts for the "
                                          "unavailable parts, repair the model, and publish again.") from None
        return await original_command(ctx, argv, *args, **kwargs)

    async def list_allowed_parts(ctx, query: str = "", color_id: int | None = None, offset: int = 0, limit: int = 50):
        catalog = policy.load(ctx.chat_id)
        if catalog is None:
            raise tools.ToolError("No parts catalog is configured for this session")
        if len(query) > 200 or not 0 <= offset <= 100000 or not 1 <= limit <= 100:
            raise tools.ToolError("Use a query of at most 200 characters and a limit between 1 and 100")
        return tools.ToolResult(json.dumps(catalog.search(query, color_id, offset=offset, limit=limit)))

    async def check_model_parts(ctx, path: str):
        source = tools.resolve_path(ctx, path, write=True)
        if not source.is_file() or source.stat().st_size > 32 * 1024 * 1024:
            raise tools.ToolError("Choose a model file smaller than 32 MB")
        try:
            report = await validate(ctx, source)
        except ValueError as exc:
            return tools.ToolResult(json.dumps({"valid": False, "error": str(exc)}))
        if report is None:
            raise tools.ToolError("No parts catalog is configured for this session")
        return tools.ToolResult(json.dumps(report))

    additions = {
        "list_allowed_parts": (tools._fn("list_allowed_parts", "Search the authoritative allowed part/color catalog. "
            "Use before designing; IDs and colors are LDraw, unit prices are USD. Results are paginated.",
            {"query": {"type": "string"}, "color_id": {"type": "integer"},
             "offset": {"type": "integer"}, "limit": {"type": "integer"}}, []), list_allowed_parts),
        "check_model_parts": (tools._fn("check_model_parts", "Expand a candidate MPD and check all physical "
            "part/color pairs and quantities against the allowed catalog. Repair violations before publishing.",
            {"path": {"type": "string"}}, ["path"]), check_model_parts),
    }
    tools.TOOLS.update(additions)
    tools.TOOL_SCHEMAS.extend(schema for schema, _ in additions.values())
    agent.system_prompt, tools.run_command = system_prompt, run_command
