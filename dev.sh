#!/usr/bin/env bash
trap 'kill 0' EXIT

(cd backend && source .venv/bin/activate && python -m src.api.server) &
(cd frontend && npm run dev) &

wait
