@echo off
rem Fortuner Drive Lab — local launcher
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
start "" http://127.0.0.1:5791/
call npx vite --host 127.0.0.1 --port 5791 --strictPort
