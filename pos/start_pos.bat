@echo off
title ROOMI CAFE - Restaurant POS System
echo ============================================================
echo           ROOMI CAFE RESTAURANT POS SYSTEM
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Checking SQLite database...
if not exist "database\roomi_cafe.db" (
    echo Initializing database schema and seed data...
    python database\init_db.py
)

echo [2/3] Starting Roomi Cafe POS Server...
start "" http://localhost:5000

echo [3/3] Server running on port 5000 (PST Time).
echo Press Ctrl+C in this terminal to stop the POS system.
echo.
node backend\server.js
pause
