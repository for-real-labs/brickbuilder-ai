# Two-pass LEGO preview experiment

This standalone local agent creates an editable LDraw preview from a reference image or recolors a flattened physical LDraw model. It uses GPT-6.2 Astra or Claude Fable 5.2 for a design and a single critique. The compiler packs supplier-listed plates and bricks, builds sloped roofs, and supports explicit specialty parts. A failed revision preserves a valid first draft.

From the backend directory, with its Python dependencies installed, supply the selected provider's API key, a local LDraw library in `LDRAW_DIR`, and LeoCAD on PATH or in the standard macOS Applications directory. Set `LDRAW_NOVA_TOOLKIT_DIR` to a configured checkout of the toolkit version pinned in `backend/nova-service/Dockerfile`, or put its `ldraw-agent` launcher on PATH.

Before design, the agent picks up to four supplier-listed parts from explicit IDs, words in the brief and common building elements. Recolors use the most frequent source parts. It reads each part using Nova’s local `ldraw-agent part` command. The model receives physical bounds, connector types, positions, orientations and metadata coverage. The critique prioritizes specialty pieces in the draft and then the pieces actually placed by the compiler. Repeated lookups reuse the same measurement within a run. Lookup adds local processing and prompt tokens to the existing two model calls. Connector samples describe individual parts. Assembly-level fit still requires verification.

```sh
python -m experiments.two_pass fable reference.jpg ./preview-run "Build this house with fewer than 600 pieces" --max-parts 599
python -m experiments.two_pass astra source.ldr ./edit-run "Recolor the central black bricks to match the face" --source-color 0
```

The output directory stores the accepted preview stage in `result.json`, the editable MPD, both camera views, provider usage records and the generated plan. A result can be an unverified draft. The production publication checker was run separately on exact final files for the experiment. Use the existing Nova publication pipeline for customer fulfillment.

Each run budgets $0.30 of provider charges under the tested standard short-context rates. It counts the request first, reserves a margin and caps output tokens. There are no transport retries. Reusing a run directory is blocked because an interrupted response can still incur a charge. Images are resized for the provider. The source edit path accepts physical placements in the root and skips embedded library definitions.

Run the offline tests from the repository root with `PYTHONPATH=backend python -m pytest backend/tests/test_two_pass*.py`.
