@echo off
title RUMI Welfare Cafe & Restaurant KRL - POS Desktop Application
echo Starting RUMI Welfare Cafe & Restaurant KRL POS Desktop App...
set APP_HTML="%~dp0public\index.html"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=%APP_HTML% --kiosk-printing --start-maximized
    exit
)
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%APP_HTML% --kiosk-printing --start-maximized
    exit
)
start "" %APP_HTML%
