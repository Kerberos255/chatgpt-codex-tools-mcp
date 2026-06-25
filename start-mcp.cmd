@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-mcp.ps1"

pause
