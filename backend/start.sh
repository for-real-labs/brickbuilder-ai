#!/bin/bash

# Serve with the baked-in runtime while a compatible update validates.
node "$(dirname "$0")/scripts/nova-runtime.cjs" auto &

# Start virtual display in background
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &

# Wait a moment for Xvfb to start
sleep 2

# Set display environment variable
export DISPLAY=:99

# Use uv run to automatically use the virtual environment
exec uv run uvicorn src.api:app --host 0.0.0.0 --port ${PORT:-8000}
