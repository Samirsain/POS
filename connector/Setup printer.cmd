@echo off
rem Sets this PC up to print over the USB cable. Needs admin, because adding a
rem printer and moving a port both do - so it asks for it rather than failing
rem halfway with an error nobody can act on.
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%HERE%setup-printer.ps1\"'"
