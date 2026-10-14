@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================
echo   BORN TO DREAM - ATUALIZACAO AUTOMATICA
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
echo [ok] Node.js encontrado:
node -v

REM 1. instala dependencias
echo.
echo [1/6] Instalando dependencias...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 echo [aviso] npm install retornou erro - seguindo mesmo assim.

REM 2. .env com as novas variaveis
echo.
echo [2/6] Verificando .env...
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [ok] .env criado a partir do .env.example
    echo      Abra o .env e preencha PANEL_PASS, ROBLOX_COOKIE etc.
  )
) else (
  echo [ok] .env ja existe - verificando chaves novas...
  findstr /b /c:"PANEL_PASS" .env >nul 2>nul || echo PANEL_PASS=>> .env
  findstr /b /c:"PANEL_PASS" .env >nul 2>nul || echo      + PANEL_PASS adicionado, preencha a senha no .env
  findstr /b /c:"LOG_LEVEL" .env >nul 2>nul || echo LOG_LEVEL=info>> .env
  findstr /b /c:"KV_PREFIX" .env >nul 2>nul || echo KV_PREFIX=btd:>> .env
)

REM 3. checagem de sintaxe
echo.
echo [3/6] Checando sintaxe...
node --check server.js
if errorlevel 1 (
  echo [ERRO] server.js com erro de sintaxe.
  pause
  exit /b 1
)
for %%f in (lib\guard.js lib\logger.js lib\store.js lib\backoff.js) do (
  node --check "%%f"
  if errorlevel 1 (
    echo [ERRO] %%f invalido.
    pause
    exit /b 1
  )
)
echo [ok] todos os arquivos JS validos.

REM 4. estrutura de pastas
echo.
echo [4/6] Criando pastas...
if not exist "data" mkdir data
if not exist "lib" mkdir lib
if not exist "public" mkdir public

REM 5. testa se o servidor sobe
echo.
echo [5/6] Testando inicializacao por 6 segundos...
set "BOOTLOG=data\boot-test.log"
if exist "%BOOTLOG%" del /q "%BOOTLOG%" >nul 2>&1
start "" /b /min cmd /c "node server.js > data\boot-test.log 2>&1"
timeout /t 6 /nobreak >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>&1
if exist "%BOOTLOG%" (
  findstr /c:"dashboard no ar" "%BOOTLOG%" >nul && echo [ok] servidor iniciou corretamente.
  findstr /c:"Error" "%BOOTLOG%" >nul && echo [aviso] veja os erros em data\boot-test.log
) else (
  echo [aviso] nao consegui testar o boot - rode npm start para ver.
)

REM 6. resumo
echo.
echo [6/6] Pronto. Resumo do que foi instalado:
echo    - login com senha PANEL_PASS no .env
echo    - rate limit por rota + cabecalhos CSP e HSTS
echo    - /healthz para monitorar uptime
echo    - exportar CSV das vendas
echo    - metas configuraveis na aba Assistente
echo    - backoff exponencial quando o Roblox recusa
echo    - persistencia externa opcional Upstash KV
echo    - logs em data\logs.jsonl
echo.
echo Para rodar:      npm start
echo Para publicar:   suba a pasta no Render e faca deploy.
echo.
pause
