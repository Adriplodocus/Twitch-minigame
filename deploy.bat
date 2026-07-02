@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo Pushing to origin/main...
git push origin main
if errorlevel 1 (
  echo git push failed.
  pause
  exit /b 1
)

echo Building and deploying...
call npm run deploy
if errorlevel 1 (
  echo Deploy failed.
  pause
  exit /b 1
)

echo Done.
pause
