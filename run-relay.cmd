@echo off
REM ---------------------------------------------------------------
REM  AnyModelBot white-label launcher
REM  1. Replace the four values below with your own relay endpoints.
REM  2. Double-click this file to start.
REM  Do NOT commit real keys here; API keys go in the app UI.
REM ---------------------------------------------------------------

set AMB_RELAY_GLOBAL=https://api.your-domain.com/v1
set AMB_RELAY_CN=https://api.your-domain.com/v1
set AMB_RELAY_WEB=https://your-domain.com
set AMB_RELAY_UTM=yourbrand

cd /d "%~dp0"
call npm start
