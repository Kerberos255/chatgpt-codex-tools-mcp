@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

echo Starting local MCP server only.
echo Start your tunnel client separately after the server is listening.
echo.

call ".\start-mcp.cmd"
