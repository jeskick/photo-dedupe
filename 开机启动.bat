@echo off
cd /d "%~dp0"
set NO_OPEN=1
if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" src\server.js
  exit /b %ERRORLEVEL%
)
where node >nul 2>nul
if errorlevel 1 exit /b 1
node src\server.js
