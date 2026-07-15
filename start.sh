#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"
PYTHON="$VENV_DIR/bin/python"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$FRONTEND_PID" 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but was not found." >&2
  exit 1
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "Creating backend virtual environment at backend/.venv..."
  python3 -m venv "$VENV_DIR"
fi

if ! "$PYTHON" -c 'import dotenv, fastapi, httpx, uvicorn' >/dev/null 2>&1; then
  echo "Installing backend dependencies into backend/.venv..."
  "$PYTHON" -m pip install -r "$BACKEND_DIR/requirements.txt"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found." >&2
  exit 1
fi

if [[ ! -x "$FRONTEND_DIR/node_modules/.bin/vite" ]]; then
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm ci)
fi

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  echo "Warning: backend/.env is missing; token requests will fail until REACTOR_API_KEY is configured." >&2
fi

echo "Starting FastAPI at http://127.0.0.1:8000"
"$PYTHON" -m uvicorn backend.app.main:app --reload --port 8000 &
BACKEND_PID=$!

echo "Starting Vite at http://127.0.0.1:5173"
(cd "$FRONTEND_DIR" && npm run dev -- --host 127.0.0.1 --port 5173) &
FRONTEND_PID=$!

echo "Living Worlds is running. Press Ctrl+C to stop both services."
wait -n "$BACKEND_PID" "$FRONTEND_PID"

