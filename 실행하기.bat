@echo off
cd /d "%~dp0"
echo Starting Antigravity Studio Video Editor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm start"
pause
