@echo off
echo Removing stale git lock...
del /f ".git\index.lock" 2>nul

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
