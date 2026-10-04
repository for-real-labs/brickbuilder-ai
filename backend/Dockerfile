# Minimal Dockerfile for Railway deployment
FROM python:3.11-slim

# Install system dependencies for Open3D
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libx11-6 \
        libgomp1 \
        xvfb \
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

# Download and install LDraw library during build (avoids runtime download issues)
RUN mkdir -p /root/ldraw && \
    curl -A "Mozilla/5.0 (compatible; BrickAI/1.0)" -L \
    "https://library.ldraw.org/library/updates/complete.zip" -o /tmp/ldraw.zip && \
    unzip /tmp/ldraw.zip -d /root/ && \
    rm /tmp/ldraw.zip && \
    echo "✅ LDraw library installed at /root/ldraw"

# Copy project files (README.md is required for package build)
COPY . .

# Install Python dependencies
RUN uv sync --frozen

# Nova runs in its own pinned upstream container, reached via NOVA_SERVICE_URL.
# The API image only needs the parts library to package imported MPDs.
ENV LDRAW_DIR=/root/ldraw

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
