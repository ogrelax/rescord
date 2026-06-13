@echo off
echo.
echo [1/3] Running QA...
call node scripts\verify.js
if errorlevel 1 (
  echo QA FAILED - aborting.
  pause
  exit /b 1
)

echo.
echo [2/3] Pushing to GitHub...
git add -A
git diff --cached --quiet && (echo Nothing new to commit.) || git commit -m "update: sync app changes"
git push --force origin HEAD:master

echo.
echo [3/3] Building .exe...
call npm run build -- --win portable

echo.
echo Done! Railway is redeploying and .exe is in dist/
pause
