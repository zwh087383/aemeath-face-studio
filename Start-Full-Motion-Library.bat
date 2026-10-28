@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\character-center\Start-Library-Preview.ps1" %*
endlocal
