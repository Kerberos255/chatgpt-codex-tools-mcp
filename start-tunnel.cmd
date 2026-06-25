@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo Failed to enter project directory.
  pause
  exit /b 1
)

if exist ".\start-tunnel.local.cmd" (
  call ".\start-tunnel.local.cmd"
) else (
  echo start-tunnel.local.cmd was not found.
  echo.
  echo Run the initializer first:
  echo init-windows.cmd
  echo.
  echo The initializer creates start-tunnel.local.cmd and start-tunnel.local.ps1 for your machine.
  pause
  exit /b 1
)

pause
