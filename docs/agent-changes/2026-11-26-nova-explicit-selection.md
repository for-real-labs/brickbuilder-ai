# Nova requires an explicit choice in Generation settings

Only signed-in users on the building-agent allowlist can select Nova. The API checks the
selection before contacting Nova. An omitted agent, an attached set, local development
and a failed Pip build all leave Nova idle. Resuming a Nova session also requires selecting Nova.

Nova keeps its existing build method and settings. Routing and access tests cover the change.
Production AI cost and build quality were not measured.

See `backend/src/requests/novaToBricks.py` and `frontend/src/pages/LandingPage.tsx`.

[Pull request #410](https://github.com/for-real-labs/brickbuilder-ai/pull/410)
