@echo off
cd /d "%~dp0"
if not exist "%~dp0install.ps1" (
  echo The installation files are incomplete. Right-click the Windows release ZIP and choose Extract All.
  echo Open the extracted YuE Studio folder and run Install there.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
pause
