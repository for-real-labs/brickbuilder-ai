#!/bin/bash

# Start virtual display in background
Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &

# Wait a moment for Xvfb to start
sleep 2

# Set display environment variable
export DISPLAY=:99

# Trust Railway's overwritten X-Real-IP only on its public HTTP ingress.
# Do not expose this listener through a public TCP proxy in Railway mode.
if [ -n "${RAILWAY_ENVIRONMENT_ID:-}" ]; then
    export GUEST_IP_SOURCE="${GUEST_IP_SOURCE:-railway}"
fi

# Use uv run to automatically use the virtual environment
exec uv run uvicorn src.api:app --no-proxy-headers --host 0.0.0.0 --port ${PORT:-8000}
