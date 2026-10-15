@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================
echo   TESTE DO BOT DISCORD
echo ============================================
echo.

if not exist ".env" (
  echo [ERRO] arquivo .env nao existe.
  echo Crie um com base no .env.example e preencha DISCORD_TOKEN.
  echo.
  pause
  exit /b 1
)

node TESTAR-BOT.js
echo.
pause
