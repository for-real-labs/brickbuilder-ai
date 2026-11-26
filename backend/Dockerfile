# Minimal Dockerfile for Railway deployment
# Python 3.12: pyldraw3, which the Fable agents' connector checks read parts with, needs it.
FROM python:3.12-slim

# Install system dependencies for Open3D
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libx11-6 \
        libgomp1 \
        xvfb \
        leocad \
        libgl1-mesa-dri \
        curl \
        unzip \
        git \
        nodejs \
        && rm -rf /var/lib/apt/lists/* \
        && apt-get clean

# Install uv
RUN pip install --no-cache-dir uv

# jev-rerank ranks the descriptions of Fable's example builds against a request
# (fable_agent/examples/retrieval.py). https://github.com/anteloc/jev-rerank (AGPL-3.0): a pinned release whose
# archive is checksum-verified, installed as its own tool with its own locked dependencies. It needs
# TYPESAFE_API_KEY when it runs; without the key or the command, examples are ranked by keywords instead.
ARG JEV_RERANK_VERSION=0.5.0
ARG JEV_RERANK_SHA256=7a2bc86b68779e5f835026df708f4c7f38e2364f9d17bee58ff7f2c17e04f03a
RUN set -eux; \
    curl -fsSL "https://github.com/anteloc/jev-rerank/releases/download/v${JEV_RERANK_VERSION}/jev-rerank-${JEV_RERANK_VERSION}-source.zip" -o /tmp/jev-rerank.zip; \
    echo "${JEV_RERANK_SHA256}  /tmp/jev-rerank.zip" | sha256sum -c -; \
    unzip -q /tmp/jev-rerank.zip -d /tmp/jev-rerank; \
    cd "/tmp/jev-rerank/jev-rerank-${JEV_RERANK_VERSION}"; \
    uv export --frozen --no-dev --no-emit-project --no-hashes --output-file /tmp/jev-rerank-locked.txt; \
    UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --constraints /tmp/jev-rerank-locked.txt .; \
    rm -rf /tmp/jev-rerank /tmp/jev-rerank.zip /tmp/jev-rerank-locked.txt; \
    jev-rerank --help > /dev/null

# Set working directory
WORKDIR /app

# Download and install LDraw library during build (avoids runtime download issues).
# It lives in /opt so the unprivileged account below can read it; /root/ldraw still points to it.
RUN curl -A "Mozilla/5.0 (compatible; BrickAI/1.0)" -L \
    "https://library.ldraw.org/library/updates/complete.zip" -o /tmp/ldraw.zip && \
    unzip -q /tmp/ldraw.zip -d /opt/ && \
    rm /tmp/ldraw.zip && \
    ln -s /opt/ldraw /root/ldraw && \
    echo "✅ LDraw library installed at /opt/ldraw (linked from /root/ldraw)"

# Fable runs build scripts written by the model. They run as this account, which owns nothing,
# has no login and cannot read the API's environment. The shape cache is written by the API and
# only read by that account.
RUN useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin fable-sandbox && \
    mkdir -p /var/cache/brickbuilder-fable
ENV FABLE_SANDBOX_USER=fable-sandbox
ENV FABLE_AGENT_CACHE=/var/cache/brickbuilder-fable

# Copy project files (README.md is required for package build)
COPY . .

# Install Python dependencies
RUN uv sync --frozen

# Nova runs in its own pinned upstream container, reached via NOVA_SERVICE_URL.
# Astrology renders in the API container using LeoCAD and the parts library.
ENV LDRAW_DIR=/root/ldraw
ENV APPLE_ROOT_CERTIFICATES_DIR=/app/certificates/apple

# Note: Background removal now uses fal.ai BiRefNet v2 (GPU) instead of local rembg.
# rembg is kept as a fallback dependency but the u2net model is no longer pre-downloaded.

# Set environment variables for headless operation
ENV DISPLAY=:99
ENV PYTHONPATH=/app/src
ENV OPEN3D_HEADLESS=1
ENV PYOPENGL_PLATFORM=egl
ENV PATH="/app/.venv/bin:$PATH"

# Expose port
EXPOSE $PORT

# Make start script executable and use it
RUN chmod +x start.sh
CMD ["./start.sh"]
