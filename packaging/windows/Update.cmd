@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update.ps1" -InstallRoot "%~dp0."
if errorlevel 1 (
    pause
    exit /b 1
)
timeout /t 3 >nul
