@echo off
rem Abre a tela da urna em tela cheia (modo quiosque), sem barra de endereco.
rem Uso:  iniciar-urna-tela-cheia.bat                     (servidor neste mesmo computador)
rem       iniciar-urna-tela-cheia.bat 192.168.0.10:3000   (servidor em outro computador)
rem Para sair do modo quiosque: Alt + F4

set "HOST=%~1"
if "%HOST%"=="" set "HOST=localhost:3000"
set "URL=http://%HOST%/urna"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" goto abrir
set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" goto abrir
set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" goto abrir

start "" msedge --kiosk "%URL%" --edge-kiosk-type=fullscreen
exit /b

:abrir
start "" "%CHROME%" --kiosk "%URL%"
exit /b
