@echo off
cd /d "%~dp0"
title POS Printer Connector
echo Starting POS Printer Connector...
node connector.js
pause

