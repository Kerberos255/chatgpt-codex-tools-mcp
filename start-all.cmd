@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

echo Starting ChatGPT Codex Tools MCP...
echo.

if exist ".\start-mcp.local.cmd" (
  start "Codex MCP Server" cmd /k call ".\start-mcp.local.cmd"
) else (
  echo start-mcp.local.cmd was not found. Using start-mcp.cmd.
  start "Codex MCP Server" cmd /k call ".\start-mcp.cmd"
)

timeout /t 3 /nobreak >nul

if exist ".\start-tunnel.local.cmd" (
  start "OpenAI MCP Tunnel" cmd /k call ".\start-tunnel.local.cmd"
) else (
  echo.
  echo start-tunnel.local.cmd was not found.
  echo Run the initializer first:
  echo powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 -AllowedRoots "D:\Projects" -OpenTunnelDownloadPages
  echo.
)

echo Done. Keep the opened windows running.
pause
