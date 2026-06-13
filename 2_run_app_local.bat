@echo off
title Rescord
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies first...
  call npm install
)
npm run app
