#!/bin/bash
# Start all CalCoach services: calendar backend and frontend.
# Usage: ./start.sh
# Stop everything: Ctrl+C

ROOT="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "Stopping all services..."
  kill 0
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "Installing analytics backend dependencies..."
pip install -q -r "$ROOT/analytics/backend/requirements.txt"

echo "Installing calendar backend dependencies..."
pip install -q -r "$ROOT/calendar/requirements.txt"

echo "Starting calendar backend on :8000..."
(cd "$ROOT/calendar" && uvicorn main:app --reload --port 8000) &

echo "Starting analytics backend on :8001..."
(cd "$ROOT/analytics/backend" && uvicorn main:app --reload --port 8001) &

echo "Starting frontend on :3000..."
(cd "$ROOT/analytics/frontend" && npm start) &

wait
