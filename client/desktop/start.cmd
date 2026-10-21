@echo off
rem Double-click launcher for the Ontology Core desktop client.
rem Prefer PowerShell 7 (pwsh, UTF-8 by default), fall back to Windows PowerShell.
setlocal
set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
endlocal
