# Minimal Dockerfile for Railway deployment
FROM python:3.11-slim

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
