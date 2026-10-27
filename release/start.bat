@echo off
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Error: Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit
)

echo 🚀 Starting NestOS...
echo 🌐 Opening Browser...
start http://localhost:4173

echo ⚡ Starting Server...
:: ✨ 启动 server.js
node server.js
pause
