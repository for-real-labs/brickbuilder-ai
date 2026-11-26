"""Command line for the Fable building agent. Run from ``backend``: ``python -m fable_agent --help``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .app import METHODS, Options, Workbench, continue_build, start_build
from .kit import to_ldraw
from .provider import DEFAULT_MODEL, ProviderError
from .render import RenderError
from .repair import BuildRepairer
from .runner import SandboxError
from .session import SessionError


def _progress(stream):
    state = {"kind": None}

    def show(kind: str, data: dict) -> None:
        if kind in ("thinking", "text"):
            if state["kind"] != kind:
                stream.write(f"\n[{'thinking' if kind == 'thinking' else 'fable'}] ")
            stream.write(data["text"])
        elif kind == "tool_call":
            arguments = data.get("input") or {}
            brief = {key: (value if not isinstance(value, str) or len(value) < 70 else f"<{len(value)} chars>")
                     for key, value in arguments.items()}
            stream.write(f"\n[tool] {data['name']} {json.dumps(brief)[:200]}")
        elif kind == "tool_result":
            first = data["text"].strip().splitlines()[0][:220] if data["text"].strip() else ""
            pictures = f" (+{len(data['images'])} image)" if data["images"] else ""
            stream.write(f"\n   -> {'ERROR ' if data['is_error'] else ''}{first}{pictures}")
        elif kind == "turn":
            stream.write(f"\n[step {data['step']}] spent ${float(data['spent_usd']):.2f}")
        elif kind == "done":
            stream.write(f"\n[done] {data['status']}: {data['reason']}\n")
        if kind != "tool":
            state["kind"] = kind
        stream.flush()

    return show


def _options(args) -> Options:
    return Options(ldraw_dir=args.ldraw_dir, catalog_path=args.catalog, open_palette=args.all_parts,
                   model=args.model, effort=args.effort, budget_usd=args.budget, max_steps=args.max_steps,
                   max_parts=args.max_parts, method=getattr(args, "method", "thorough"),
                   examples=bool(getattr(args, "examples", False)))


def _report(result, run_dir: Path) -> int:
    print(f"\nStatus: {result.status} ({result.reason}); {result.steps} model turns; "
          f"AI cost ${float(result.spent_usd):.2f}")
    if result.published:
        print(f"Model: {run_dir / result.published['path'] / 'model.ldr'}")
        print(f"Preview: {run_dir / result.published['path'] / 'preview.png'}")
        print(f"Summary: {result.published['summary']}")
    elif result.rejected:
        print(f"Nothing passed the checks. Unverified draft and its failed checks: {run_dir / result.rejected}")
    return 0 if result.status in ("published", "draft") else 1


def _run_script(args) -> int:
    """Rebuild a model from its script without any model call."""
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bench = Workbench.open({"ldraw_dir": args.ldraw_dir, "catalog_path": args.catalog,
                            "open_palette": args.all_parts, "max_parts": args.max_parts})
    outcome = bench.runner.run(Path(args.script).read_text(encoding="utf-8"))
    if outcome.build is None:
        print(f"Script failed (line {outcome.line}): {outcome.error}", file=sys.stderr)
        return 1
    build = outcome.build
    if args.repair:
        build, repairs = BuildRepairer(bench.library, bench.shapes, bench.palette, bench.finder).repair(build)
        for note in repairs.notes({c.code: c.name for c in bench.library.colors().values()}):
            print(note)
    report = bench.checker.check(build)
    (out / "model.ldr").write_text(to_ldraw(build, Path(args.script).stem), encoding="utf-8")
    (out / "report.json").write_text(json.dumps(report.to_dict(), indent=1), encoding="utf-8")
    print(report.to_text({c.code: c.name for c in bench.library.colors().values()}))
    if not args.no_render:
        views = bench.renderer.render(out / "model.ldr", out, args.views, report.bounds)
        print("Rendered: " + ", ".join(str(view.path) for view in views))
    return 0 if report.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fable_agent", description="BrickBuilder's Fable building agent")
    commands = parser.add_subparsers(dest="command", required=True)

    def common(sub, *, model_options: bool = True):
        sub.add_argument("--ldraw-dir", help="LDraw parts library (default: $LDRAW_DIR or ~/ldraw)")
        sub.add_argument("--catalog", help="Parts catalog CSV (default: the BrickBuilder supplier catalog)")
        sub.add_argument("--all-parts", action="store_true", help="Allow every LDraw part in every color")
        sub.add_argument("--max-parts", type=int, default=1500)
        if model_options:
            sub.add_argument("--model", default=DEFAULT_MODEL,
                             help="A Claude model, or an OpenAI model such as gpt-6.2-sol or gpt-6.2-astra")
            limits = "; ".join(f"{name}: {v['effort']}, ${v['budget_usd']:g}, {v['max_steps']} steps"
                               for name, v in METHODS.items())
            sub.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"],
                             help=f"Reasoning effort. Defaults by method ({limits})")
            sub.add_argument("--budget", type=float, help="AI spending limit in USD for this run")
            sub.add_argument("--max-steps", type=int, help="Most model turns (thorough) or rounds (lean)")
            sub.add_argument("--quiet", action="store_true")

    build = commands.add_parser("build", help="Build a new model from a prompt and optional reference image")
    build.add_argument("prompt")
    build.add_argument("--image", type=Path)
    build.add_argument("--out", type=Path, required=True, help="New directory for this build's session")
    build.add_argument("--method", choices=list(METHODS), default="thorough",
                       help="thorough: one long conversation, best detail. lean: a few short rounds, much cheaper. "
                            "The -v2 methods add ready-made trees and automatic repair; thorough-v2 also "
                            "has part measurements up front and batched edits")
    build.add_argument("--examples", action="store_true",
                       help="v2 methods: let the model pick a category of example scripts to read first")
    common(build)

    edit = commands.add_parser("edit", help="Continue an existing build with a change request")
    edit.add_argument("session", type=Path)
    edit.add_argument("request")
    common(edit)

    script = commands.add_parser("script", help="Rebuild, check and render a build script without the model")
    script.add_argument("script", type=Path)
    script.add_argument("--out", type=Path, required=True)
    script.add_argument("--views", nargs="+", default=["front-right", "back-left"])
    script.add_argument("--no-render", action="store_true")
    script.add_argument("--repair", action="store_true",
                        help="Apply the automatic repair first, as the -v2 methods do")
    common(script, model_options=False)

    args = parser.parse_args(argv)
    try:
        from dotenv import load_dotenv

        load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    except ImportError:
        pass
    try:
        if args.command == "script":
            return _run_script(args)
        show = None if args.quiet else _progress(sys.stderr)
        if (not 1 <= args.max_parts <= 5000 or (args.budget is not None and not 0 < args.budget <= 50)
                or (args.max_steps is not None and not 1 <= args.max_steps <= 300)):
            parser.error("Expected 1-5000 parts, a budget up to $50 and 1-300 steps")
        if args.command == "build":
            return _report(start_build(args.prompt, args.out, _options(args), reference=args.image, on_event=show),
                           args.out)
        return _report(continue_build(args.request, args.session, _options(args), on_event=show), args.session)
    except (ProviderError, SessionError, RenderError, SandboxError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
