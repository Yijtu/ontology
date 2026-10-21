@echo off
rem Double-click launcher for the Ontology Core desktop client.
rem All logic lives in start.ps1 so the window stays open on failure.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
