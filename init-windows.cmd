@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

echo Initializing ChatGPT Codex Tools MCP for Windows...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\init-windows.ps1" -OpenTunnelDownloadPages %*

if errorlevel 1 (
  echo.
  echo Initialization failed.
  pause
  exit /b 1
)

echo.
echo Initialization completed.
echo You can now run start-all.cmd to start the MCP server and tunnel.
pause
