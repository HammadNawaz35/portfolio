#!/usr/bin/env bash
# Startup script for ROOMI CAFE POS System
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "============================================================"
echo "          ROOMI CAFE RESTAURANT POS SYSTEM"
echo "============================================================"

if [ ! -f "database/roomi_cafe.db" ]; then
    echo "[1/3] Initializing SQLite database and sample menu..."
    python3 database/init_db.py
else
    echo "[1/3] SQLite database ready."
fi

echo "[2/3] Starting Roomi Cafe POS server on port 5000..."
echo "[3/3] Open http://localhost:5000 in your browser."
echo "Press Ctrl+C to stop."

node backend/server.js
