@echo off
cd /d "%~dp0"
if not exist "%~dp0portable.json" (
  echo First-time setup is needed. Run 1 - Install YuE Studio.cmd, then open this file again.
  pause
  exit /b 1
)
start "" "%~dp0desktop\YuE Studio.exe"
