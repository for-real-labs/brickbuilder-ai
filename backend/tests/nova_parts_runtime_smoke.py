"""Run inside a prepared Nova image without credentials or network access.

Exercises the real toolkit parser, tool dispatcher and publication implementation.
No LLM/provider call is made. See docs/nova-parts-catalog.md for usage.
"""
import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import agent
import tools
import settings
from sandbox import give_to_agent
from brickbuilder_integration.parts_restrictions import ChatPartsPolicy, expanded_inventory, install_parts_restrictions

CATALOG = "part_id,color_id,name,sku,unit_price,weight_kg\n3001,4,Brick 2 x 4,A,0.15,0.00219\n"
root = Path(tempfile.mkdtemp(prefix="brickwith-smoke-"))
root.chmod(0o755)
work = root / "work"
work.mkdir()
give_to_agent(work)
work.chmod(0o700)
store = SimpleNamespace(work_dir=lambda chat: work)
policy = ChatPartsPolicy(root / "config")
policy.configure(store, "smoke", CATALOG)
model = work / "model.mpd"
model.write_text("0 FILE root.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 child.ldr\n0 FILE child.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n")
inventory = expanded_inventory(model, settings.TOOLKIT_DIR, settings.LDRAW_DIR)
assert inventory == {("3001", 4): 1}, inventory
print("Real Nova hierarchical expansion and inherited color: PASS")
install_parts_restrictions(agent, tools, settings, policy)
ctx = tools.ToolContext(chat_id="smoke", store=store, emit=lambda *args: None)
valid = asyncio.run(tools.dispatch(ctx, "check_model_parts", {"path": str(model)}))
assert json.loads(valid.content)["valid"] is True, valid.content
model.write_text(model.read_text().replace("1 4 ", "1 0 "))
bad = asyncio.run(tools.dispatch(ctx, "check_model_parts", {"path": str(model)}))
assert json.loads(bad.content)["valid"] is False, bad.content
print("Real Nova tool dispatcher checks and rejects unavailable color: PASS")
result = asyncio.run(tools.dispatch(ctx, "publish_model", {"path": str(model)}))
assert "blocked publication" in result.content, result.content
assert not result.models
print("Real Nova publication blocked before storing a model: PASS")
model.write_text("0 FILE root.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 missing.ldr\n")
try:
    inventory = expanded_inventory(model, settings.TOOLKIT_DIR, settings.LDRAW_DIR)
    policy.load("smoke").validate(inventory)
except Exception as exc:
    print("Unknown dependency rejected:", type(exc).__name__)
else:
    raise AssertionError("Unknown dependencies were silently omitted: " + repr(inventory))
