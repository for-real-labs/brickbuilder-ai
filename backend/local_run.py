#!/usr/bin/env python3
"""
Local development server script
"""
import sys
import os
import time
import threading
from pathlib import Path
from contextlib import contextmanager
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Add the src directory to the Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))


def configure_local_runtime(environment=None, backend_dir=None, home_dir=None):
    """Attach the isolated Nova runtime and enable loopback-only provider setup."""
    environment = os.environ if environment is None else environment
    backend_dir = Path(backend_dir or Path(__file__).parent).resolve()
    environment.setdefault("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    library = Path(home_dir or Path.home()) / "ldraw"
    if (library / "LDConfig.ldr").is_file():
        environment.setdefault("LDRAW_DIR", str(library))


def log(message: str) -> None:
    """Print a timestamped startup message that flushes immediately."""
    print(f"[startup] {message}", flush=True)


@contextmanager
def heartbeat(message: str):
    """Print a progress message every second while the wrapped block runs."""
    done = threading.Event()

    def _beat() -> None:
        seconds = 0
        while not done.wait(1):
            seconds += 1
            log(f"{message} ({seconds}s)")

    thread = threading.Thread(target=_beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join()


if __name__ == "__main__":
    configure_local_runtime()
    _start = time.perf_counter()

    log("Starting BrickBuilderAI backend...")
    log("Loading dependencies (Open3D, ML libraries, API routes)... this can take ~20s on first start")

    with heartbeat("Loading dependencies. Please wait."):
        import uvicorn

    log("Importing application (src.api)...")
    with heartbeat("Importing application. Please wait."):
        from src.api import app

    log(f"Application loaded in {time.perf_counter() - _start:.1f}s")
    log("Launching server on http://127.0.0.1:8002 ...")

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8002,
        proxy_headers=False,  # Local provider guards must see the actual TCP peer.
        reload=False,  # Disable reload to avoid subprocess issues
        log_level="info"
    )
