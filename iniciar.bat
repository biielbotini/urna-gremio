@echo off
chcp 65001 >nul
title Urna Eletronica Escolar - Servidor
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo O Node.js nao foi encontrado neste computador.
  echo Instale a versao LTS em https://nodejs.org e execute este arquivo novamente.
  echo.
  pause
  exit /b 1
)
echo Iniciando o servidor da urna... NAO feche esta janela durante a votacao.
echo.
node server.js
echo.
echo O servidor foi encerrado.
pause
