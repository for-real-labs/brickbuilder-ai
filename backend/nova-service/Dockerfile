# Generated from the pinned Nova forks by backend/setup_nova.cjs.
FROM alpine:3.22 AS nova
RUN apk add --no-cache git && git init /source && cd /source && git remote add origin https://github.com/jjohnson5253/ldraw-nova.git && git fetch --depth 1 origin c4ba6c4913e0975ee7e34e647c26129137657d5e && git checkout --detach FETCH_HEAD

FROM alpine:3.22 AS nova_web
RUN apk add --no-cache git && git init /source && cd /source && git remote add origin https://github.com/jjohnson5253/ldraw-nova-docker.git && git fetch --depth 1 origin 65e8053e6407396f9d79b34416a9340314162832 && git checkout --detach FETCH_HEAD

# check=skip=FromPlatformFlagConstDisallowed
# ldraw-nova-docker: LeoCAD (pinned released AppImage) + Python + full LDraw parts library,
# plus a web app (chat with LLM agents that build and render LDraw models).
#
# No compiling: downloads an official, tagged LeoCAD-Linux-*.AppImage release
# and unpacks its embedded squashfs (no FUSE / --device needed), and bakes
# in the complete official LDraw parts library.
#
# Build and run (see docker-compose.yml / README.md):
#   docker compose up -d --build        # web app on http://localhost:8765
#   docker compose exec ldraw-nova-app bash # log in
#
# Pin versions explicitly:
#   docker build --build-context nova=../ldraw-nova --build-arg LEOCAD_TAG=v25.09 -t ldraw-nova-app .

# --- Stage 1: the web UI (React + Vite) --------------------------------------
# Runs on the build host's own architecture (fast, no emulation); its output is
# plain static files, so it doesn't matter that the final image is amd64.
FROM --platform=$BUILDPLATFORM node:24-slim AS frontend
WORKDIR /src
COPY --from=nova_web /source/web/frontend/package.json /source/web/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=nova_web /source/web/frontend/ ./
RUN npm run build

# Official OpenAI login runtime; no Node runtime or host credentials needed.
FROM --platform=$BUILDPLATFORM node:24-slim AS openai-login
ARG CODEX_VERSION=0.157.1
WORKDIR /opt/codex
RUN npm pack "@openai/codex@${CODEX_VERSION}-linux-x64" \
    && tar -xzf "openai-codex-${CODEX_VERSION}-linux-x64.tgz"

# --- Stage 1b: the mixed-reality viewer (web/xr: Vite + Meta's IWSDK) ---------
# Same idea, its own stage so SPA edits don't re-install its dependencies.
FROM --platform=$BUILDPLATFORM node:24-slim AS xr
WORKDIR /src
COPY --from=nova_web /source/web/xr/package.json /source/web/xr/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=nova_web /source/web/xr/ ./
RUN npm run build

# --- Stage 2: the runtime image ----------------------------------------------
# LeoCAD only publishes x86_64 Linux AppImages, so the image is always amd64.
# On Apple Silicon / arm64 hosts Docker Desktop runs it under emulation.
FROM --platform=linux/amd64 ubuntu:24.04

# Pin to a specific, released (non-continuous) LeoCAD version.
# Check https://github.com/leozide/leocad/releases for available tags.
ARG LEOCAD_TAG=v25.09

# The 3D viewer: library.ldraw.org's own source (MIT), which vendors the
# buildinginstructions.js viewer (Unlicense) it runs on. Pinned commit.
ARG LDRAWORG_REF=a38efc7aca5b1171e888687939d77b6c0b228c7f

ENV DEBIAN_FRONTEND=noninteractive

# --- Runtime deps: Xvfb/Mesa for headless GL, Qt's X11 plugin deps, Python,
# plus curl/unzip just to fetch and unpack things during the build. ----------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip squashfs-tools \
        xvfb x11-utils \
        libgl1 libglx-mesa0 libegl1 libgl1-mesa-dri libosmesa6 \
        libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 \
        libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 \
        libxcb-xinerama0 libnss3 libdbus-1-3 fontconfig \
        python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# --- Download the pinned release's AppImage and unpack it --------------------
# An AppImage is an ELF runtime with a squashfs image appended right after its
# section headers. We unpack that squashfs directly instead of running
# `./LeoCAD.AppImage --appimage-extract`: the AppImage's "AI\x02" marker in the
# ELF header padding makes emulated (e.g. Apple Silicon) builds fail with
# "Exec format error", and this way nothing is executed at build time at all.
RUN set -eux; \
    rel_json="$(curl -fsSL "https://api.github.com/repos/leozide/leocad/releases/tags/${LEOCAD_TAG}")"; \
    asset_url="$(printf '%s' "$rel_json" | grep -oP '"browser_download_url":\s*"\K[^"]*x86_64\.AppImage' | head -n1)"; \
    test -n "$asset_url"; \
    echo "Downloading: ${asset_url}"; \
    curl -fsSL "$asset_url" -o /tmp/LeoCAD.AppImage; \
    offset="$(python3 -c 'import struct,sys; h=open(sys.argv[1],"rb").read(64); shoff,=struct.unpack_from("<Q",h,0x28); shentsize,shnum=struct.unpack_from("<HH",h,0x3A); print(shoff+shentsize*shnum)' /tmp/LeoCAD.AppImage)"; \
    echo "squashfs offset: ${offset}"; \
    mkdir -p /opt/leocad; \
    unsquashfs -q -no-progress -o "$offset" -d /opt/leocad/squashfs-root /tmp/LeoCAD.AppImage; \
    rm /tmp/LeoCAD.AppImage; \
    ln -s /opt/leocad/squashfs-root/AppRun /usr/local/bin/leocad

# --- Bake in the complete official LDraw parts library ----------------------
# Produces /opt/ldraw/ldraw/{parts,p,models,LDConfig.ldr,...}
RUN mkdir -p /opt/ldraw \
    && curl -fsSL https://library.ldraw.org/library/updates/complete.zip -o /tmp/complete.zip \
    && unzip -q /tmp/complete.zip -d /opt/ldraw \
    && rm /tmp/complete.zip

# LeoCAD reads LEOCAD_LIB as its default parts-library path (equivalent to
# always passing --libpath). Any call can still override it with -l/--libpath.
ENV LEOCAD_LIB=/opt/ldraw/ldraw

# --- The 3D viewer's JavaScript, textures and licence ------------------------
# -> /opt/web/viewer-vendor/{ldbi/js,ldbi/textures,js/ldraworgscene.js,js/WebGL.js}
RUN set -eux; \
    mkdir -p /tmp/lor /opt/web/viewer-vendor/js; \
    curl -fsSL "https://codeload.github.com/ldraw-org/ldraworg-library/tar.gz/${LDRAWORG_REF}" \
        | tar -xz -C /tmp/lor --strip-components=1 --wildcards '*/public/assets/*' '*/LICENSE'; \
    cp -r /tmp/lor/public/assets/ldbi /opt/web/viewer-vendor/ldbi; \
    cp /tmp/lor/public/assets/js/ldraworgscene.js /tmp/lor/public/assets/js/WebGL.js /opt/web/viewer-vendor/js/; \
    cp /tmp/lor/LICENSE /opt/web/viewer-vendor/LICENSE-ldraworg-library.txt; \
    rm -rf /tmp/lor

# Parts index for the agent tools (find_parts: part descriptions).
# Only depends on the library above, so app edits don't rebuild it.
COPY --from=nova_web /source/web/backend/build_index.py /opt/index/build_index.py
RUN python3 /opt/index/build_index.py /opt/ldraw/ldraw /opt/index

# --- Bun runtime (for mpd2glb) -------------------------------------------------
# mpd2glb supports Node.js and Bun; measured on this image, Bun converts up to
# ~3.7x faster than Node (Deno: no faster) with byte-identical .glb output.
# The *baseline* build: the default one needs AVX2, which the emulated x86 CPU
# on Apple Silicon doesn't have. Pinned and checksum-verified.
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f
RUN set -eux; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 /tmp/bun/bun-linux-x64-baseline/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    bun --version

# --- mpd2glb: LDraw -> glTF binary (.glb), keeping LDraw metadata per node ----
# https://github.com/anteloc/mpd2glb — pinned release, checksum-verified.
# Run it through scripts/mpd2glb.sh (below), not bun + the .mjs directly:
#   mpd2glb.sh -c none -l /opt/ldraw/ldraw -o out.glb model.mpd
ARG MPD2GLB_VERSION=0.9.0
ARG MPD2GLB_SHA256=c215485927c8e629e00c7e8d0af9251b9f668e1fe39c22ab39025b786df18a3b
RUN set -eux; \
    curl -fsSL "https://github.com/anteloc/mpd2glb/releases/download/v${MPD2GLB_VERSION}/mpd2glb-${MPD2GLB_VERSION}.zip" -o /tmp/mpd2glb.zip; \
    echo "${MPD2GLB_SHA256}  /tmp/mpd2glb.zip" | sha256sum -c -; \
    unzip -q /tmp/mpd2glb.zip -d /tmp/mpd2glb; \
    mv "/tmp/mpd2glb/mpd2glb-${MPD2GLB_VERSION}" /opt/mpd2glb; \
    rm -rf /tmp/mpd2glb /tmp/mpd2glb.zip; \
    cd /opt/mpd2glb && bun install --production; \
    rm -rf /root/.bun/install/cache

# socat: the HTTPS front for headsets on the LAN (WebXR needs a secure page;
# see entrypoint.sh). Its own layer, so the big layers above stay cached.
RUN apt-get update && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

# --- Command-line tools for agents and scripts ---------------------------------
# poppler-utils (pdftotext, pdfinfo, pdftoppm, ...), ripgrep (rg), git.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ripgrep git \
    && rm -rf /var/lib/apt/lists/*

# --- uv, and Python 3.14 managed by it (jev-rerank, and tools to come) ---------
# https://github.com/astral-sh/uv — pinned release, checksum-verified. Python
# 3.14 (PYTHON_VERSION) is `python3.14`, and the Python uv picks. `python3`
# stays Ubuntu's: the app and agents' scripts run on it, with the app's packages.
# Everything uv installs is shared: under /opt/uv, commands in /usr/local/bin.
ARG UV_VERSION=0.12.19
ARG UV_SHA256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8
ARG PYTHON_VERSION=3.14.6
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN set -eux; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz; \
    echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/; \
    rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu; \
    uv python install "${PYTHON_VERSION}"; \
    uv cache clean; \
    test "$(python3.14 -c 'import platform; print(platform.python_version())')" = "${PYTHON_VERSION}"

# --- jev-rerank: ranks text files / SQLite text fields against a query ---------
# https://github.com/anteloc/jev-rerank — pinned release (its source bundle,
# checksum-verified), installed as a uv tool on Python 3.14 with the release's
# locked dependency versions. Needs TYPESAFE_API_KEY when it runs.
ARG JEV_RERANK_VERSION=0.5.0
ARG JEV_RERANK_SHA256=7a2bc86b68779e5f835026df708f4c7f38e2364f9d17bee58ff7f2c17e04f03a
RUN set -eux; \
    curl -fsSL "https://github.com/anteloc/jev-rerank/releases/download/v${JEV_RERANK_VERSION}/jev-rerank-${JEV_RERANK_VERSION}-source.zip" -o /tmp/jev-rerank.zip; \
    echo "${JEV_RERANK_SHA256}  /tmp/jev-rerank.zip" | sha256sum -c -; \
    unzip -q /tmp/jev-rerank.zip -d /tmp/jev-rerank; \
    cd "/tmp/jev-rerank/jev-rerank-${JEV_RERANK_VERSION}"; \
    uv export --frozen --no-dev --no-emit-project --no-hashes --output-file /tmp/jev-rerank-locked.txt; \
    uv tool install --python "${PYTHON_VERSION}" --constraints /tmp/jev-rerank-locked.txt .; \
    cd /; \
    rm -rf /tmp/jev-rerank /tmp/jev-rerank.zip /tmp/jev-rerank-locked.txt; \
    uv cache clean; \
    jev-rerank --help > /dev/null

# Software (llvmpipe) OpenGL rendering — works on any host, GPU or not.
ENV LIBGL_ALWAYS_SOFTWARE=1

# entrypoint.sh starts Xvfb on this display. It's set as image ENV (rather
# than only exported by the entrypoint) so shells opened with `docker exec`,
# which bypass the entrypoint, can run leocad too.
ENV DISPLAY=:99

# Qt warns on every call without a (0700) runtime dir; give it one up front.
ENV XDG_RUNTIME_DIR=/tmp/runtime-root
RUN mkdir -p -m 0700 "${XDG_RUNTIME_DIR}"

# --- Users: the server runs as root; agent-written code runs as `agent` -------
# /config holds LLM API keys: root-only, so agent code can't read them.
RUN useradd --system --create-home --shell /bin/bash agent \
    && install -d -m 0700 -o agent -g agent /tmp/runtime-agent \
    && install -d -m 0700 /config

# --- Python side of the app ---------------------------------------------------
WORKDIR /app
COPY --from=nova_web /source/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt
# The pinned Claude Agent SDK includes its matching native Claude Code runtime.
# Browser login and inference use that same binary; no host credentials mounted.
RUN python3 -c "import pathlib, subprocess, claude_agent_sdk; subprocess.run([str(pathlib.Path(claude_agent_sdk.__file__).parent / '_bundled' / 'claude'), '--version'], check=True)"
ENV PYTHONPATH=/app
# Keep the standalone builder intact. Only its distributable inputs enter the
# image: never the sibling checkout's output, virtualenv, credentials or cache.
COPY --from=nova /source/pyproject.toml /source/uv.lock /opt/ldraw-nova/
RUN cd /opt/ldraw-nova && uv sync --frozen --no-dev --no-install-project --python "${PYTHON_VERSION}"
COPY --from=nova /source/ldraw_tools/ /opt/ldraw-nova/ldraw_tools/
COPY --from=nova /source/data/ /opt/ldraw-nova/data/
COPY --from=nova /source/docs/ /opt/ldraw-nova/docs/
COPY --from=nova /source/examples/ /opt/ldraw-nova/examples/
COPY --from=nova /source/prompts/ /opt/ldraw-nova/prompts/
COPY --from=nova /source/*.md /source/*.py /source/*.sh /source/LICENSE /source/CC-BY-SA-4.0 /source/ldraw-agent /opt/ldraw-nova/
RUN cd /opt/ldraw-nova && uv sync --locked --no-dev --python "${PYTHON_VERSION}" \
    && mkdir -p .cache && chown agent:agent .cache \
    && ln -s /data/output output \
    && chmod -R a+rX /opt/ldraw-nova \
    && chmod a+x ldraw-agent setup.sh check-model.sh prepare-glb.sh \
    && uv cache clean
ENV LDRAW_DIR=/opt/ldraw/ldraw LDRAW_NOVA_TOOLKIT_DIR=/opt/ldraw-nova
COPY --from=openai-login /opt/codex/package/vendor/x86_64-unknown-linux-musl/ /opt/codex/
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex && codex --version

# --- The 3D player: ldraw-player (Rust -> WebAssembly) ------------------------
# https://github.com/anteloc/ldraw.rs-nova (tools/player), its release zip,
# checksum-verified -> /opt/web/player-vendor/{ldraw_player.js,ldraw_player_bg.wasm,...}
# For now a local build from vendor/: the v0.8.0 release doesn't start in any
# browser (its CI's old wasm-opt exported the wrong table; fixed in the fork's
# build). Once a fixed release is on GitHub, the COPY goes back to:
#   RUN curl -fsSL "https://github.com/anteloc/ldraw.rs-nova/releases/download/v${LDRAW_PLAYER_VERSION}/ldraw-player-${LDRAW_PLAYER_VERSION}.zip" -o /tmp/ldraw-player.zip
ARG LDRAW_PLAYER_VERSION=0.8.1
ARG LDRAW_PLAYER_SHA256=1c96d79764393ec702106b5da7a9131594510135704ff02cb808f1ec77a1154f
COPY --from=nova_web /source/vendor/ldraw-player-${LDRAW_PLAYER_VERSION}.zip /tmp/ldraw-player.zip
RUN set -eux; \
    echo "${LDRAW_PLAYER_SHA256}  /tmp/ldraw-player.zip" | sha256sum -c -; \
    unzip -q /tmp/ldraw-player.zip -d /tmp/ldraw-player; \
    mv "/tmp/ldraw-player/ldraw-player-${LDRAW_PLAYER_VERSION}" /opt/web/player-vendor; \
    rm -rf /tmp/ldraw-player /tmp/ldraw-player.zip; \
    test -f /opt/web/player-vendor/ldraw_player_bg.wasm

# --- scripts/: the whole folder, on everyone's PATH ----------------------------
# Whatever is in scripts/ runs from anywhere in the container, by name, for
# every user (agents too: web/backend/sandbox.py). mpd2glb.sh is the way to
# run mpd2glb.
COPY --from=nova_web /source/scripts/ /opt/scripts/
ENV PATH="/opt/scripts:${PATH}"
RUN set -eux; \
    chmod -R a+rX /opt/scripts; \
    find /opt/scripts -type f -exec chmod a+x {} +; \
    mpd2glb.sh --help > /dev/null

# --- Gallery models, with their snapshots, BOMs and notes (.md).
# Kept separate from generated models on the My Models page.
COPY --from=nova_web /source/models-gallery/ /opt/models-gallery/

COPY --from=nova_web /source/leocad_render.py /source/example.py /app/
COPY --from=nova_web /source/web/backend/ /app/web/backend/
COPY --from=nova_web /source/web/viewer/ /opt/web/viewer/
COPY --from=frontend /src/dist/ /opt/web/static/
COPY --from=xr /src/dist/ /opt/web/xr/

# --- Shared folder with the host --------------------------------------------
# /data/generated: the model collection; /data/chats: chat history;
# /data/output: agents' work folders (one per chat) and the CLI's default output.
RUN mkdir -p /data/generated /data/chats /data/output
VOLUME ["/data", "/config"]

COPY --from=nova_web /source/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8000 8443
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--app-dir", "/app/web/backend", "--host", "0.0.0.0", "--port", "8000"]

COPY backend/nova-service/ /app/web/backend/brickbuilder_integration/
RUN printf '%s' '{"toolkit":"c4ba6c4913e0975ee7e34e647c26129137657d5e","web":"65e8053e6407396f9d79b34416a9340314162832"}' > /app/web/backend/brickbuilder_integration/versions.json && chmod -R a-w /opt/ldraw-nova/ldraw_tools
CMD ["sh", "-c", "exec uvicorn brickbuilder_integration.gateway:app --app-dir /app/web/backend --host ${NOVA_BIND_HOST:-0.0.0.0} --port 8000"]
