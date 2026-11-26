# Pip agent builds with an existing set

All parts builds use Pip by default, including local builds and requests that omit the agent.
Selecting a set, uploading a parts list or reusing an order gives Pip the exact inventory.
Its search, build scripts, repairs and publication checks all use the supplied parts and colors.
Each part and color has a quantity limit. Owner edits reuse the saved inventory.

Previously these requests went to Nova. Pip retains its existing agent ID and standard
build limits. It can also start an edit from the saved geometry of a completed Nova build or upload.

The automated build test uses a one-brick inventory and a scripted model response. It checks
that Pip rejects a two-brick draft and publishes a revision using the available brick.
It does not measure production generation time or AI cost.

See `backend/src/requests/fableToBricks.py` and `backend/tests/test_fable_web.py`.

[Pull request #410](https://github.com/for-real-labs/brickbuilder-ai/pull/410)
