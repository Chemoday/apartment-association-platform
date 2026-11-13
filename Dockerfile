# --- Client (frontend/, synced from the frontend repository; docs/FRONTEND_GIT_WORKFLOW.md) ---
# Without an app in frontend/ the stage yields an empty dist and the backend stays API only.
FROM oven/bun:1.4.2-slim AS frontend
WORKDIR /frontend
COPY frontend/ ./
RUN if [ -f package.json ]; then bun install --frozen-lockfile && bun run build; \
    else mkdir -p dist; fi

# --- Backend ---
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first, so code changes do not invalidate this layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini entrypoint.sh ./
COPY alembic ./alembic
COPY src ./src
COPY --from=frontend /frontend/dist ./frontend/dist

# /data/files: uploaded files (epic E11). A named volume mounted there takes this owner; on the
# VPS it is a host directory owned by uid 1000 (deploy/bootstrap.sh).
RUN useradd --system --uid 1000 --no-create-home app \
    && chmod +x entrypoint.sh \
    && install -d -o app -g app -m 700 /data/files
USER app

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
