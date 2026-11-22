"""Design, render and revise a real MPD from a reference or existing model."""

import json
import time
from pathlib import Path
from .engine import compile_scene, GUIDE, catalog_guide
from .provider import invoke

EDIT = """The attachment is the original model. Return JSON {"recolor":[[zeroBasedSourceIndex,newLdrawColor],...]}. The index table is grouped by current color and gives physical part centers in LDraw coordinates: X right, minus Y up, minus Z forward. Preserve every other placement."""
REVIEW = """You now see the original input then the actual draft views. Compare them and fix the largest visible discrepancy within the available budget. Return ONLY JSON: {"keep":true}, {"replace": complete plan}, or {"patch":[[zeroBasedOperationIndex,replacementRowOrNull],...],"append":[newRows...]}. Patch indices refer to your pre-patch array. For a compilation error return a corrected complete plan or patch. Preserve the most distinctive silhouette and features."""


def decode(raw):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(raw)


def revise(old, decision):
    if not isinstance(decision, dict):
        raise ValueError("Expected a revision object")
    if decision.get("keep") is True:
        return old
    if "replace" in decision:
        return decision["replace"]
    if not isinstance(old, list) or not {"patch", "append"} & decision.keys():
        raise ValueError("Expected revision")
    new = old.copy()
    for i, row in decision.get("patch", []):
        if type(i) != int or not 0 <= i < len(new):
            raise ValueError("Invalid patch index")
        new[i] = row
    return [r for r in new if r is not None] + decision.get("append", [])


def run(
    arm, brief, images, out, catalog, limit, render, source=None, index="", budget=0.30
):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    if not 0 < budget <= 0.30:
        raise ValueError("Budget must be at most $0.30")
    # Create an exclusive run marker before contacting a provider. A lost response may still be billed.
    with (out / "reservation.json").open("x") as marker:
        json.dump({"maximum_usd": budget}, marker)
    if any(out.glob("call*.json")):
        raise ValueError("Existing run already contains paid calls")
    start = time.monotonic()
    cost = 0.0
    plan = None
    views = []
    error = ""
    result = {"published": False}
    if source:
        # Surrounding part colors are especially important for requests like "match the head."
        from collections import Counter

        groups = Counter(
            (line.split()[1], int(float(line.split()[3]) // 80)) for line in source
        )
        index += (
            "\nSource palette by vertical band (color ID, floor(Y/80), count): "
            + str(sorted((int(c), h, n) for (c, h), n in groups.items()))
        )
    guide = (
        EDIT if source else GUIDE + "\n" + catalog_guide(catalog)
    ) + f" Maximum {limit} physical pieces."
    for stage in range(2):
        msg = brief + "\n" + index
        if stage:
            msg += (
                "\nPrior plan: "
                + json.dumps(plan, separators=(",", ":"))
                + "\nCompiler feedback: "
                + (error or "compiled")
            )
        answer, usage = invoke(
            arm,
            guide + ("\n" + REVIEW if stage else ""),
            msg,
            images + views,
            (budget - cost) if stage else budget * 17 / 30,
        )
        cost += usage["cost"]
        (out / f"call{stage + 1}.json").write_text(json.dumps(usage))
        (out / f"answer{stage + 1}.txt").write_text(answer)
        try:
            obj = decode(answer)
            plan = revise(plan, obj) if stage else obj
            if source:
                rows = source.copy()
                for i, col in plan["recolor"]:
                    if type(i) != int or not 0 <= i < len(rows) or type(col) != int:
                        raise ValueError("Invalid recolor")
                    row = rows[i].split()
                    if (row[-1][:-4], col) not in catalog.parts:
                        raise ValueError("Unavailable recolor")
                    row[1] = str(col)
                    rows[i] = " ".join(row)
            else:
                rows = compile_scene(plan, catalog, limit)
            if not 1 <= len(rows) <= limit:
                raise ValueError("Piece cap exceeded")
            path = out / f"stage{stage + 1}.mpd"
            path.write_text(
                "0 FILE model.ldr\n0 BrickBuilder two-pass model\n"
                + "\n".join(rows)
                + "\n0 NOFILE\n"
            )
            views = render(path, out, stage)
            result.update(
                model=path.name, pieces=len(rows), preview=views[0].name, plan=plan
            )
            error = ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            error = str(exc)[:220]
        result.update(cost=cost, seconds=time.monotonic() - start, error=error)
        (out / "result.json").write_text(json.dumps(result))
    return result
