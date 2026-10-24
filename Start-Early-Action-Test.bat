@echo off
setlocal
cd /d "%~dp0"
if not "%~1"=="" goto explicit_arguments
echo Aemeath early-action experiment - maximum 14 model responses.
echo [1] Direct connection
echo [2] Existing local HTTP proxy at 127.0.0.1:7890
choice /c 12 /n /m "Connection mode (1 or 2): "
if errorlevel 2 goto local_proxy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\early-action\Start-EarlyAction.ps1"
goto finished
:local_proxy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\early-action\Start-EarlyAction.ps1" -UseLocalProxy
goto finished
:explicit_arguments
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\early-action\Start-EarlyAction.ps1" %*
:finished
if errorlevel 1 (
  echo.
  echo Test launcher stopped. Keep this window and send the error to Codex.
  pause
)
endlocal
