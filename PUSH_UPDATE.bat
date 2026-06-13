@echo off
echo Running QA verification...
call node scripts\verify.js
if errorlevel 1 (
  echo.
  echo QA FAILED - push aborted. Fix errors above.
  pause
  exit /b 1
)

echo Staging changes...
git add -A

echo Committing...
git diff --cached --quiet && (echo Nothing new to commit) || git commit -m "update: sync app changes (denoiser, assets, icons, etc.)"

echo Force-pushing to GitHub...
git push --force origin HEAD:master

echo.
echo Done! Railway will redeploy in ~1 min.
echo You can close this window.
pause
