@echo off
setlocal
cd /d "%~dp0"
title Smart Board - local server

set "PYTHON=%CD%\.venv\Scripts\python.exe"
set "OLLAMA_APP=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
set "BOARD_URL=http://127.0.0.1:8018"

if not exist "%PYTHON%" (
  echo The .venv environment was not found.
  echo Run: python3 -m venv .venv
  echo Then: .venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8018 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo Smart Board is already running. Opening the browser...
  start "" "%BOARD_URL%"
  exit /b 0
)

tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if errorlevel 1 (
  if exist "%OLLAMA_APP%" (
    echo Starting local Ollama OCR...
    start "" "%OLLAMA_APP%"
    timeout /t 4 /nobreak >nul
  ) else (
    echo Ollama was not found. Starting in manual mode.
  )
)

echo Starting Smart Board: %BOARD_URL%
echo Press Ctrl+C or close this window to stop the server.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%BOARD_URL%'"
"%PYTHON%" "%CD%\app.py"

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Server stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
